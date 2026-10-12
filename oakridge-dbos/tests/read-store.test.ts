import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { openDatabase } from "../src/storage/database";
import { listDefinitions, listRuns, listRunsNeedingWork, readDefinition, readEventStreamBoundary, readOperatorEventsAfter,
  readPinnedDefinition, readRunInspect, readRunStanding, readRunView } from "../src/storage/read-store";
import { setRunArchived } from "../src/storage/registry-store";
import { readScopedSnapshot } from "../src/storage/snapshot-store";
import { executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
let digest: string;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id, digest } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

async function launched(): Promise<RunId> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  return run_id;
}
const writerAction = (run_id: RunId): string => `${unitOf(run_id, "document")}:writer:Initial:Missing`;

test("a scoped snapshot holds the unit, its ancestors and their children; with no unit, the whole run", async () => {
  const run_id = await launched();
  const scoped = await readScopedSnapshot(authority.db, run_id, unitOf(run_id, "document"));
  const whole = await readScopedSnapshot(authority.db, run_id, null);
  const missing = await readScopedSnapshot(authority.db, run_id, unitOf(run_id, "missing"));
  expect({ scoped: scoped?.units.map((unit) => unit.id), whole: whole?.units.length, attempts: scoped?.attempts.map((attempt) => attempt.worker), missing })
    .toEqual({ scoped: [run_id, unitOf(run_id, "document")], whole: 2, attempts: ["writer"], missing: null });
});

test("a scoped snapshot carries retry events for the units it holds", async () => {
  const run_id = await launched();
  const submit = submitter(authority);
  const action = writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "failed" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  const snapshot = await readScopedSnapshot(authority.db, run_id, unitOf(run_id, "document"));
  expect(snapshot?.retry_events.map(([unit, worker]) => [unit, worker])).toEqual([[unitOf(run_id, "document"), "writer"]]);
});

test("the run view lists the run's units; listings page newest first and split archived runs", async () => {
  const older = await launched();
  const newer = await launched();
  await setRunArchived(authority.db, older, true);
  const view = await readRunView(authority.db, newer);
  const active = await listRuns(authority.db, { after: null, limit: 1, is_archived: false });
  const archived = await listRuns(authority.db, { after: null, limit: 100, is_archived: true });
  expect({ units: view?.units.map((unit) => unit.unit_key), digest: view?.definition_digest, first: active.items[0]?.run_id,
    has_next: active.next_cursor !== null, archived: archived.items.map((run) => run.run_id) })
    .toEqual({ units: ["$root", "document"], digest, first: newer, has_next: true, archived: [older] });
});

test("inspect names a worker stalled on a failed attempt", async () => {
  const run_id = await launched();
  const action = writerAction(run_id);
  await submitter(authority)({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "it broke" } }, writer: executor(action) });
  const inspect = await readRunInspect(authority.db, run_id);
  expect(inspect?.attention.map((item) => [item.worker, item.detail])).toEqual([["writer", "it broke"]]);
});

test("run standing and needs-work follow status and owed intents", async () => {
  const running = await launched();
  const cancelled = await launched();
  await submitter(authority)({ run_id: cancelled, event: { kind: "cancel_requested" } });
  const needing_before = await listRunsNeedingWork(authority.db);
  await authority.db.updateTable("authority.effect_intent").set({ status: "stopped" }).where("run_id", "=", cancelled).execute();
  const needing_after = await listRunsNeedingWork(authority.db);
  const standing = await readRunStanding(authority.db, cancelled);
  expect({ before: [running, cancelled].map((id) => needing_before.includes(id)), after: [running, cancelled].map((id) => needing_after.includes(id)),
    standing: standing?.status.kind }).toEqual({ before: [true, true], after: [true, false], standing: "cancelled" });
});

test("definitions list, read with their graph, and resolve from a run", async () => {
  const run_id = await launched();
  const page = await listDefinitions(authority.db, { after: null, limit: 10, is_archived: false });
  const detail = await readDefinition(authority.db, bundle_id);
  const pinned = await readPinnedDefinition(authority.db, run_id);
  expect({ listed: page.items.map((item) => item.bundle_id), graph: detail?.graph.nodes.map((node) => node.key), pinned: pinned?.digest })
    .toEqual({ listed: [bundle_id], graph: ["document"], pinned: digest });
});

test("the operator stream returns events after a cursor and holds back transactions still open", async () => {
  const boundary = await readEventStreamBoundary(authority.db);
  const blocker = openDatabase(authority.url);
  try {
    // An open transaction that has taken a transaction id holds the stream's horizon behind it.
    const open = blocker.transaction().execute(async (trx) => {
      await sql`SELECT pg_current_xact_id()`.execute(trx);
      await launched();
      const held = await readOperatorEventsAfter(authority.db, { after: boundary.cursor, limit: 100, subscription_snapshot: null });
      expect(held).toEqual([]);
    });
    await open;
  } finally { await blocker.destroy(); }
  const delivered = await readOperatorEventsAfter(authority.db, { after: boundary.cursor, limit: 100, subscription_snapshot: boundary.snapshot });
  expect(delivered.map((row) => [row.event_key, row.was_visible_at_subscription])).toEqual([["run_event", false]]);
});
