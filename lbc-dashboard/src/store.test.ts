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

import { getCellDetail, listCells, readEvents } from "./store";

// parseCellId is intentionally NOT exported from store.ts (internal
// helper). The path-traversal test below verifies rejection at the
// public boundary — getCellDetail with a crafted cell_id should
// return null without a file lookup.

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

    const detail = await getCellDetail(
      "2026-05-06T19-00-00Z__prose_substrate_thesis__ensemble_multi_round_n3",
    );
    expect(detail).not.toBeNull();
    expect(detail!.artifact_filename).toBe("draft.md");
    expect(detail!.commit_count).toBe(4);
    expect(detail!.events.length).toBe(2);
  });

  test("rejects path-traversal cell_ids without touching disk", async () => {
    // Crafted cell_ids that would otherwise escape RUN_ROOT via
    // path-join. Each must return null without a file lookup, so a
    // missing-segment file outside RUN_ROOT can't accidentally
    // surface.
    expect(await getCellDetail("..__..__..")).toBeNull();
    expect(await getCellDetail("../etc__passwd__x")).toBeNull();
    expect(await getCellDetail("a/b__c__d")).toBeNull();
    expect(await getCellDetail("a__b\\c__d")).toBeNull();
    expect(await getCellDetail("a__.__b")).toBeNull();
    expect(await getCellDetail("__b__c")).toBeNull();
    // Wrong number of segments.
    expect(await getCellDetail("a__b")).toBeNull();
    expect(await getCellDetail("a__b__c__d")).toBeNull();
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
