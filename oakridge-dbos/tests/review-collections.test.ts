import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Event, WorkerResult } from "../src/core-client/core-types";
import type { RunId, UnitId } from "../src/domain/primitives";
import { selectRunInboxItems, type InboxItem } from "../src/projections/inbox";
import { selectOperatorFrame, type OperatorEventRow } from "../src/projections/operator-event";
import { readLatestRevisionId, readRun } from "../src/storage/read-store";
import { reportWorker } from "../src/workflows/executor-ingress";
import { actionOf, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

/**
 * Review and collection semantics through commit and Postgres (validation
 * spec §3.3): an empty collection completes, a reviewer waits for its
 * subject's creator, a terminal run or unit refuses further events, and a
 * run that cannot advance surfaces as a stall (D-V4).
 */

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });

const REPOSITORY = { repository_path: "/srv/repo", base_branch: "main", expected_head: null };
const WORKSPACE = { repository_path: "/srv/repo", push_remote_owner: "owner", head: "abc" };
const deps = () => ({ db: authority.db, core: authority.core, wake: () => undefined });

/** One executor report on an attempt's first seq; returns the refusal, if any. */
async function report(run_id: RunId, action_id: string, input: Parameters<typeof reportWorker>[1]["report"]): Promise<string | null> {
  const committed = await reportWorker(deps(), { run_id, attempt: { action_id, seq: 1 }, report: input });
  if (!committed.ok) throw new Error(committed.error.detail);
  return committed.value.kind === "rejected" ? committed.value.reason : null;
}
/** Fan-out launched over `items`, and its `git` worker's workspace reported: what starts the collection group. */
async function fanOutPrepared(items: unknown): Promise<{ readonly run_id: RunId; readonly refusal: string | null }> {
  const { bundle_id } = await pinSample(authority, "fan-out");
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { repository: REPOSITORY, items } });
  const git = await actionOf(authority, run_id, "git");
  await report(run_id, git, { kind: "started", session_id: null, publication_secret_hash: null });
  const refusal = await report(run_id, git, { kind: "published", unit: unitOf(run_id, "prepare"), artifact: "workspace", body: WORKSPACE, predecessor: null });
  return { run_id, refusal };
}
const statusOf = async (run_id: RunId, unit: string) => (await authority.db.selectFrom("authority.unit").select("status")
  .where("run_id", "=", run_id).where("id", "=", unit).executeTakeFirstOrThrow()).status;
const runStatus = async (run_id: RunId) => (await authority.db.selectFrom("authority.unit").select("status").where("run_id", "=", run_id).where("id", "=", run_id)
  .executeTakeFirstOrThrow()).status;
const inboxOf = async (run_id: RunId): Promise<readonly InboxItem[]> => {
  const read = await readRun(authority.db, run_id);
  if (!read) throw new Error(`run ${run_id} is not readable`);
  return selectRunInboxItems(read);
};
const stalledDetails = async (run_id: RunId) => (await inboxOf(run_id)).flatMap((item) => item.kind === "stalled" ? [item.detail] : []);

// ------------------------------------------------------ empty collections -----

test("a collection over an empty list completes its group, and the run with it", async () => {
  const { run_id, refusal } = await fanOutPrepared([]);
  expect({ refusal, work: await statusOf(run_id, unitOf(run_id, "work")), run: (await runStatus(run_id)).kind })
    .toEqual({ refusal: null, work: { kind: "done", outcome: { results: [] } }, run: "done" });
});

// ------------------------------------------------------- reviewer waits -----

/** Review-loop launched, its writer started and its draft published, still running. */
async function drafting(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly writer: string }> {
  const { bundle_id } = await pinSample(authority, "review-loop");
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  const unit = unitOf(run_id, "document");
  const writer = await actionOf(authority, run_id, "writer");
  await report(run_id, writer, { kind: "started", session_id: null, publication_secret_hash: null });
  await report(run_id, writer, { kind: "published", unit, artifact: "draft", body: { title: "T", body: "A long draft" }, predecessor: null });
  return { run_id, unit, writer };
}
const workersWithIntents = async (run_id: RunId) => (await authority.db.selectFrom("authority.effect_intent as intent")
  .innerJoin("authority.attempt as attempt", (join) => join.onRef("attempt.run_id", "=", "intent.run_id").onRef("attempt.action_id", "=", "intent.action_id"))
  .select("attempt.worker").distinct().where("intent.run_id", "=", run_id).orderBy("attempt.worker").execute()).map((row) => row.worker);

