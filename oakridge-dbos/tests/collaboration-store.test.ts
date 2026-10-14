import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { Hono } from "hono";
import { sql } from "kysely";
import { collaborationHandlers } from "../src/http/collaboration";
import { operatorWriterFromCredential } from "../src/http/control-auth";
import { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread, readCollaborationThreads,
  readThreadRevision, recordCollaborationDelivery } from "../src/storage/collaboration-store";
import { listOwedIntents, settleIntent } from "../src/storage/executor-store";
import { deleteRun } from "../src/storage/run-deletion";
import { actionOf, executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

/** A run whose draft has `count` revisions, each the predecessor of the next. */
async function drafted(count: number): Promise<{ readonly run_id: RunId; readonly unit: string; readonly revisions: readonly string[] }> {
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  const unit = unitOf(run_id, "document");
  const action = await actionOf(authority, run_id, "writer");
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  const revisions: string[] = [];
  for (let index = 1; index <= count; index++) {
    await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: `v${index}` },
      predecessor: revisions.at(-1) ?? null, by: action }, writer: executor(action) });
    revisions.push(`${unit}:draft:${index}`);
  }
  return { run_id, unit, revisions };
}
const thread = (run_id: string, unit: string, revision_id: string, key = "k") => createCollaborationThread(authority.db,
  { id: `thread:${collaborationRecordId(revision_id, key)}`, run_id, unit_id: unit, revision_id, context: { title: "Note", anchor: null } });

test("a thread opens on the latest revision, replays its request key and refuses a changed one", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const created = await thread(run_id, unit, revisions[0]!);
  const replayed = await thread(run_id, unit, revisions[0]!);
  const conflicting = await createCollaborationThread(authority.db, { id: created.kind === "written" ? created.value.id : "", run_id,
    unit_id: unit, revision_id: revisions[0]!, context: { title: "Other", anchor: null } });
  const missing = await thread(run_id, unit, `${unit}:draft:9`);
  expect([created.kind, replayed.kind, conflicting.kind, missing.kind]).toEqual(["written", "replayed", "conflict", "missing"]);
});

test("a superseded revision refuses new threads, messages and review items", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const opened = await thread(run_id, unit, revisions[0]!);
  if (opened.kind !== "written") throw new Error("thread not written");
  const action = await actionOf(authority, run_id, "writer");
  await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "v2" },
    predecessor: revisions[0]!, by: action }, writer: executor(action) });
  const late_thread = await thread(run_id, unit, revisions[0]!, "late");
  const message = await addCollaborationMessage(authority.db, { id: "m-late", run_id, unit_id: unit, thread_id: opened.value.id,
    body: { text: "hi", author: "op" } });
  const item = await addReviewItem(authority.db, { id: "r-late", run_id, unit_id: unit, thread_id: opened.value.id,
    body: { title: "t", detail: "d", status: "open" } });
  expect([late_thread.kind, message.kind, item.kind]).toEqual(["superseded", "superseded", "superseded"]);
});

test("a message key keeps its ping intent: a changed ping is a conflict", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const opened = await thread(run_id, unit, revisions[0]!);
  if (opened.kind !== "written") throw new Error("thread not written");
  const first = await addCollaborationMessage(authority.db, { id: "m1", run_id, unit_id: unit, thread_id: opened.value.id, body: { text: "hi", author: "op", ping: false } });
  const changed = await addCollaborationMessage(authority.db, { id: "m1", run_id, unit_id: unit, thread_id: opened.value.id, body: { text: "hi", author: "op", ping: true } });
  expect([first.kind, changed.kind, await readThreadRevision(authority.db, { run_id, unit_id: unit, thread_id: opened.value.id })])
    .toEqual(["written", "conflict", revisions[0]]);
});

