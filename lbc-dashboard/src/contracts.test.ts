/**
 * Schema coverage for the wire contracts. One accept + one reject
 * per leaf schema, plus a round-trip that pumps a real fixture
 * through ``listCells()`` (which calls ``summarize()`` internally)
 * and parses the result through ``CellSummarySchema`` — the seam
 * where a future drift between store.ts and contracts.ts would
 * surface as a parse failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CellId,
  ConditionName,
  TargetName,
} from "../pwa/lib/ids";
import {
  AgentModelSummarySchema,
  CellDetailSchema,
  CellEventSchema,
  CellRunMetadataSchema,
  CellSummarySchema,
  CommitSnapshotSchema,
  GraderConfigDraftSchema,
  GraderSummarySchema,
  EvalScoreSchema,
  RunSummarySchema,
  RunSpecSchema,
  TabSchema,
  TaskDraftSchema,
  TaskBuiltinDetailSchema,
  TaskLocalDetailSchema,
  TaskGraderRefSchema,
  TaskSummarySchema,
  conditionName,
} from "./contracts";
import { listCells } from "./store";

describe("CellEventSchema", () => {
  test("accepts a well-formed event", () => {
    const parsed = CellEventSchema.parse({
      ts: "2026-05-22T18:00:00Z",
      kind: "proposal_picked",
      payload: { winner: "agent-a" },
    });
    expect(parsed.kind).toBe("proposal_picked");
  });

  test("rejects unknown keys (strictObject)", () => {
    expect(() =>
      CellEventSchema.parse({
        ts: "2026-05-22T18:00:00Z",
        kind: "proposal_picked",
        payload: {},
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("EvalScoreSchema", () => {
  test("accepts a numeric score", () => {
    const parsed = EvalScoreSchema.parse({
      dimension: "clarity",
      value: 0.82,
      source: "grader-v1",
    });
    expect(parsed.value).toBe(0.82);
  });

  test("rejects non-numeric value", () => {
    expect(() =>
      EvalScoreSchema.parse({
        dimension: "clarity",
        value: "high",
        source: "grader-v1",
      }),
    ).toThrow();
  });
});

describe("CellSummarySchema", () => {
  test("accepts a complete summary and brands string ids", () => {
    const parsed = CellSummarySchema.parse({
      cell_id: "20260522T180000Z:targetA:condition1",
      run_ts: "20260522T180000Z",
      target_name: "targetA",
      condition_name: "condition1",
      cell_dir: "20260522T180000Z/targetA/condition1",
      status: "active",
      last_activity_ms: 1716400000000,
      event_count: 3,
      archived: false,
      cleanable: false,
    });
    // Brand carries only at the type level; runtime is still a string.
    // The assertion here is structural — the test guards that the
    // schema doesn't drop these on parse.
    expect(parsed.cell_id).toBe(
      "20260522T180000Z:targetA:condition1" as CellId,
    );
    expect(parsed.target_name).toBe("targetA" as TargetName);
    expect(parsed.condition_name).toBe("condition1" as ConditionName);
  });

  test("rejects an unknown status enum value", () => {
    expect(() =>
      CellSummarySchema.parse({
        cell_id: "x:y:z",
        run_ts: "x",
        target_name: "y",
        condition_name: "z",
        cell_dir: "x/y/z",
        status: "running", // not in ["active", "ended"]
        last_activity_ms: 0,
        event_count: 0,
        archived: false,
        cleanable: false,
      }),
    ).toThrow();
  });
});

describe("CellDetailSchema", () => {
  test("accepts the summary shape plus detail fields", () => {
    const parsed = CellDetailSchema.parse({
      cell_id: "x:y:z",
      run_ts: "x",
      target_name: "y",
      condition_name: "z",
      cell_dir: "x/y/z",
      status: "ended",
      last_activity_ms: 1,
      event_count: 2,
      archived: false,
      cleanable: true,
      events: [
        { ts: "t", kind: "proposal_picked", payload: {} },
        { ts: "t", kind: "proposal_applied", payload: {} },
      ],
      artifact_filename: "draft.md",
      commit_count: 1,
      run_metadata: null,
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.artifact_filename).toBe("draft.md");
    expect(parsed.run_metadata).toBeNull();
  });

  test("rejects when events array is missing", () => {
    expect(() =>
      CellDetailSchema.parse({
        cell_id: "x:y:z",
        run_ts: "x",
        target_name: "y",
        condition_name: "z",
        cell_dir: "x/y/z",
        status: "ended",
        last_activity_ms: 1,
        event_count: 2,
        archived: false,
        cleanable: true,
        artifact_filename: null,
        commit_count: 0,
      }),
    ).toThrow();
  });
});

describe("AgentModelSummarySchema", () => {
  test("accepts a well-formed agent-model entry", () => {
    const parsed = AgentModelSummarySchema.parse({
      agent_id: "agent-0",
      model_id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
    });
    expect(parsed.agent_id).toBe("agent-0");
    expect(parsed.model_id).toBe("claude-sonnet-4-6");
  });

  test("accepts model_id: null (unattributed agent)", () => {
    const parsed = AgentModelSummarySchema.parse({
      agent_id: "agent-0",
      model_id: null,
      label: "agent-0",
    });
    expect(parsed.model_id).toBeNull();
  });

  test("rejects missing agent_id", () => {
    expect(() =>
      AgentModelSummarySchema.parse({ model_id: "claude-sonnet-4-6", label: "x" }),
    ).toThrow();
  });

  test("rejects empty-string agent_id, model_id, or label", () => {
    expect(() =>
      AgentModelSummarySchema.parse({ agent_id: "", model_id: "claude-sonnet-4-6", label: "x" }),
    ).toThrow();
    expect(() =>
      AgentModelSummarySchema.parse({ agent_id: "a", model_id: "", label: "x" }),
    ).toThrow();
    expect(() =>
      AgentModelSummarySchema.parse({ agent_id: "a", model_id: "claude-sonnet-4-6", label: "" }),
    ).toThrow();
  });
});

describe("CellRunMetadataSchema", () => {
  test("accepts a run_spec_derived result with non-empty pool", () => {
    const parsed = CellRunMetadataSchema.parse({
      model_pool: ["claude-sonnet-4-6", "claude-opus-4-7"],
      agents: [
        { agent_id: "agent-0", model_id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      ],
      attribution_source: "run_spec_derived",
    });
    expect(parsed.model_pool).toHaveLength(2);
    expect(parsed.attribution_source).toBe("run_spec_derived");
  });

  test("accepts a missing result with empty agents", () => {
    const parsed = CellRunMetadataSchema.parse({
      model_pool: ["claude-sonnet-4-6"],
      agents: [],
      attribution_source: "missing",
    });
    expect(parsed.agents).toHaveLength(0);
    expect(parsed.attribution_source).toBe("missing");
  });

  test("rejects empty model_pool", () => {
    expect(() =>
      CellRunMetadataSchema.parse({
        model_pool: [],
        agents: [],
        attribution_source: "run_spec_derived",
      }),
    ).toThrow();
  });

  test("rejects unknown attribution_source", () => {
    expect(() =>
      CellRunMetadataSchema.parse({
        model_pool: ["claude-sonnet-4-6"],
        agents: [],
        attribution_source: "unknown_source",
      }),
    ).toThrow();
  });

  test("rejects missing model_pool", () => {
    expect(() =>
      CellRunMetadataSchema.parse({
        agents: [],
        attribution_source: "run_spec_derived",
      }),
    ).toThrow();
  });

  test("rejects model_pool containing empty-string entries", () => {
    expect(() =>
      CellRunMetadataSchema.parse({
        model_pool: ["claude-sonnet-4-6", ""],
        agents: [],
        attribution_source: "run_spec_derived",
      }),
    ).toThrow();
  });
});

describe("CommitSnapshotSchema", () => {
  test("accepts a valid commit", () => {
    const parsed = CommitSnapshotSchema.parse({
      index: 1,
      filename: "v0001.md",
      content: "first draft",
    });
    expect(parsed.index).toBe(1);
  });

  test("rejects when index is non-numeric", () => {
    expect(() =>
      CommitSnapshotSchema.parse({
        index: "1",
        filename: "v0001.md",
        content: "first draft",
      }),
    ).toThrow();
  });
});

describe("TabSchema", () => {
  test("accepts every known tab value", () => {
    expect(TabSchema.parse("events")).toBe("events");
    expect(TabSchema.parse("artifact")).toBe("artifact");
    expect(TabSchema.parse("commits")).toBe("commits");
    expect(TabSchema.parse("scores")).toBe("scores");
    expect(TabSchema.parse("rounds")).toBe("rounds");
  });

  test("rejects an unknown tab value", () => {
    expect(() => TabSchema.parse("settings")).toThrow();
  });
});

// --- Task / grader schemas ----------------------------------------------

describe("TaskGraderRefSchema", () => {
  test("accepts the explicit none ref", () => {
    expect(TaskGraderRefSchema.parse({ kind: "none" })).toEqual({
      kind: "none",
    });
  });

  test("accepts a registered grader key", () => {
    expect(
      TaskGraderRefSchema.parse({
        kind: "registered",
        key: "code_leetcode_regex_matching",
      }),
    ).toEqual({
      kind: "registered",
      key: "code_leetcode_regex_matching",
    });
  });

  test("rejects unknown ref kinds", () => {
    expect(() =>
      TaskGraderRefSchema.parse({ kind: "custom", key: "x" }),
    ).toThrow();
  });
});

describe("TaskDraftSchema", () => {
  test("accepts a prose task draft", () => {
    const parsed = TaskDraftSchema.parse({
      name: "prose_substrate_thesis",
      artifact_type: "prose",
      artifact_filename: "draft.md",
      seed_content: "seed",
      brief: {
        target_spec: "write a concise thesis",
        success_criteria: ["covers the architecture"],
        constraints: ["keep it short"],
      },
      model_pool: ["claude-sonnet-4-5"],
      frame_pool: ["precision", null],
      grader: { kind: "registered", key: "prose_substrate_thesis" },
    });
    expect(parsed.brief.success_criteria).toHaveLength(1);
    expect(parsed.frame_pool).toEqual(["precision", null]);
  });

  test("accepts code tasks with .py filenames", () => {
    const parsed = TaskDraftSchema.parse({
      name: "code_leetcode_longest_substring",
      artifact_type: "code",
      artifact_filename: "solution.py",
      seed_content: "def f(): ...",
      brief: {
        target_spec: "implement the solution",
        success_criteria: ["passes tests"],
        constraints: [],
      },
      model_pool: ["claude-opus-4-7"],
      frame_pool: [],
      grader: { kind: "none" },
    });
    expect(parsed.artifact_filename).toBe("solution.py");
  });

  test("rejects code tasks without .py filenames", () => {
    expect(() =>
      TaskDraftSchema.parse({
        name: "code_leetcode_longest_substring",
        artifact_type: "code",
        artifact_filename: "solution.md",
        seed_content: "",
        brief: {
          target_spec: "x",
          success_criteria: ["y"],
          constraints: [],
        },
        model_pool: ["claude-opus-4-7"],
        frame_pool: [],
        grader: { kind: "none" },
      }),
    ).toThrow();
  });

  test("rejects filenames with path separators", () => {
    expect(() =>
      TaskDraftSchema.parse({
        name: "code_leetcode_longest_substring",
        artifact_type: "code",
        artifact_filename: "subdir/solution.py",
        seed_content: "",
        brief: {
          target_spec: "x",
          success_criteria: ["y"],
          constraints: [],
        },
        model_pool: ["claude-opus-4-7"],
        frame_pool: [],
        grader: { kind: "none" },
      }),
    ).toThrow();
  });

  test("rejects reserved sidecar filenames", () => {
    expect(() =>
      TaskDraftSchema.parse({
        name: "code_leetcode_longest_substring",
        artifact_type: "code",
        artifact_filename: "events.jsonl",
        seed_content: "",
        brief: {
          target_spec: "x",
          success_criteria: ["y"],
          constraints: [],
        },
        model_pool: ["claude-opus-4-7"],
        frame_pool: [],
        grader: { kind: "none" },
      }),
    ).toThrow();
  });

  test("rejects empty target_spec and empty success criteria", () => {
    expect(() =>
      TaskDraftSchema.parse({
        name: "prose_substrate_thesis",
        artifact_type: "prose",
        artifact_filename: "draft.md",
        seed_content: "",
        brief: {
          target_spec: "",
          success_criteria: [],
          constraints: [],
        },
        model_pool: ["claude-sonnet-4-5"],
        frame_pool: [],
        grader: { kind: "none" },
      }),
    ).toThrow();
  });

  test("rejects task names that are not snake_case", () => {
    expect(() =>
      TaskDraftSchema.parse({
        name: "NotSnake",
        artifact_type: "prose",
        artifact_filename: "draft.md",
        seed_content: "",
        brief: {
          target_spec: "x",
          success_criteria: ["y"],
          constraints: [],
        },
        model_pool: ["claude-sonnet-4-5"],
        frame_pool: [],
        grader: { kind: "none" },
      }),
    ).toThrow();
  });
});

describe("TaskSummarySchema", () => {
  test("accepts a local task summary", () => {
    const parsed = TaskSummarySchema.parse({
      name: "prose_substrate_thesis",
      artifact_type: "prose",
      artifact_filename: "draft.md",
      has_grader: true,
      grader_key: "prose_substrate_thesis",
      source: "local",
    });
    expect(parsed.source).toBe("local");
  });
});

describe("TaskBuiltinDetailSchema", () => {
  test("accepts a builtin task detail", () => {
    const parsed = TaskBuiltinDetailSchema.parse({
      name: "prose_substrate_thesis",
      artifact_type: "prose",
      artifact_filename: "thesis.md",
      seed_content: "",
      brief: {
        target_spec: "write a thesis",
        success_criteria: ["covers the architecture"],
        constraints: ["no marketing"],
      },
      model_pool: ["claude-sonnet-4-5"],
      frame_pool: ["precision"],
      has_grader: true,
      grader_key: "prose_substrate_thesis",
      source: "builtin",
    });
    expect(parsed.source).toBe("builtin");
  });
});

describe("TaskLocalDetailSchema", () => {
  test("accepts a local task detail", () => {
    const parsed = TaskLocalDetailSchema.parse({
      name: "dashboard_local_note",
      artifact_type: "prose",
      artifact_filename: "draft.md",
      seed_content: "# seed",
      brief: {
        target_spec: "write a note",
        success_criteria: ["covers the point"],
        constraints: [],
      },
      model_pool: ["claude-sonnet-4-5"],
      frame_pool: [],
      grader: { kind: "none" },
      has_grader: false,
      grader_key: null,
      source: "local",
    });
    expect(parsed.source).toBe("local");
  });
});

describe("GraderSummarySchema", () => {
  test("accepts a builtin grader summary", () => {
    const parsed = GraderSummarySchema.parse({
      key: "code_leetcode_longest_substring",
      label: "LeetCode #3 mechanical grader",
      supported_artifact_types: ["code"],
      capabilities: ["pytest", "mypy"],
      source: "builtin",
      config_required: false,
      config_schema: null,
    });
    expect(parsed.supported_artifact_types).toEqual(["code"]);
  });
});

describe("GraderConfigDraftSchema", () => {
  test("accepts a config draft with a snake_case task name", () => {
    const parsed = GraderConfigDraftSchema.parse({
      task_name: "prose_substrate_thesis",
      grader_key: "prose_substrate_thesis",
      config: { judge_model: "claude-sonnet-4-5" },
    });
    expect(parsed.config).toEqual({ judge_model: "claude-sonnet-4-5" });
  });

  test("rejects a task name that is not snake_case", () => {
    expect(() =>
      GraderConfigDraftSchema.parse({
        task_name: "NotSnake",
        grader_key: "prose_substrate_thesis",
        config: {},
      }),
    ).toThrow();
  });
});

// --- RunSpecSchema -------------------------------------------------------

const validRunSpec = {
  task: "prose_substrate_thesis",
  model_pool: ["claude-opus-4-7"],
  condition: { kind: "single_agent", n: 1 },
  grade: true,
};

describe("RunSpecSchema", () => {
  test("accepts single_agent with n=1", () => {
    const parsed = RunSpecSchema.parse(validRunSpec);
    expect(parsed.condition.kind).toBe("single_agent");
    expect(parsed.condition.n).toBe(1);
  });

  test("accepts ensemble_single_round with n=2", () => {
    const parsed = RunSpecSchema.parse({
      ...validRunSpec,
      condition: { kind: "ensemble_single_round", n: 2 },
    });
    expect(parsed.condition.n).toBe(2);
  });

  test("accepts ensemble_multi_round with n=3", () => {
    const parsed = RunSpecSchema.parse({
      ...validRunSpec,
      condition: { kind: "ensemble_multi_round", n: 3 },
    });
    expect(parsed.condition.n).toBe(3);
  });

  test("accepts ensemble_incremental with n=1", () => {
    const parsed = RunSpecSchema.parse({
      ...validRunSpec,
      condition: { kind: "ensemble_incremental", n: 1 },
    });
    expect(parsed.condition.n).toBe(1);
  });

  test("rejects single_agent with n=2", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "single_agent", n: 2 },
      }),
    ).toThrow();
  });

  test("rejects ensemble_multi_round with n=1", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "ensemble_multi_round", n: 1 },
      }),
    ).toThrow();
  });

  test("rejects ensemble_single_round with n=1", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "ensemble_single_round", n: 1 },
      }),
    ).toThrow();
  });

  test("rejects n=0", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "ensemble_incremental", n: 0 },
      }),
    ).toThrow();
  });

  test("rejects n=17", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "ensemble_incremental", n: 17 },
      }),
    ).toThrow();
  });

  test("rejects empty model_pool", () => {
    expect(() => RunSpecSchema.parse({ ...validRunSpec, model_pool: [] })).toThrow();
  });

  test("rejects model_pool with an empty string", () => {
    expect(() =>
      RunSpecSchema.parse({ ...validRunSpec, model_pool: [""] }),
    ).toThrow();
  });

  test("accepts safe task names", () => {
    const parsed = RunSpecSchema.parse({
      ...validRunSpec,
      task: "dashboard_local_task",
    });
    expect(parsed.task).toBe("dashboard_local_task");
  });

  test("rejects unsafe task names", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        task: "dashboard/local",
      }),
    ).toThrow();
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        task: "..",
      }),
    ).toThrow();
  });

  test("rejects unknown condition kind", () => {
    expect(() =>
      RunSpecSchema.parse({
        ...validRunSpec,
        condition: { kind: "solo", n: 1 },
      }),
    ).toThrow();
  });

  test("grade defaults to true when omitted", () => {
    const { grade: _, ...noGrade } = validRunSpec;
    const parsed = RunSpecSchema.parse(noGrade);
    expect(parsed.grade).toBe(true);
  });
});

describe("RunSummarySchema", () => {
  test("accepts a run summary with task-based fields", () => {
    const parsed = RunSummarySchema.parse({
      runId: "run-1",
      run_ts: "2026-05-22T18-00-00-000000Z",
      cell_id: "2026-05-22T18-00-00-000000Z:prose_substrate_thesis:single_agent",
      task: "prose_substrate_thesis",
      condition: { kind: "single_agent", n: 1 },
      status: "running",
      started_ms: 123,
      exit_code: null,
      stderr_tail: "",
    });
    expect(parsed.task).toBe("prose_substrate_thesis");
  });
});

// --- conditionName -------------------------------------------------------

describe("conditionName", () => {
  test("single_agent returns 'single_agent' with no suffix", () => {
    expect(conditionName("single_agent", 1)).toBe(
      "single_agent" as ConditionName,
    );
  });

  test("ensemble_multi_round/n=3 returns 'ensemble_multi_round_n3'", () => {
    expect(conditionName("ensemble_multi_round", 3)).toBe(
      "ensemble_multi_round_n3" as ConditionName,
    );
  });

  test("ensemble_single_round/n=4 returns 'ensemble_single_round_n4'", () => {
    expect(conditionName("ensemble_single_round", 4)).toBe(
      "ensemble_single_round_n4" as ConditionName,
    );
  });

  test("ensemble_incremental/n=2 returns 'ensemble_incremental_n2'", () => {
    expect(conditionName("ensemble_incremental", 2)).toBe(
      "ensemble_incremental_n2" as ConditionName,
    );
  });
});

// --- round-trip ----------------------------------------------------------
//
// Builds a real .run/ tree, runs the on-disk reader (listCells →
// summarize), and confirms the output passes CellSummarySchema.parse.
// This is the test the brief calls out: if a future store.ts change
// drifts the shape it produces, this test fails before the wire
// boundary catches it as a 500.

describe("round-trip from listCells", () => {
  let runRoot: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    runRoot = await mkdtemp(join(tmpdir(), "lbc-dashboard-contracts-test-"));
    originalEnv = process.env.LBC_RUN_ROOT;
    process.env.LBC_RUN_ROOT = runRoot;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.LBC_RUN_ROOT;
    } else {
      process.env.LBC_RUN_ROOT = originalEnv;
    }
    await rm(runRoot, { recursive: true, force: true });
  });

  test("summarize() output passes CellSummarySchema", async () => {
    const cellDir = join(runRoot, "20260522T180000Z", "targetA", "condition1");
    await mkdir(cellDir, { recursive: true });
    await writeFile(
      join(cellDir, "events.jsonl"),
      JSON.stringify({ ts: "t", kind: "proposal_picked", payload: {} }) +
        "\n" +
        JSON.stringify({ ts: "t", kind: "proposal_applied", payload: {} }) +
        "\n",
      "utf-8",
    );
    const cells = await listCells();
    expect(cells).toHaveLength(1);
    // Should not throw — and the parsed output is what we'd send on
    // the wire after server.ts's CellsResponseSchema.parse.
    const parsed = CellSummarySchema.parse(cells[0]);
    expect(parsed.target_name).toBe("targetA" as TargetName);
    expect(parsed.condition_name).toBe("condition1" as ConditionName);
  });
});