test("a reviewer is wanted only once its subject's creator has ended its attempt", async () => {
  const { run_id, writer } = await drafting();
  const while_writing = await workersWithIntents(run_id);
  await report(run_id, writer, { kind: "ended", result: { kind: "succeeded" } });
  expect({ while_writing, ended: await workersWithIntents(run_id) }).toEqual({ while_writing: ["writer"], ended: ["critic", "writer"] });
});

// ------------------------------------------------------- terminal state -----

test("a done run refuses cancel and stays done", async () => {
  const { run_id, unit, writer } = await drafting();
  await report(run_id, writer, { kind: "ended", result: { kind: "succeeded" } });
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:1`, payload: {} } });
  const cancel = await submit({ run_id, event: { kind: "cancel_requested" } });
  expect({ cancel: cancel.ok && cancel.value, run: (await runStatus(run_id)).kind })
    .toEqual({ cancel: { kind: "rejected", reason: "run is done" }, run: "done" });
});

test("a cancelled unit refuses a decision and a retry", async () => {
  const { run_id, unit, writer } = await drafting();
  const failed: WorkerResult = { kind: "failed", code: "oops", detail: "failed" };
  await report(run_id, writer, { kind: "ended", result: failed });
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "cancel_requested" } });
  const outcome = async (event: Event) => {
    const committed = await submit({ run_id, event });
    return committed.ok ? committed.value : committed.error;
  };
  expect({
    decision: await outcome({ kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:1`, payload: {} }),
    retry: await outcome({ kind: "retry_requested", unit, worker: "writer" }),
  }).toEqual({ decision: { kind: "rejected", reason: "unit is not active" }, retry: { kind: "rejected", reason: "unit is not active" } });
});

// --------------------------------------------------------------- stalls -----

const DUPLICATED = [{ key: "same", text: "one", after: [] }, { key: "same", text: "two", after: [] }];

test("an event refused because its group cannot materialize stalls the run at that group, with the reason and the event", async () => {
  const { run_id, refusal } = await fanOutPrepared(DUPLICATED);
  const work = unitOf(run_id, "work");
  const read = await readRun(authority.db, run_id);
  expect({ refusal, inbox: await inboxOf(run_id), refused: read?.stalls.map((stall) => [stall.unit_id, stall.stall.unit_id, stall.stall.event.kind]) })
    .toEqual({
      refusal: `run stalled at ${work}: collection item has illegal or duplicate key`,
      inbox: [{ kind: "stalled", run_id, unit_id: work as UnitId,
        detail: `run stalled at ${work}: collection item has illegal or duplicate key (refused revision_published)` }],
      refused: [[unitOf(run_id, "prepare"), work, "revision_published"]],
    });
});

test("a stall stands until an event commits on the refused event's unit, and a cancel ends it", async () => {
  const { run_id } = await fanOutPrepared(DUPLICATED);
  const stalled = await stalledDetails(run_id);
  // The git worker ends without its workspace accepted: an event committed on prepare.
  await report(run_id, await actionOf(authority, run_id, "git"), { kind: "ended", result: { kind: "succeeded" } });
  const moved_on = await stalledDetails(run_id);
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  const read = await readRun(authority.db, run_id);
  expect({ stalled: stalled.length, moved_on, cancelled: read ? selectRunInboxItems(read) : null })
    .toEqual({ stalled: 1, moved_on: ["git failed: worker ended before publishing every artifact"], cancelled: [] });
});

// --------------------------------------------------------------- faults -----

