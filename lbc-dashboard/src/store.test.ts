/**
 * Tests for the cell-store layer. Builds a fake .run/ tree under a
 * temp dir and verifies discovery + parsing.
 *
 * The Python harness's behavior is reproduced as fixtures, not
 * stubbed in code — these tests guard the on-disk contract between
 * the harness's writers and the dashboard's readers.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function buildFakeRunRoot(): Promise<string> {
  const root = await Bun.file(
    `/tmp/lbc-dashboard-test-${Date.now()}-${Math.random()}`,
  ).name!;
  // Bun.file().name is just a path; create the actual dir.
  await mkdir(root, { recursive: true });
  return root;
}

async function makeCell(
  runRoot: string,
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

describe("cell-store on-disk contract", () => {
  test("listCells discovers and orders cells, classifies status", async () => {
    const root = await buildFakeRunRoot();
    process.env.LBC_RUN_ROOT = root;
    // Force re-import so resolveRunRoot picks up the env override.
    delete require.cache[require.resolve("./store")];
    const { listCells } = await import("./store");

    await makeCell(root, "2026-05-06T17-00-00Z", "prose", "incremental_n2", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
      eventLine("incremental_terminated"),
    ]);
    await makeCell(root, "2026-05-06T18-00-00Z", "code", "single_round_n2", [
      eventLine("incremental_started"),
      eventLine("proposal_applied"),
    ]);

    const cells = await listCells();
    expect(cells.length).toBe(2);

    const ended = cells.find((c) => c.condition_name === "incremental_n2");
    const active = cells.find((c) => c.condition_name === "single_round_n2");
    expect(ended?.status).toBe("ended");
    expect(active?.status).toBe("active");
    expect(ended?.event_count).toBe(3);
    expect(active?.event_count).toBe(2);

    await rm(root, { recursive: true, force: true });
  });

  test("getCellDetail surfaces artifact filename + commit count", async () => {
    const root = await buildFakeRunRoot();
    process.env.LBC_RUN_ROOT = root;
    delete require.cache[require.resolve("./store")];
    const { getCellDetail } = await import("./store");

    await makeCell(
      root,
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

    await rm(root, { recursive: true, force: true });
  });

  test("malformed events.jsonl lines are skipped, not raised", async () => {
    const root = await buildFakeRunRoot();
    process.env.LBC_RUN_ROOT = root;
    delete require.cache[require.resolve("./store")];
    const { readEvents } = await import("./store");

    const cellDir = await makeCell(
      root,
      "2026-05-06T20-00-00Z",
      "x",
      "y",
      [eventLine("a"), "not json", eventLine("b"), ""],
    );

    const events = await readEvents(cellDir);
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("a");
    expect(events[1].kind).toBe("b");

    await rm(root, { recursive: true, force: true });
  });
});
