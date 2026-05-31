/**
 * Tests for the cell-store layer. Builds a fake .run/ tree under a
 * temp dir and verifies discovery + parsing.
 *
 * The Python harness's behavior is reproduced as fixtures, not
 * stubbed in code — these tests guard the on-disk contract between
 * the harness's writers and the dashboard's readers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ConditionName,
  TargetName,
} from "../pwa/lib/ids";
import type { GraderConfigDraft, GraderSummary, TaskDraft } from "./contracts";
import {
  deleteGraderConfigDraft,
  deleteTaskDraft,
  getCellDetail,
  getGraderConfigDraft,
  getTaskDraft,
  listCells,
  listGraderConfigDrafts,
  listTaskDrafts,
  listTaskSummaries,
  readEvalScores,
  readEvents,
  upsertGraderConfigDraft,
  upsertTaskDraft,
  validateGraderConfigDraftJson,
  validateTaskDraftJson,
} from "./store";

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
});

describe("getCellDetail", () => {
  test("surfaces artifact filename + commit count", async () => {
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
    expect(detail!.events.length).toBe(2);
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

    // The cell_id round-trips back to the same target/condition.
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
    grader: { kind: "none" },
  };

  const graders: GraderSummary[] = [
    {
      key: "prose_substrate_thesis",
      label: "Brief judge",
      supported_artifact_types: ["prose"],
      capabilities: ["brief-criteria", "llm-judge"],
      config_schema: { judge_model: "" },
    },
    {
      key: "code_leetcode_longest_substring",
      label: "LeetCode #3 mechanical grader",
      supported_artifact_types: ["code"],
      capabilities: ["pytest", "mypy"],
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
  });

  test("task store write, list, get, and delete round-trip", async () => {
    await upsertTaskDraft(proseTask);
    await upsertTaskDraft(codeTask);

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

    const got = await getGraderConfigDraft("prose_substrate_thesis");
    expect(got).not.toBeNull();
    expect(got!.grader_key).toBe("prose_substrate_thesis");

    const drafts = await listGraderConfigDrafts();
    expect(drafts).toHaveLength(1);

    expect(await deleteGraderConfigDraft("prose_substrate_thesis")).toBe(true);
    expect(await getGraderConfigDraft("prose_substrate_thesis")).toBeNull();
  });
});