test("the thread view spans the revision chain, with write capability only on the latest and the last failed delivery", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const old_thread = await thread(run_id, unit, revisions[0]!);
  if (old_thread.kind !== "written") throw new Error("thread not written");
  await addCollaborationMessage(authority.db, { id: "m-old", run_id, unit_id: unit, thread_id: old_thread.value.id, body: { text: "hi", author: "op", ping: true } });
  await addReviewItem(authority.db, { id: "r-old", run_id, unit_id: unit, thread_id: old_thread.value.id, body: { title: "t", detail: "d", status: "open" } });
  const delivery = await recordCollaborationDelivery(authority.db, { id: "d-old", run_id, unit_id: unit, message_id: "m-old",
    payload: { status: "failed", session_id: null, reason: "no session", request_key: "k" } });
  const repeat = await recordCollaborationDelivery(authority.db, { id: "d-old", run_id, unit_id: unit, message_id: "m-old",
    payload: { status: "delivered", session_id: "sid", reason: null, request_key: "k" } });
  const action = await actionOf(authority, run_id, "writer");
  await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "v2" },
    predecessor: revisions[0]!, by: action }, writer: executor(action) });
  const latest = `${unit}:draft:2`;
  await thread(run_id, unit, latest, "new");
  const views = await readCollaborationThreads(authority.db, { run_id, unit_id: unit, revision_id: latest });
  expect({ repeat: repeat?.payload.status, delivery: delivery?.payload.status,
    views: views.map((view) => [view.artifact_revision_id, view.capabilities.can_write, view.messages.length, view.review_items.length, view.last_delivery_failure_reason]) })
    .toEqual({ repeat: "failed", delivery: "failed",
      views: [[revisions[0], false, 1, 1, "no session"], [latest, true, 0, 0, null]] });
});

test("a ping recorded while its run is being deleted waits for the deletion and finds the run gone", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const opened = await thread(run_id, unit, revisions[0]!);
  if (opened.kind !== "written") throw new Error("thread not written");
  await addCollaborationMessage(authority.db, { id: "m-race", run_id, unit_id: unit, thread_id: opened.value.id, body: { text: "hi", author: "op", ping: true } });
  for (const intent of await listOwedIntents(authority.db, run_id)) await settleIntent(authority.db, { intent_id: intent.id, status: "stopped", last_error: null });
  // Deletion pauses on the message, after it has already removed the run's deliveries.
  await sql`CREATE FUNCTION public.slow_message_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN OLD; END $$;
    CREATE TRIGGER slow_message_delete BEFORE DELETE ON authority.collaboration_message FOR EACH ROW EXECUTE FUNCTION public.slow_message_delete()`.execute(authority.db);
  try {
    const deleting = deleteRun(authority.db, run_id);
    await Bun.sleep(150);
    const delivery = await recordCollaborationDelivery(authority.db, { id: "d-race", run_id, unit_id: unit, message_id: "m-race",
      payload: { status: "failed", session_id: null, reason: "no session", request_key: "race" } });
    expect({ deleted: await deleting, delivery }).toEqual({ deleted: { kind: "deleted" }, delivery: null });
  } finally {
    await sql`DROP TRIGGER slow_message_delete ON authority.collaboration_message; DROP FUNCTION public.slow_message_delete()`.execute(authority.db);
  }
});

test("a thread view reads its revision chain in the same number of queries however long the chain", async () => {
  const queries = async (count: number): Promise<number> => {
    const { run_id, unit, revisions } = await drafted(count);
    let issued = 0;
    const counted = authority.db.withPlugin({ transformQuery: (args) => { issued++; return args.node; }, transformResult: async (args) => args.result });
    await readCollaborationThreads(counted, { run_id, unit_id: unit, revision_id: revisions.at(-1)! });
    return issued;
  };
  expect(await queries(6)).toBe(await queries(1));
});

test("a message's author is the credential that posted it, whatever the body claims", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const opened = await thread(run_id, unit, revisions[0]!);
  if (opened.kind !== "written") throw new Error("thread not written");
  const app = new Hono();
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/messages", collaborationHandlers({ db: authority.db }).addMessage);
  const headers = { "content-type": "application/json", authorization: "Bearer operator-token" };
  const path = [run_id, unit, opened.value.id].map(encodeURIComponent);
  const posted = await app.request(`/api/runs/${path[0]}/units/${path[1]}/threads/${path[2]}/messages`,
    { method: "POST", headers, body: JSON.stringify({ request_key: "k", text: "looks good", author: "someone-else" }) });
  const { message } = await posted.json() as { readonly message: { readonly body: { readonly author: string } } };
  expect({ status: posted.status, author: message.body.author })
    .toEqual({ status: 201, author: operatorWriterFromCredential(new Request("http://x", { headers })).subject });
});
