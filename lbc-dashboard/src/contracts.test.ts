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
  CellDetailSchema,
  CellEventSchema,
  CellSummarySchema,
  CommitSnapshotSchema,
  EvalScoreSchema,
  RunSpecSchema,
  TabSchema,
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
      events: [
        { ts: "t", kind: "proposal_picked", payload: {} },
        { ts: "t", kind: "proposal_applied", payload: {} },
      ],
      artifact_filename: "draft.md",
      commit_count: 1,
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.artifact_filename).toBe("draft.md");
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
        artifact_filename: null,
        commit_count: 0,
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
  });

  test("rejects an unknown tab value", () => {
    expect(() => TabSchema.parse("settings")).toThrow();
  });
});

// --- RunSpecSchema -------------------------------------------------------

const validRunSpec = {
  target: "prose_substrate_thesis",
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
    expect(() =>
      RunSpecSchema.parse({ ...validRunSpec, model_pool: [] }),
    ).toThrow();
  });

  test("rejects model_pool with an empty string", () => {
    expect(() =>
      RunSpecSchema.parse({ ...validRunSpec, model_pool: [""] }),
    ).toThrow();
  });

  test("rejects unknown target", () => {
    expect(() =>
      RunSpecSchema.parse({ ...validRunSpec, target: "not_a_target" }),
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

// --- conditionName -------------------------------------------------------

describe("conditionName", () => {
  test("single_agent returns 'single_agent' with no suffix", () => {
    expect(conditionName("single_agent", 1)).toBe("single_agent");
  });

  test("ensemble_multi_round/n=3 returns 'ensemble_multi_round_n3'", () => {
    expect(conditionName("ensemble_multi_round", 3)).toBe(
      "ensemble_multi_round_n3",
    );
  });

  test("ensemble_single_round/n=4 returns 'ensemble_single_round_n4'", () => {
    expect(conditionName("ensemble_single_round", 4)).toBe(
      "ensemble_single_round_n4",
    );
  });

  test("ensemble_incremental/n=2 returns 'ensemble_incremental_n2'", () => {
    expect(conditionName("ensemble_incremental", 2)).toBe(
      "ensemble_incremental_n2",
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
