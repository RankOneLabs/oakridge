import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { openDatabase } from "../src/storage/database";
import { selectDefinitionGraph } from "../src/projections/definition-view";
import { listDefinitions, listLiveRuns, listRuns, listRunsNeedingWork, readDefinition, readEventStreamBoundary, readHistory, readOperatorEventsAfter,
  readPinnedDefinition, readRun, readRunInspect, readRunStanding, readUnitDiagnostics } from "../src/storage/read-store";
import { setRunArchived } from "../src/storage/registry-store";
import { readScopedSnapshot } from "../src/storage/snapshot-store";
import { actionOf, executor, launch, openAuthority, pinSample, sampleWorkflow, submitter, unitOf, type Authority } from "./authority-fixture";

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
const writerAction = (run_id: RunId): Promise<string> => actionOf(authority, run_id, "writer");

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
  const action = await writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "failed" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  const snapshot = await readScopedSnapshot(authority.db, run_id, unitOf(run_id, "document"));
  expect(snapshot?.retry_events.map(([unit, worker]) => [unit, worker])).toEqual([[unitOf(run_id, "document"), "writer"]]);
});

test("a run reads with its units and pinned definition; listings page newest first and split archived runs", async () => {
  const older = await launched();
  const newer = await launched();
  await setRunArchived(authority.db, older, true);
  const read = await readRun(authority.db, newer);
  const active = await listRuns(authority.db, { after: null, limit: 1, is_archived: false });
  const archived = await listRuns(authority.db, { after: null, limit: 100, is_archived: true });
  expect({ units: read?.units.map((unit) => unit.unit_key), digest: read?.definition.digest, first: active.items[0]?.run.id,
    has_next: active.next !== null, archived: archived.items.map((item) => item.run.id) })
    .toEqual({ units: ["$root", "document"], digest, first: newer, has_next: true, archived: [older] });
});

test("the inspect read holds the run and its events newest first; a missing run reads as null", async () => {
  const run_id = await launched();
  const action = await writerAction(run_id);
  await submitter(authority)({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "it broke" } }, writer: executor(action) });
  const inspect = await readRunInspect(authority.db, run_id);
  expect({ run: inspect?.run.run.id, events: inspect?.events.map((event) => [event.payload.kind, event.writer.kind]), missing: await readRunInspect(authority.db, "run-missing") })
    .toEqual({ run: run_id, events: [["worker_ended", "executor"], ["launched", "operator"]], missing: null });
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

