/**
 * Tests for the cell-store layer. Builds a fake .run/ tree under a
 * temp dir and verifies discovery + parsing.
 *
 * The Python harness's behavior is reproduced as fixtures, not
 * stubbed in code — these tests guard the on-disk contract between
 * the harness's writers and the dashboard's readers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ConditionName,
  TargetName,
} from "../pwa/lib/ids";
import type { GraderConfigDraft, GraderSummary, TaskDraft } from "./contracts";
import {
  addToArchivedCellsIndex,
  deleteGraderConfigDraft,
  deleteTaskDraft,
  getCellDetail,
  getCellSummary,
  getGraderConfigDraft,
  getTaskDraft,
  listCells,
  listGraderConfigDrafts,
  listTaskDrafts,
  listTaskSummaries,
  readEvalScores,
  readEvents,
  removeFromArchivedCellsIndex,
  resolveCellDirPath,
  STALE_MS,
  upsertGraderConfigDraft,
  upsertTaskDraft,
  validateGraderConfigDraftJson,
  validateTaskDraftJson,
} from "./store";
import { RunRegistry, type Launcher } from "./runs";
import { createApp } from "../server";

// Path-traversal rejection is enforced by parseCellId itself (via
// isSafeSegment) and tested here at the getCellDetail public boundary —
// a crafted cell_id should return null without a file lookup.

let runRoot: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  // Each test gets a fresh tmpdir-rooted .run/ tree, scoped via the
  // env var that resolveRunRoot reads on every call. No module-cache
  // gymnastics: store.ts reads the env per request.
  runRoot = await mkdtemp(join(tmpdir(), "lbc-dashboard-store-test-"));
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

async function makeCell(
  runTs: string,
  target: string,
  condition: string,
  events: string[],
  extras: { artifact?: string; commits?: number } = {},
): Promise<string> {
  const cellDir = join(runRoot, runTs, target, condition);
  await mkdir(cellDir, { recursive: true });
  await writeFile(
    join(cellDir, "events.jsonl"),
    events.join("\n") + "\n",
    "utf-8",
  );
  if (extras.artifact !== undefined) {
    await writeFile(join(cellDir, "draft.md"), extras.artifact, "utf-8");
  }
  if (extras.commits !== undefined) {
    const commitsDir = join(cellDir, "commits");
    await mkdir(commitsDir, { recursive: true });
    for (let i = 1; i <= extras.commits; i++) {
      await writeFile(
        join(commitsDir, `v${String(i).padStart(4, "0")}.md`),
        `commit ${i}`,
        "utf-8",
      );
    }
  }
  return cellDir;
}

function eventLine(kind: string, ts = "2026-05-06T18:00:00Z"): string {
  return JSON.stringify({ ts, kind, payload: {} });
}

describe("listCells", () => {
  test("discovers cells, classifies status by last-line kind", async () => {
    await makeCell("2026-05-06T17-00-00Z", "prose", "incremental_n2", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
    ]);
    await makeCell("2026-05-06T18-00-00Z", "code", "single_round_n2", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
    ]);

    const cells = await listCells();
    expect(cells.length).toBe(2);

    const ended = cells.find((c) => c.condition_name === "incremental_n2");
    const active = cells.find(
      (c) => c.condition_name === "single_round_n2",
    );
    expect(ended?.status).toBe("ended");
    expect(active?.status).toBe("active");
    expect(ended?.event_count).toBe(3);
    expect(active?.event_count).toBe(2);
  });

  test("returns empty list when run-root doesn't exist (no mkdir side-effect)", async () => {
    const ghostRoot = join(runRoot, "does-not-exist");
    process.env.LBC_RUN_ROOT = ghostRoot;
    const cells = await listCells();
    expect(cells).toEqual([]);
    // The read should NOT have created the missing directory.
    await expect(
      Bun.file(join(ghostRoot, "marker")).exists(),
    ).resolves.toBe(false);
  });

  test("classifies consensus-pick cells as ended via picked-then-applied", async () => {
    await makeCell("2026-05-06T19-00-00Z", "prose", "multi_round_n3", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
      eventLine("convergence_started"),
      eventLine("round_completed"),
      eventLine("escalation_triggered"),
      eventLine("proposal_picked"),
      eventLine("proposal_applied"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "multi_round_n3");
    expect(cell?.status).toBe("ended");
  });

  test("does NOT classify mid-incremental proposal_applied as ended", async () => {
    // Common false-positive shape: cell still running, last event
    // is one of many proposal_applied during the incremental phase.
    await makeCell("2026-05-06T20-00-00Z", "prose", "incremental_n2", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("proposal_applied"),
      eventLine("proposal_applied"),
    ]);
    const cells = await listCells();
    expect(cells[0].status).toBe("active");
  });

  test("classifies cell_failed event as failed terminal status", async () => {
    await makeCell("2026-05-06T21-30-00Z", "prose", "single_agent", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("cell_failed"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "single_agent");
    expect(cell?.status).toBe("failed");
    // failed cells with no live process are cleanable
    expect(cell?.cleanable).toBe(true);
  });

  test("classifies consensus_rejected as failed terminal status", async () => {
    await makeCell("2026-05-06T22-00-00Z", "prose", "multi_round_n3", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
      eventLine("convergence_started"),
      eventLine("round_completed"),
      eventLine("consensus_rejected"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "multi_round_n3");
    expect(cell?.status).toBe("failed");
    expect(cell?.cleanable).toBe(true);
  });

  test("classifies proposal_rejected as failed terminal status", async () => {
    await makeCell("2026-05-06T22-30-00Z", "prose", "multi_round_n2", [
      eventLine("incremental_started"),
      eventLine("convergence_started"),
      eventLine("proposal_rejected"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "multi_round_n2");
    expect(cell?.status).toBe("failed");
    expect(cell?.cleanable).toBe(true);
  });

  test("classifies cell_cancelled as cancelled terminal status", async () => {
    await makeCell("2026-05-06T22-40-00Z", "prose", "cancelled_cell", [
      eventLine("incremental_started"),
      eventLine("cell_cancelled"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "cancelled_cell");
    expect(cell?.status).toBe("cancelled");
    expect(cell?.cleanable).toBe(true);
  });

  test("classifies run_cancelled as cancelled terminal status", async () => {
    await makeCell("2026-05-06T22-50-00Z", "prose", "cancelled_run", [
      eventLine("incremental_started"),
      eventLine("run_cancelled"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "cancelled_run");
    expect(cell?.status).toBe("cancelled");
    expect(cell?.cleanable).toBe(true);
  });

  test("failed cell with live process is NOT cleanable", async () => {
    await makeCell("2026-05-06T23-00-00Z", "prose", "single_agent_live", [
      eventLine("incremental_started"),
      eventLine("cell_failed"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.condition_name === "single_agent_live");
    expect(cell?.status).toBe("failed");
    const cellId = cell!.cell_id;

    const liveCells = await listCells(new Set([cellId]));
    const liveCell = liveCells.find((c) => c.condition_name === "single_agent_live");
    expect(liveCell?.cleanable).toBe(false);
  });
});

describe("getCellDetail", () => {
  test("surfaces artifact filename + commit count without events payload", async () => {
    await makeCell(
      "2026-05-06T19-00-00Z",
      "prose_substrate_thesis",
      "ensemble_multi_round_n3",
      [eventLine("incremental_started"), eventLine("proposal_applied")],
      { artifact: "# title\n\ncontent\n", commits: 4 },
    );

    // cell_id = encodeURIComponent(seg) joined with ":"; the segments
    // here have no special chars so encoding is a no-op for the IDs
    // listCells / cellIdFor produce. The discovered cell_id from
    // listCells is the source of truth — read it from there.
    const cells = await listCells();
    const cellId = cells.find(
      (c) => c.condition_name === "ensemble_multi_round_n3",
    )?.cell_id;
    expect(cellId).toBeDefined();

    const detail = await getCellDetail(cellId!);
    expect(detail).not.toBeNull();
    expect(detail!.artifact_filename).toBe("draft.md");
    expect(detail!.commit_count).toBe(4);
    // events must not appear in the detail response
    expect("events" in detail!).toBe(false);
    // event_count in the summary fields is still accurate
    expect(detail!.event_count).toBe(2);
  });

  test("getCellDetail result has no events field even when events.jsonl is present", async () => {
    await makeCell(
      "2026-07-01T10-00-00Z",
      "prose",
      "single_agent",
      [
        eventLine("incremental_started"),
        eventLine("proposal_applied"),
        eventLine("incremental_terminated"),
      ],
    );
    const cells = await listCells();
    const cellId = cells.find((c) => c.condition_name === "single_agent")?.cell_id;
    expect(cellId).toBeDefined();

    const detail = await getCellDetail(cellId!);
    expect(detail).not.toBeNull();
    // The detail payload must not carry the events list
    expect("events" in detail!).toBe(false);
    // Summary metadata is still present and accurate
    expect(detail!.event_count).toBe(3);
    expect(detail!.status).toBe("ended");
  });

  test("getCellDetail does not reparse events.jsonl after cache is warm", async () => {
    const cellDir = await makeCell(
      "2026-07-01T10-30-00Z",
      "prose",
      "cache_only_detail",
      [eventLine("incremental_started")],
    );
    const cells = await listCells();
    const cellId = cells.find(
      (c) => c.condition_name === "cache_only_detail",
    )?.cell_id;
    expect(cellId).toBeDefined();

    const eventsPath = join(cellDir, "events.jsonl");
    await appendFile(
      eventsPath,
      eventLine("incremental_terminated", "2026-07-01T10:31:00Z") + "\n",
      "utf-8",
    );
    const future = new Date(Date.now() + 1000);
    await utimes(eventsPath, future, future);

    const detail = await getCellDetail(cellId!);
    expect(detail).not.toBeNull();
    expect(detail!.event_count).toBe(1);
    expect(detail!.status).toBe("active");
  });

  test("ignores eval_scores.json when detecting the artifact filename", async () => {
    // The artifact-detection scan walks the cell dir for the file
    // that isn't a known sidecar. eval_scores.json must be in the
    // sidecar allowlist or readdir's non-deterministic order can
    // pick it as the artifact, hiding the real one.
    const cellDir = await makeCell(
      "2026-05-06T20-30-00Z",
      "prose",
      "incremental_n2",
      [eventLine("incremental_started")],
      { artifact: "# real artifact\n", commits: 1 },
    );
    await writeFile(
      join(cellDir, "eval_scores.json"),
      JSON.stringify({
        scores: [{ dimension: "x", value: 0.5, source: "llm_judge" }],
      }),
      "utf-8",
    );
    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === "2026-05-06T20-30-00Z");
    expect(cell).toBeDefined();
    const detail = await getCellDetail(cell!.cell_id);
    expect(detail!.artifact_filename).toBe("draft.md");
  });

  test("ignores dotfiles and .tmp orphans when detecting the artifact filename", async () => {
    // The harness's atomic-rename writers leave dotfile/.tmp
    // intermediates on disk during writes; a crash mid-write can
    // orphan them. Those must not be eligible for artifact
    // resolution — readdir order would otherwise let the orphan win
    // over the real artifact.
    const cellDir = await makeCell(
      "2026-05-06T20-15-00Z",
      "prose",
      "incremental_n2",
      [eventLine("incremental_started")],
      { artifact: "# real artifact\n" },
    );
    await writeFile(
      join(cellDir, ".eval_scores.abc123.tmp"),
      "{}",
      "utf-8",
    );
    await writeFile(join(cellDir, "draft.md.tmp"), "stale", "utf-8");
    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === "2026-05-06T20-15-00Z");
    expect(cell).toBeDefined();
    const detail = await getCellDetail(cell!.cell_id);
    expect(detail!.artifact_filename).toBe("draft.md");
  });

  test("cell_id round-trips through encodeURIComponent + : delimiter", async () => {
    // Names containing the OLD ``__`` delimiter would have mis-split
    // before; the encode/decode round-trip preserves them. Also
    // covers names with `:` (encoded to %3A so they can't alias the
    // segment separator) and `/` (rejected at isSafeSegment for
    // safety even after decode).
    await makeCell(
      "2026-05-06T21-00-00Z",
      "my__custom_target",
      "weird:condition_name",
      [eventLine("incremental_started")],
    );
    const cells = await listCells();
    const cell = cells.find((c) => c.target_name === "my__custom_target");
    expect(cell).toBeDefined();
    expect(cell!.condition_name).toBe("weird:condition_name" as ConditionName);

    // The cell_id round-trips back to the same task/condition.
    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    expect(detail!.target_name).toBe("my__custom_target" as TargetName);
    expect(detail!.condition_name).toBe("weird:condition_name" as ConditionName);
  });

  test("rejects path-traversal cell_ids without touching disk", async () => {
    // Crafted cell_ids that would otherwise escape RUN_ROOT via
    // path-join. Each must return null without a file lookup, so a
    // missing-segment file outside RUN_ROOT can't accidentally
    // surface.
    //
    // Format is now segments joined with ``:``. For each crafted
    // input, parseCellId either gets the wrong number of segments
    // or one segment fails isSafeSegment after decoding.
    expect(await getCellDetail("..:..:..")).toBeNull();
    // ``%2F`` decodes to ``/`` which fails isSafeSegment.
    expect(await getCellDetail("a%2Fb:c:d")).toBeNull();
    // ``%5C`` decodes to ``\`` which fails isSafeSegment.
    expect(await getCellDetail("a:b%5Cc:d")).toBeNull();
    expect(await getCellDetail("a:.:b")).toBeNull();
    expect(await getCellDetail(":b:c")).toBeNull();
    // Wrong number of segments.
    expect(await getCellDetail("a:b")).toBeNull();
    expect(await getCellDetail("a:b:c:d")).toBeNull();
    // Malformed percent-encoding shouldn't escape decodeURIComponent.
    expect(await getCellDetail("a:%E0%A4:c")).toBeNull();
  });
});

describe("readEvalScores", () => {
  test("parses well-formed sidecar", async () => {
    const cellDir = await makeCell("2026-05-06T22-00-00Z", "p", "c", [
      eventLine("incremental_started"),
    ]);
    await writeFile(
      join(cellDir, "eval_scores.json"),
      JSON.stringify({
        scores: [
          { dimension: "clarity", value: 0.9, source: "llm_judge" },
          { dimension: "rigor", value: 0.6, source: "llm_judge" },
        ],
      }),
      "utf-8",
    );
    const scores = await readEvalScores(
      "2026-05-06T22-00-00Z:p:c",
    );
    expect(scores).not.toBeNull();
    expect(scores!.length).toBe(2);
    expect(scores![0]).toEqual({
      dimension: "clarity",
      value: 0.9,
      source: "llm_judge",
    });
  });

  test("returns null when sidecar is absent", async () => {
    await makeCell("2026-05-06T22-30-00Z", "p", "c", [
      eventLine("incremental_started"),
    ]);
    const scores = await readEvalScores(
      "2026-05-06T22-30-00Z:p:c",
    );
    expect(scores).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    const cellDir = await makeCell("2026-05-06T23-00-00Z", "p", "c", [
      eventLine("incremental_started"),
    ]);
    await writeFile(
      join(cellDir, "eval_scores.json"),
      "not json at all",
      "utf-8",
    );
    const scores = await readEvalScores(
      "2026-05-06T23-00-00Z:p:c",
    );
    expect(scores).toBeNull();
  });

  test("filters out malformed score entries, keeps the rest", async () => {
    // A row with the wrong types or missing keys shouldn't break
    // the whole list — drop the bad entry, return the good ones.
    // Same fail-soft posture as readEvents.
    const cellDir = await makeCell("2026-05-06T23-30-00Z", "p", "c", [
      eventLine("incremental_started"),
    ]);
    await writeFile(
      join(cellDir, "eval_scores.json"),
      JSON.stringify({
        scores: [
          { dimension: "good", value: 0.7, source: "llm_judge" },
          { dimension: "bad-value-type", value: "high", source: "x" },
          { dimension: "missing-source", value: 0.5 },
          "totally not an object",
          { dimension: "also-good", value: 0.4, source: "heuristic" },
        ],
      }),
      "utf-8",
    );
    const scores = await readEvalScores(
      "2026-05-06T23-30-00Z:p:c",
    );
    expect(scores).not.toBeNull();
    expect(scores!.map((s) => s.dimension)).toEqual([
      "good",
      "also-good",
    ]);
  });

  test("rejects path-traversal cell_ids", async () => {
    expect(await readEvalScores("..:..:..")).toBeNull();
    expect(await readEvalScores("a%2Fb:c:d")).toBeNull();
  });
});

describe("readEvents", () => {
  test("malformed events.jsonl lines are skipped, not raised", async () => {
    const cellDir = await makeCell("2026-05-06T20-00-00Z", "x", "y", [
      eventLine("a"),
      "not json",
      eventLine("b"),
      "",
    ]);

    const events = await readEvents(cellDir);
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("a");
    expect(events[1].kind).toBe("b");
  });
});

describe("task + grader config stores", () => {
  let dashboardDataRoot: string;
  let originalDashboardDataRoot: string | undefined;

  beforeEach(async () => {
    dashboardDataRoot = await mkdtemp(
      join(tmpdir(), "lbc-dashboard-data-test-"),
    );
    originalDashboardDataRoot = process.env.LBC_DASHBOARD_DATA_ROOT;
    process.env.LBC_DASHBOARD_DATA_ROOT = dashboardDataRoot;
  });

  afterEach(async () => {
    if (originalDashboardDataRoot === undefined) {
      delete process.env.LBC_DASHBOARD_DATA_ROOT;
    } else {
      process.env.LBC_DASHBOARD_DATA_ROOT = originalDashboardDataRoot;
    }
    await rm(dashboardDataRoot, { recursive: true, force: true });
  });

  const proseTask: TaskDraft = {
    name: "prose_substrate_thesis",
    artifact_type: "prose",
    artifact_filename: "draft.md",
    seed_content: "# seed",
    brief: {
      target_spec: "write a concise thesis",
      success_criteria: ["covers the architecture"],
      constraints: ["keep it short"],
    },
    model_pool: ["claude-sonnet-4-5"],
    frame_pool: ["precision"],
    grader: { kind: "registered", key: "prose_substrate_thesis" },
  };

  const codeTask: TaskDraft = {
    name: "code_leetcode_longest_substring",
    artifact_type: "code",
    artifact_filename: "solution.py",
    seed_content: "def length_of_longest_substring(s): ...",
    brief: {
      target_spec: "implement longest substring",
      success_criteria: ["passes tests"],
      constraints: [],
    },
    model_pool: ["claude-opus-4-7"],
    frame_pool: [],
    grader: { kind: "none" },
  };

  const graders: GraderSummary[] = [
    {
      key: "prose_substrate_thesis",
      label: "Brief judge",
      supported_artifact_types: ["prose"],
      capabilities: ["brief-criteria", "llm-judge"],
      source: "builtin",
      config_required: false,
      config_schema: { judge_model: "" },
    },
    {
      key: "code_leetcode_longest_substring",
      label: "LeetCode #3 mechanical grader",
      supported_artifact_types: ["code"],
      capabilities: ["pytest", "mypy"],
      source: "builtin",
      config_required: false,
      config_schema: { timeout_s: 0 },
    },
  ];

  test("validateTaskDraftJson accepts and rejects task JSON", () => {
    expect(validateTaskDraftJson(proseTask).ok).toBe(true);
    expect(
      validateTaskDraftJson({
        ...proseTask,
        artifact_filename: "events.jsonl",
      }).ok,
    ).toBe(false);
  });

  test("validateGraderConfigDraftJson enforces registered grader, compatibility, and shape", () => {
    const success = validateGraderConfigDraftJson(
      {
        task_name: "prose_substrate_thesis",
        grader_key: "prose_substrate_thesis",
        config: { judge_model: "claude-sonnet-4-5" },
      },
      proseTask,
      graders,
    );
    expect(success.ok).toBe(true);

    const noGrader = validateGraderConfigDraftJson(
      {
        task_name: "code_leetcode_longest_substring",
        grader_key: "code_leetcode_longest_substring",
        config: { timeout_s: 30 },
      },
      codeTask,
      graders,
    );
    expect(noGrader.ok).toBe(false);

    const wrongArtifact = validateGraderConfigDraftJson(
      {
        task_name: "prose_substrate_thesis",
        grader_key: "code_leetcode_longest_substring",
        config: { timeout_s: 30 },
      },
      proseTask,
      graders,
    );
    expect(wrongArtifact.ok).toBe(false);

    const wrongShape = validateGraderConfigDraftJson(
      {
        task_name: "prose_substrate_thesis",
        grader_key: "prose_substrate_thesis",
        config: { judge_model: 1 },
      },
      proseTask,
      graders,
    );
    expect(wrongShape.ok).toBe(false);

    const mismatchedTask = validateGraderConfigDraftJson(
      {
        task_name: "code_leetcode_longest_substring",
        grader_key: "prose_substrate_thesis",
        config: { judge_model: "claude-sonnet-4-5" },
      },
      proseTask,
      graders,
    );
    expect(mismatchedTask.ok).toBe(false);

    const trimmedGrader = validateGraderConfigDraftJson(
      {
        task_name: "prose_substrate_thesis",
        grader_key: "prose_substrate_thesis",
        config: { judge_model: "claude-sonnet-4-5" },
      },
      proseTask,
      [
        {
          ...graders[0],
          key: " prose_substrate_thesis ",
        },
      ],
    );
    expect(trimmedGrader.ok).toBe(true);
  });

  test("task store write, list, get, and delete round-trip", async () => {
    await upsertTaskDraft(proseTask);
    await upsertTaskDraft(codeTask);
    await mkdir(join(dashboardDataRoot, "tasks"), { recursive: true });
    await writeFile(
      join(dashboardDataRoot, "tasks", "mismatched_task.json"),
      JSON.stringify({
        ...proseTask,
        name: "code_leetcode_trapping_rain_water",
      }),
      "utf-8",
    );

    const summaries = await listTaskSummaries();
    expect(summaries.map((task) => task.name)).toEqual([
      "code_leetcode_longest_substring",
      "prose_substrate_thesis",
    ]);
    expect(summaries[1]!.has_grader).toBe(true);

    const got = await getTaskDraft("prose_substrate_thesis");
    expect(got).not.toBeNull();
    expect(got!.artifact_filename).toBe("draft.md");

    const drafts = await listTaskDrafts();
    expect(drafts).toHaveLength(2);

    await writeFile(
      join(dashboardDataRoot, "tasks", "prose_substrate_thesis.json"),
      JSON.stringify({
        ...proseTask,
        name: "code_leetcode_trapping_rain_water",
      }),
      "utf-8",
    );
    expect(await getTaskDraft("prose_substrate_thesis")).toBeNull();

    expect(await deleteTaskDraft("prose_substrate_thesis")).toBe(true);
    expect(await getTaskDraft("prose_substrate_thesis")).toBeNull();
  });

  test("grader config store write, list, get, and delete round-trip", async () => {
    const config: GraderConfigDraft = {
      task_name: "prose_substrate_thesis",
      grader_key: "prose_substrate_thesis",
      config: { judge_model: "claude-sonnet-4-5" },
    };

    await upsertGraderConfigDraft(config);
    await mkdir(join(dashboardDataRoot, "grader-configs"), { recursive: true });
    await writeFile(
      join(dashboardDataRoot, "grader-configs", "mismatched_task.json"),
      JSON.stringify({
        ...config,
        task_name: "code_leetcode_trapping_rain_water",
      }),
      "utf-8",
    );

    const got = await getGraderConfigDraft("prose_substrate_thesis");
    expect(got).not.toBeNull();
    expect(got!.grader_key).toBe("prose_substrate_thesis");

    const drafts = await listGraderConfigDrafts();
    expect(drafts).toHaveLength(1);

    await writeFile(
      join(dashboardDataRoot, "grader-configs", "prose_substrate_thesis.json"),
      JSON.stringify({
        ...config,
        task_name: "code_leetcode_trapping_rain_water",
      }),
      "utf-8",
    );
    expect(await getGraderConfigDraft("prose_substrate_thesis")).toBeNull();

    expect(await deleteGraderConfigDraft("prose_substrate_thesis")).toBe(true);
    expect(await getGraderConfigDraft("prose_substrate_thesis")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run_metadata derivation
// ---------------------------------------------------------------------------

describe("getCellDetail run_metadata", () => {
  async function makeRunSpec(runTs: string, modelPool: string[]): Promise<void> {
    const specDir = join(runRoot, runTs);
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "run-spec.json"),
      JSON.stringify({ task: "prose_substrate_thesis", model_pool: modelPool, condition: { kind: "ensemble_incremental", n: 2 }, grade: false }),
      "utf-8",
    );
  }

  function incrementalStartedLine(agentIds: string[], ts = "2026-06-04T10:00:00Z"): string {
    return JSON.stringify({ ts, kind: "incremental_started", payload: { agent_ids: agentIds } });
  }

  test("maps agent_ids to models and sets attribution_source run_spec_derived", async () => {
    const runTs = "2026-06-04T10-00-00Z";
    const modelPool = ["claude-sonnet-4-6", "claude-opus-4-7"];
    await makeRunSpec(runTs, modelPool);
    await makeCell(runTs, "task", "cond", [
      incrementalStartedLine(["agent-0", "agent-1"]),
      eventLine("proposal_applied"),
    ]);

    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === runTs);
    expect(cell).toBeDefined();

    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    const rm = detail!.run_metadata;
    expect(rm).not.toBeNull();
    expect(rm!.attribution_source).toBe("run_spec_derived");
    expect(rm!.model_pool).toEqual(modelPool);
    expect(rm!.agents).toHaveLength(2);
    expect(rm!.agents[0]).toEqual({ agent_id: "agent-0", model_id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" });
    expect(rm!.agents[1]).toEqual({ agent_id: "agent-1", model_id: "claude-opus-4-7", label: "Claude Opus 4.7" });
  });

  test("returns run_metadata null when run-spec.json is absent", async () => {
    await makeCell("2026-06-04T11-00-00Z", "task", "cond", [
      incrementalStartedLine(["agent-0"]),
    ]);

    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === "2026-06-04T11-00-00Z");
    expect(cell).toBeDefined();

    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    expect(detail!.run_metadata).toBeNull();
  });

  test("returns attribution_source missing when incremental_started payload is null", async () => {
    const runTs = "2026-06-04T13-00-00Z";
    await makeRunSpec(runTs, ["claude-sonnet-4-6"]);
    await makeCell(runTs, "task", "cond", [
      JSON.stringify({ ts: "2026-06-04T13:00:00Z", kind: "incremental_started", payload: null }),
    ]);

    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === runTs);
    expect(cell).toBeDefined();

    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    const rm = detail!.run_metadata;
    expect(rm).not.toBeNull();
    expect(rm!.attribution_source).toBe("missing");
    expect(rm!.agents).toHaveLength(0);
  });

  test("returns attribution_source missing when an agent_id is an empty string", async () => {
    // An empty agent_id would violate AgentModelSummarySchema (agent_id.min(1))
    // and throw at the API boundary; treat it as missing attribution instead.
    const runTs = "2026-06-04T13-30-00Z";
    await makeRunSpec(runTs, ["claude-sonnet-4-6"]);
    await makeCell(runTs, "task", "cond", [
      incrementalStartedLine(["agent-0", ""]),
    ]);

    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === runTs);
    expect(cell).toBeDefined();

    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    const rm = detail!.run_metadata;
    expect(rm).not.toBeNull();
    expect(rm!.attribution_source).toBe("missing");
    expect(rm!.agents).toHaveLength(0);
  });

  test("wraps agent_ids longer than model_pool via modulo", async () => {
    const runTs = "2026-06-04T12-00-00Z";
    const modelPool = ["claude-sonnet-4-6", "claude-opus-4-7"];
    await makeRunSpec(runTs, modelPool);
    await makeCell(runTs, "task", "cond", [
      incrementalStartedLine(["agent-0", "agent-1", "agent-2"]),
    ]);

    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === runTs);
    expect(cell).toBeDefined();

    const detail = await getCellDetail(cell!.cell_id);
    expect(detail).not.toBeNull();
    const rm = detail!.run_metadata;
    expect(rm).not.toBeNull();
    expect(rm!.attribution_source).toBe("run_spec_derived");
    expect(rm!.agents).toHaveLength(3);
    // pool has 2 entries: [0]=claude-sonnet-4-6, [1]=claude-opus-4-7, [2 % 2=0]=claude-sonnet-4-6
    expect(rm!.agents[0]!.model_id).toBe("claude-sonnet-4-6");
    expect(rm!.agents[1]!.model_id).toBe("claude-opus-4-7");
    expect(rm!.agents[2]!.model_id).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// Archive index, cleanable predicate, and cell cleanup
// ---------------------------------------------------------------------------

// Stub launcher that never spawns a process (used for server integration tests).
const noopLauncher: Launcher = {
  spawn(_args, _opts) {
    return {
      pid: 0,
      kill: () => {},
      done: new Promise(() => {}),
    };
  },
};

describe("archive index and cleanable predicate", () => {
  let dashboardDataRoot: string;
  let originalDashboardDataRoot: string | undefined;

  beforeEach(async () => {
    dashboardDataRoot = await mkdtemp(
      join(tmpdir(), "lbc-dashboard-archive-test-"),
    );
    originalDashboardDataRoot = process.env.LBC_DASHBOARD_DATA_ROOT;
    process.env.LBC_DASHBOARD_DATA_ROOT = dashboardDataRoot;
  });

  afterEach(async () => {
    if (originalDashboardDataRoot === undefined) {
      delete process.env.LBC_DASHBOARD_DATA_ROOT;
    } else {
      process.env.LBC_DASHBOARD_DATA_ROOT = originalDashboardDataRoot;
    }
    await rm(dashboardDataRoot, { recursive: true, force: true });
  });

  test("missing archived-cells.json is safe (no throw, treated as empty)", async () => {
    await makeCell("2026-06-01T10-00-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    expect(cells).toHaveLength(1);
    expect(cells[0].archived).toBe(false);
  });

  test("malformed JSON in archived-cells.json is treated as empty set", async () => {
    await writeFile(
      join(dashboardDataRoot, "archived-cells.json"),
      "not valid json ][",
      "utf-8",
    );
    await makeCell("2026-06-01T10-01-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    expect(cells[0].archived).toBe(false);
  });

  test("wrong-shape archived-cells.json is treated as empty set", async () => {
    await writeFile(
      join(dashboardDataRoot, "archived-cells.json"),
      JSON.stringify({ wrong_key: [1, 2, 3] }),
      "utf-8",
    );
    await makeCell("2026-06-01T10-02-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    expect(cells[0].archived).toBe(false);
  });

  test("archiving a cell marks it archived:true; non-archived sibling stays false", async () => {
    await makeCell("2026-06-01T10-03-00Z", "task", "cond_a", [
      eventLine("incremental_started"),
    ]);
    await makeCell("2026-06-01T10-03-00Z", "task", "cond_b", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const a = cells.find((c) => c.condition_name === "cond_a")!;
    await addToArchivedCellsIndex(a.cell_id);

    const updated = await listCells();
    const archivedA = updated.find((c) => c.condition_name === "cond_a")!;
    const freshB = updated.find((c) => c.condition_name === "cond_b")!;
    expect(archivedA.archived).toBe(true);
    expect(freshB.archived).toBe(false);
  });

  test("archived flag is set on archived cells; listCells callers can filter on it", async () => {
    await makeCell("2026-06-01T10-04-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cellId = (await listCells())[0].cell_id;
    await addToArchivedCellsIndex(cellId);

    const all = await listCells();
    const defaultVisible = all.filter((c) => !c.archived);
    const archivedOnly = all.filter((c) => c.archived);
    expect(defaultVisible).toHaveLength(0);
    expect(archivedOnly).toHaveLength(1);
  });

  test("GET /api/cells ?archived=include returns all cells; ?archived=only returns archived cells only", async () => {
    await makeCell("2026-06-01T10-05-00Z", "task", "archived_cond", [
      eventLine("incremental_started"),
    ]);
    await makeCell("2026-06-01T10-05-00Z", "task", "live_cond", [
      eventLine("incremental_started"),
    ]);

    const all = await listCells();
    const toArchive = all.find((c) => c.condition_name === "archived_cond")!;
    await addToArchivedCellsIndex(toArchive.cell_id);

    const app = createApp({ registry: new RunRegistry(noopLauncher) });

    const defaultResp = await app.request("/api/cells");
    const defaultJson = (await defaultResp.json()) as { cells: unknown[] };
    expect(defaultJson.cells).toHaveLength(1);

    const includeResp = await app.request("/api/cells?archived=include");
    const includeJson = (await includeResp.json()) as { cells: unknown[] };
    expect(includeJson.cells).toHaveLength(2);

    const onlyResp = await app.request("/api/cells?archived=only");
    const onlyJson = (await onlyResp.json()) as { cells: unknown[] };
    expect(onlyJson.cells).toHaveLength(1);
    expect(
      (onlyJson.cells[0] as { condition_name: string }).condition_name,
    ).toBe("archived_cond");
  });

  test("restore removes archived:true from cell", async () => {
    await makeCell("2026-06-01T10-06-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cellId = (await listCells())[0].cell_id;
    await addToArchivedCellsIndex(cellId);
    await removeFromArchivedCellsIndex(cellId);
    const restored = await getCellSummary(cellId);
    expect(restored?.archived).toBe(false);
  });

  test("delete removes only the selected cell dir; siblings survive", async () => {
    await makeCell("2026-06-01T10-07-00Z", "task", "cond_del", [
      eventLine("incremental_started"),
      eventLine("incremental_terminated"),
    ]);
    await makeCell("2026-06-01T10-07-00Z", "task", "cond_keep", [
      eventLine("incremental_started"),
    ]);

    const all = await listCells();
    const toDelete = all.find((c) => c.condition_name === "cond_del")!;
    expect(toDelete.cleanable).toBe(true);

    const cellDir = resolveCellDirPath(toDelete.cell_id)!;
    await rm(cellDir, { recursive: true });

    const remaining = await listCells();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].condition_name).toBe("cond_keep" as ConditionName);
  });

  test("delete removes archive-index entry for the deleted id", async () => {
    await makeCell("2026-06-01T10-08-00Z", "task", "cond", [
      eventLine("incremental_started"),
      eventLine("incremental_terminated"),
    ]);
    const cellId = (await listCells())[0].cell_id;
    await addToArchivedCellsIndex(cellId);

    const cellDir = resolveCellDirPath(cellId)!;
    await rm(cellDir, { recursive: true });
    await removeFromArchivedCellsIndex(cellId);

    const remaining = await listCells();
    expect(remaining).toHaveLength(0);
    expect(await getCellSummary(cellId)).toBeNull();
  });

  test("cleanable branch (a): ended cells are always cleanable regardless of liveness", async () => {
    await makeCell("2026-06-01T10-09-00Z", "task", "cond", [
      eventLine("incremental_started"),
      eventLine("incremental_terminated"),
    ]);
    const cells = await listCells();
    expect(cells[0].status).toBe("ended");
    expect(cells[0].cleanable).toBe(true);
  });

  test("live-ownership gate: ended cell is NOT cleanable when still in liveCellIds", async () => {
    // Regression: terminal coordination events (e.g. proposal_applied following
    // proposal_picked) can arrive while the child grading process is still running.
    // computeCleanable must consult liveCellIds BEFORE event-derived status.
    await makeCell("2026-06-01T10-18-00Z", "task", "cond", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
    ]);
    const cells = await listCells();
    expect(cells[0].status).toBe("ended");
    const cellId = cells[0].cell_id;

    const liveCellIds = new Set([cellId]);
    const liveEndedCells = await listCells(liveCellIds);
    expect(liveEndedCells[0].cleanable).toBe(false);
  });

  test("DELETE /api/cells/:cellId returns 409 when live process owns an ended cell", async () => {
    // The server DELETE handler must enforce the live-ownership gate even when the
    // event-derived status is ended — stale tabs or direct API calls may attempt
    // DELETE while the process is still grading.
    //
    // Cell target and condition are chosen so they match what RunRegistry.launch()
    // derives via cellIdFor(runTs, spec.task, conditionName(kind, n)):
    //   spec.task = "prose_substrate_thesis"
    //   conditionName("single_agent", 1) = "single_agent"
    const RUN_TS = "2026-06-01T10-19-00Z";
    await makeCell(RUN_TS, "prose_substrate_thesis", "single_agent", [
      eventLine("incremental_started"),
      eventLine("incremental_terminated"),
    ]);
    const cells = await listCells();
    const cell = cells.find((c) => c.run_ts === RUN_TS);
    expect(cell?.status).toBe("ended");
    const cellId = cell!.cell_id;

    // Seed the registry with a "running" record for this cell so the server
    // handler's liveCellIds set contains cellId.
    const registry = new RunRegistry(noopLauncher);
    registry.launch({
      runTs: RUN_TS,
      spec: {
        task: "prose_substrate_thesis",
        model_pool: ["claude-sonnet-4-6"],
        condition: { kind: "single_agent", n: 1 },
        grade: false,
      },
      specPath: "/tmp/fake-spec.json",
      outputDir: "/tmp/fake-output",
    });
    // Confirm the registry reports the cell as running
    const liveIds = new Set(
      registry.list().filter((r) => r.status === "running").map((r) => r.cell_id),
    );
    expect(liveIds.has(cellId)).toBe(true);

    const app = createApp({ registry });
    const resp = await app.request(`/api/cells/${cellId}`, { method: "DELETE" });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Run still in progress");
  });

  test("incremental-to-consensus transition: live process blocks DELETE even when status is ended", async () => {
    // Pin the specific race: proposal_picked → proposal_applied fires (status="ended")
    // while the child grading process is still in liveCellIds. DELETE must return 409.
    await makeCell("2026-06-01T10-20-00Z", "task", "cond", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
      eventLine("convergence_started"),
      eventLine("proposal_picked"),
      eventLine("proposal_applied"),
    ]);
    const cells = await listCells();
    const cellId = cells[0].cell_id;
    expect(cells[0].status).toBe("ended");

    // With live ownership, cleanable must be false
    const liveEndedCells = await listCells(new Set([cellId]));
    expect(liveEndedCells[0].status).toBe("ended");
    expect(liveEndedCells[0].cleanable).toBe(false);

    // getCellSummary path also returns cleanable=false
    const summary = await getCellSummary(cellId, new Set([cellId]));
    expect(summary?.cleanable).toBe(false);
  });

  test("cleanable branch (b): active cell with no live run is cleanable after STALE_MS", async () => {
    await makeCell("2026-06-01T10-10-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const lastMs = cells[0].last_activity_ms;

    const staleCells = await listCells(new Set(), lastMs + STALE_MS + 1);
    expect(staleCells[0].status).toBe("active");
    expect(staleCells[0].cleanable).toBe(true);
  });

  test("cleanable branch (b): active cell is NOT cleanable before STALE_MS elapses", async () => {
    await makeCell("2026-06-01T10-11-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const lastMs = cells[0].last_activity_ms;

    const freshCells = await listCells(new Set(), lastMs + STALE_MS - 1);
    expect(freshCells[0].cleanable).toBe(false);
  });

  test("cleanable branch (b): active cell with live run is NOT cleanable even if stale", async () => {
    await makeCell("2026-06-01T10-12-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const cellId = cells[0].cell_id;
    const lastMs = cells[0].last_activity_ms;

    const liveCellIds = new Set([cellId]);
    const staleButLive = await listCells(liveCellIds, lastMs + STALE_MS + 1);
    expect(staleButLive[0].cleanable).toBe(false);
  });

  test("archive is always allowed on active cells (no cleanable gate on archive)", async () => {
    await makeCell("2026-06-01T10-13-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const cellId = cells[0].cell_id;
    expect(cells[0].status).toBe("active");
    expect(cells[0].cleanable).toBe(false);

    // Archive should succeed regardless of cleanable state
    await addToArchivedCellsIndex(cellId);
    const updated = await getCellSummary(cellId);
    expect(updated?.archived).toBe(true);
  });

  test("DELETE /api/cells/:cellId returns 409 when cell is not cleanable", async () => {
    await makeCell("2026-06-01T10-14-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cells = await listCells();
    const cellId = cells[0].cell_id;
    expect(cells[0].cleanable).toBe(false);

    const app = createApp({ registry: new RunRegistry(noopLauncher) });
    const resp = await app.request(`/api/cells/${cellId}`, { method: "DELETE" });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Run still in progress");
  });

  test("POST /api/cells/:cellId/archive returns updated CellSummary with archived:true", async () => {
    await makeCell("2026-06-01T10-15-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cellId = (await listCells())[0].cell_id;

    const app = createApp({ registry: new RunRegistry(noopLauncher) });
    const resp = await app.request(`/api/cells/${cellId}/archive`, {
      method: "POST",
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { archived: boolean; cell_id: string };
    expect(body.archived).toBe(true);
    expect(body.cell_id).toBe(cellId);
  });

  test("DELETE /api/cells/:cellId/archive returns updated CellSummary with archived:false", async () => {
    await makeCell("2026-06-01T10-16-00Z", "task", "cond", [
      eventLine("incremental_started"),
    ]);
    const cellId = (await listCells())[0].cell_id;
    await addToArchivedCellsIndex(cellId);

    const app = createApp({ registry: new RunRegistry(noopLauncher) });
    const resp = await app.request(`/api/cells/${cellId}/archive`, {
      method: "DELETE",
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { archived: boolean };
    expect(body.archived).toBe(false);
  });

  test("DELETE /api/cells/:cellId succeeds and removes cell dir when cleanable", async () => {
    await makeCell("2026-06-01T10-17-00Z", "task", "cond", [
      eventLine("incremental_started"),
      eventLine("incremental_terminated"),
    ]);
    const cells = await listCells();
    const cellId = cells[0].cell_id;
    expect(cells[0].cleanable).toBe(true);

    // Also archive it — delete should clean up the index entry too
    await addToArchivedCellsIndex(cellId);

    const app = createApp({ registry: new RunRegistry(noopLauncher) });
    const resp = await app.request(`/api/cells/${cellId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Cell dir is gone
    const remaining = await listCells();
    expect(remaining).toHaveLength(0);

    // Archive index entry is cleaned up — read the file directly since
    // getCellSummary returns null on a missing dir regardless of index state.
    const indexRaw = await readFile(
      join(dashboardDataRoot, "archived-cells.json"),
      "utf-8",
    );
    const index = JSON.parse(indexRaw) as { archived_cell_ids: string[] };
    expect(index.archived_cell_ids).not.toContain(cellId);
  });
});