/** Review-loop launched with its document unit's stage renamed out of the definition: any event that advances it faults. */
async function inconsistent(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly writer: string }> {
  const { bundle_id } = await pinSample(authority, "review-loop");
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  const unit = unitOf(run_id, "document");
  await authority.db.updateTable("authority.unit").set({ stage: "absent" }).where("run_id", "=", run_id).where("id", "=", unit).execute();
  return { run_id, unit, writer: await actionOf(authority, run_id, "writer") };
}

test("a commit fault is recorded against the run, surfaces as a stall on its unit, and refreshes the run's views", async () => {
  const { run_id, unit, writer } = await inconsistent();
  const committed = await reportWorker(deps(), { run_id, attempt: { action_id: writer, seq: 1 },
    report: { kind: "started", session_id: null, publication_secret_hash: null } });
  const rows = await authority.db.selectFrom("authority.operator_event").select(["id", "commit_txid", "payload"])
    .where("run_id", "=", run_id).where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  const [row] = rows;
  expect({ faulted: !committed.ok, stalled: (await inboxOf(run_id)).map((item): string[] => [item.kind, item.unit_id]),
    frame: row ? selectOperatorFrame({ ...row, commit_txid: String(row.commit_txid) } as OperatorEventRow) : null })
    .toEqual({ faulted: true, stalled: [["stalled", unit]],
      frame: { event: "invalidate", data: { kind: "invalidate", target: "run", run_id } } });
});

test("a fault stands until an event commits on its unit", async () => {
  const { run_id, unit, writer } = await inconsistent();
  await reportWorker(deps(), { run_id, attempt: { action_id: writer, seq: 1 }, report: { kind: "started", session_id: null, publication_secret_hash: null } });
  const faulted = await stalledDetails(run_id);
  await authority.db.updateTable("authority.unit").set({ stage: "document" }).where("run_id", "=", run_id).where("id", "=", unit).execute();
  await report(run_id, writer, { kind: "started", session_id: null, publication_secret_hash: null });
  await report(run_id, writer, { kind: "published", unit, artifact: "draft", body: { title: "T", body: "B" },
    predecessor: await readLatestRevisionId(authority.db, { run_id, unit_id: unit, artifact: "draft" }) });
  expect({ faulted: faulted.length, after: await stalledDetails(run_id) }).toEqual({ faulted: 1, after: [] });
});

test("a commit fault on a worker report names its unit", async () => {
  const { run_id, unit, writer } = await inconsistent();
  await reportWorker(deps(), { run_id, attempt: { action_id: writer, seq: 1 }, report: { kind: "started", session_id: null, publication_secret_hash: null } });
  const fault = await authority.db.selectFrom("authority.operator_event").select("payload").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).executeTakeFirstOrThrow();
  expect(fault.payload.kind === "commit_fault" && { unit: fault.payload.data.unit_id as string | null, event: fault.payload.data.event.kind })
    .toEqual({ unit, event: "worker_started" });
});

test("a fault the core found advancing another unit shows on that unit", async () => {
  const { bundle_id } = await pinSample(authority, "fan-out");
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { repository: REPOSITORY, items: [] } });
  const work = unitOf(run_id, "work");
  await authority.db.updateTable("authority.unit").set({ stage: "absent" }).where("run_id", "=", run_id).where("id", "=", work).execute();
  const git = await actionOf(authority, run_id, "git");
  await report(run_id, git, { kind: "started", session_id: null, publication_secret_hash: null });
  const published = await reportWorker(deps(), { run_id, attempt: { action_id: git, seq: 1 },
    report: { kind: "published", unit: unitOf(run_id, "prepare"), artifact: "workspace", body: WORKSPACE, predecessor: null } });
  expect({ faulted: !published.ok, stalled: (await inboxOf(run_id)).map((item): string[] => [item.kind, item.unit_id]) })
    .toEqual({ faulted: true, stalled: [["stalled", work]] });
});

test("a retried request whose fault still stands records it once", async () => {
  const { run_id, writer } = await inconsistent();
  for (let retry = 0; retry < 3; retry += 1)
    await reportWorker(deps(), { run_id, attempt: { action_id: writer, seq: 1 }, report: { kind: "started", session_id: null, publication_secret_hash: null } });
  const faults = await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect(faults.length).toBe(1);
});
