import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { openDatabase } from "../src/storage/database";
import { listDefinitions, listReviewCandidates, listRunAttempts, listRuns, listRunsNeedingWork, readArtifactHistory, readDefinition,
  readEventStreamBoundary, readHistory, readOperatorEventsAfter, readPinnedDefinition, readRunInspect, readRunStanding, readRunView, readUnit,
  readUnitDiagnostics, selectDefinitionGraph } from "../src/storage/read-store";
import { setRunArchived } from "../src/storage/registry-store";
import { readScopedSnapshot } from "../src/storage/snapshot-store";
import { executor, launch, openAuthority, pinSample, sampleWorkflow, submitter, unitOf, type Authority } from "./authority-fixture";

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

/** A run whose writer published two drafts, the editor requested changes on the first, and one event was refused. */
async function reviewedRun(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly action: string }> {
  const run_id = await launched();
  const submit = submitter(authority);
  const unit = unitOf(run_id, "document");
  const action = writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "first" }, by: action }, writer: executor(action) });
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "request_changes", target: `${unit}:draft:1`, payload: { feedback: "more" } } });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:9`, payload: {} } });
  return { run_id, unit, action };
}

test("a unit reads with its dependencies, attempts, revisions, decisions and intents; a missing unit reads as null", async () => {
  const { run_id, unit } = await reviewedRun();
  const read = await readUnit(authority.db, { run_id, unit_id: unit });
  expect({ unit: String(read?.unit.id), depends_on: read?.depends_on, attempts: read?.attempts.map((attempt) => [attempt.worker, attempt.mode.kind, attempt.status.kind]),
    revisions: read?.revisions.map((revision) => String(revision.id)), decisions: read?.decisions.map((decision) => decision.decision),
    intents: read?.intents.map((intent) => intent.status), missing: await readUnit(authority.db, { run_id, unit_id: `${run_id}/missing` }) })
    .toEqual({ unit, depends_on: [], attempts: [["critic", "review", "pending"], ["writer", "initial", "succeeded"], ["writer", "revise", "pending"]],
      revisions: [`${unit}:draft:1`], decisions: ["request_changes"], intents: ["pending", "pending", "pending"], missing: null });
});

test("a run's attempts read with the standing of the intent that carries each", async () => {
  const { run_id, action } = await reviewedRun();
  const attempts = await listRunAttempts(authority.db, run_id);
  const writer = attempts.find((item) => item.attempt.action_id === action);
  expect({ count: attempts.length, every_carried: attempts.every((item) => item.intent !== null), writer: writer?.intent?.status })
    .toEqual({ count: 3, every_carried: true, writer: "pending" });
});

test("an artifact's history holds its revisions oldest first and the decisions on them", async () => {
  const { run_id, unit, action } = await reviewedRun();
  await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "second" },
    by: `${unit}:writer:Revise:ChangesRequested`, predecessor: `${unit}:draft:1` }, writer: executor(action) });
  const history = await readArtifactHistory(authority.db, { run_id, unit_id: unit, artifact: "draft" });
  const none = await readArtifactHistory(authority.db, { run_id, unit_id: unit, artifact: "critique" });
  expect({ revisions: history?.revisions.map((revision) => revision.body), decisions: history?.decisions.map((decision) => String(decision.target_revision_id)),
    none, missing: await readArtifactHistory(authority.db, { run_id, unit_id: `${run_id}/missing`, artifact: "draft" }) })
    .toEqual({ revisions: [{ title: "T", body: "first" }], decisions: [`${unit}:draft:1`], none: { revisions: [], decisions: [] }, missing: null });
});

test("history pages newest first with each event's writer and wanted actions; a unit's history omits run-level events", async () => {
  const { run_id, unit } = await reviewedRun();
  const first = await readHistory(authority.db, { run_id, unit_id: null, after: null, limit: 3 });
  const rest = await readHistory(authority.db, { run_id, unit_id: null, after: first.next, limit: 10 });
  const unit_only = await readHistory(authority.db, { run_id, unit_id: unit, after: null, limit: 10 });
  const kinds = [...first.items, ...rest.items].map((item) => item.event.payload.kind);
  expect({ kinds, last_page: rest.next, launch_writer: rest.items.at(-1)?.event.writer.kind,
    decided_wanted: first.items[0]?.wanted.flatMap((item) => item.actions.map((wanted) => wanted.kind === "run_worker" ? wanted.mode.kind : wanted.kind)),
    unit_kinds: unit_only.items.map((item) => item.event.payload.kind) })
    .toEqual({ kinds: ["operator_decided", "worker_ended", "revision_published", "worker_started", "launched"], last_page: null, launch_writer: "operator",
      decided_wanted: ["revise"], unit_kinds: ["operator_decided", "worker_ended", "revision_published", "worker_started"] });
});

test("a unit's diagnostics hold its intents' bookkeeping and the events step refused", async () => {
  const { run_id, unit } = await reviewedRun();
  const diagnostics = await readUnitDiagnostics(authority.db, { run_id, unit_id: unit });
  expect({ intents: diagnostics?.intents.length, rejected: diagnostics?.rejected.map((receipt) => receipt.result.kind),
    missing: await readUnitDiagnostics(authority.db, { run_id, unit_id: `${run_id}/missing` }) })
    .toEqual({ intents: 3, rejected: ["rejected"], missing: null });
});

test("review candidates are active reviewed units of live runs, with each artifact's latest revision and its decisions", async () => {
  const { run_id, unit } = await reviewedRun();
  const cancelled = await reviewedRun();
  await submitter(authority)({ run_id: cancelled.run_id, event: { kind: "cancel_requested" } });
  const page = await listReviewCandidates(authority.db, { run_id, after: null, limit: 10 });
  const gone = await listReviewCandidates(authority.db, { run_id: cancelled.run_id, after: null, limit: 10 });
  const all = await listReviewCandidates(authority.db, { run_id: null, after: null, limit: 1 });
  expect({ units: page.items.map((item) => String(item.unit.id)), latest: page.items[0]?.latest.map((revision) => String(revision.id)),
    decisions: page.items[0]?.decisions.map((decision) => decision.decision), has_reviews: Object.keys(page.items[0]?.workflow.stages.document?.reviews ?? {}),
    gone: gone.items, pages: all.next !== null })
    .toEqual({ units: [unit], latest: [`${unit}:draft:1`], decisions: ["request_changes"], has_reviews: ["editor"], gone: [], pages: true });
});

test("a definition graph lists each declared unit with its dependencies as edges", () => {
  const graph = selectDefinitionGraph(sampleWorkflow("fan-out"));
  expect({ nodes: graph.nodes.map((node) => [node.key, node.scope, node.depends_on]), edges: graph.edges }).toEqual({
    nodes: [["prepare", "prepare", []], ["work", "work", ["prepare"]], ["work/item", "item", []]],
    edges: [{ from: "prepare", to: "work" }] });
});