test("definitions list, read, and resolve from a run with their checked program", async () => {
  const run_id = await launched();
  const page = await listDefinitions(authority.db, { after: null, limit: 10, is_archived: false });
  const detail = await readDefinition(authority.db, bundle_id);
  const pinned = await readPinnedDefinition(authority.db, run_id);
  expect({ listed: page.items.map((item) => item.bundle_id), detail: detail?.source.workflow, pinned: [pinned?.digest, pinned?.checked_program.digest] })
    .toEqual({ listed: [bundle_id], detail: "review_loop", pinned: [digest, digest] });
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

/** A run whose writer published two drafts, the editor requested changes on the first, and one event was refused. */
async function reviewedRun(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly action: string }> {
  const run_id = await launched();
  const submit = submitter(authority);
  const unit = unitOf(run_id, "document");
  const action = await writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "first" }, by: action }, writer: executor(action) });
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "request_changes", target: `${unit}:draft:1`, payload: { feedback: "more" } } });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:9`, payload: {} } });
  return { run_id, unit, action };
}

test("a run reads everything recorded against it, in the order commit wrote it", async () => {
  const { run_id, unit, action } = await reviewedRun();
  const read = await readRun(authority.db, run_id);
  expect({ units: read?.units.map((item) => [item.unit_key, item.review_prompts]), dependencies: read?.dependencies,
    attempts: read?.attempts.map((attempt) => [attempt.worker, attempt.mode.kind, attempt.status.kind]),
    revisions: read?.revisions.map((revision) => String(revision.id)), decisions: read?.decisions.map((decision) => decision.decision),
    wanted: read?.wanted.map((item) => [item.unit_id, item.actions.map((wanted) => wanted.kind === "run_worker" ? wanted.worker : wanted.kind)]),
    writer: read?.attempts[0]?.action_id === action, missing: await readRun(authority.db, "run-missing") })
    .toEqual({ units: [["$root", {}], ["document", {}]], dependencies: [],
      attempts: [["writer", "initial", "succeeded"], ["critic", "review", "pending"], ["writer", "revise", "pending"]],
      revisions: [`${unit}:draft:1`], decisions: ["request_changes"], wanted: [[unit, ["writer"]]], writer: true, missing: null });
});

test("a run reads the retries the operator requested", async () => {
  const run_id = await launched();
  const action = await writerAction(run_id);
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "failed" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  const read = await readRun(authority.db, run_id);
  expect(read?.retries.map((retry) => [retry.unit_id, retry.worker])).toEqual([[unitOf(run_id, "document"), "writer"]]);
});

test("history pages newest first with each event's writer and wanted actions; a unit's history omits run-level events", async () => {
  const { run_id, unit } = await reviewedRun();
  const first = (await readHistory(authority.db, { run_id, unit_id: null, after: null, limit: 3 }))!;
  const rest = (await readHistory(authority.db, { run_id, unit_id: null, after: first.next, limit: 10 }))!;
  const unit_only = (await readHistory(authority.db, { run_id, unit_id: unit, after: null, limit: 10 }))!;
  expect(await readHistory(authority.db, { run_id, unit_id: `${run_id}/missing`, after: null, limit: 10 })).toBeNull();
  const kinds = [...first.items, ...rest.items].map((item) => item.event.payload.kind);
  expect({ kinds, last_page: rest.next, launch_writer: rest.items.at(-1)?.event.writer.kind,
    decided_wanted: first.items[0]?.wanted.flatMap((item) => item.actions.map((wanted) => wanted.kind === "run_worker" ? wanted.mode.kind : wanted.kind)),
    unit_kinds: unit_only.items.map((item) => item.event.payload.kind) })
    .toEqual({ kinds: ["operator_decided", "worker_ended", "revision_published", "worker_started", "launched"], last_page: null, launch_writer: "operator",
      decided_wanted: ["revise"], unit_kinds: ["operator_decided", "worker_ended", "revision_published", "worker_started"] });
});

test("a unit's diagnostics hold its attempts, its intents' bookkeeping and the events step refused", async () => {
  const { run_id, unit } = await reviewedRun();
  const diagnostics = await readUnitDiagnostics(authority.db, { run_id, unit_id: unit });
  expect({ attempts: diagnostics?.attempts.length, intents: diagnostics?.intents.length, rejected: diagnostics?.rejected.map((receipt) => receipt.result.kind),
    missing: await readUnitDiagnostics(authority.db, { run_id, unit_id: `${run_id}/missing` }) })
    .toEqual({ attempts: 3, intents: 3, rejected: ["rejected"], missing: null });
});

test("live runs are launched, unfinished and unarchived, paged by id", async () => {
  const live = await launched();
  const cancelled = await launched();
  const archived = await launched();
  await submitter(authority)({ run_id: cancelled, event: { kind: "cancel_requested" } });
  await setRunArchived(authority.db, archived, true);
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const listed = await listLiveRuns(authority.db, { after, limit: 1 });
    ids.push(...listed.items.map((item) => item.run.id));
    if (listed.next === null) break;
    after = listed.next;
  }
  expect({ live: ids.includes(live), cancelled: ids.includes(cancelled), archived: ids.includes(archived), sorted: [...ids].sort().join() === ids.join() })
    .toEqual({ live: true, cancelled: false, archived: false, sorted: true });
});

test("a definition graph lists each declared unit with its dependencies as edges", () => {
  const graph = selectDefinitionGraph(sampleWorkflow("fan-out"));
  expect({ nodes: graph.nodes.map((node) => [node.key, node.scope, node.depends_on]), edges: graph.edges }).toEqual({
    nodes: [["prepare", "prepare", []], ["work", "work", ["prepare"]], ["work/item", "item", []]],
    edges: [{ from: "prepare", to: "work" }] });
});

test("a page of runs reads in one batch, each run holding only its own rows", async () => {
  const first = await stalledRun();
  const second = await launched();
  const page = await listRuns(authority.db, { after: null, limit: 100, is_archived: false });
  const of = (run_id: RunId) => page.items.find((item) => item.run.id === run_id);
  const foreign = page.items.flatMap((item) => [...item.units, ...item.attempts, ...item.revisions, ...item.decisions, ...item.dependencies]
    .filter((row) => row.run_id !== item.run.id));
  expect({ order: page.items.map((item) => item.run.id).indexOf(second) < page.items.map((item) => item.run.id).indexOf(first),
    first_retries: of(first)?.retries.length, second_retries: of(second)?.retries.length, foreign: foreign.length,
    wanted: of(second)?.wanted.every((item) => item.unit_id.startsWith(second)) })
    .toEqual({ order: true, first_retries: 1, second_retries: 0, foreign: 0, wanted: true });
});

async function stalledRun(): Promise<RunId> {
  const run_id = await launched();
  const action = await writerAction(run_id);
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "failed", code: "boom", detail: "failed" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  return run_id;
}
