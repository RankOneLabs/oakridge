import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { Hono } from "hono";
import { collaborationHandlers } from "../src/http/collaboration";
import { operatorWriterFromCredential } from "../src/http/control-auth";
import { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread, readCollaborationThreads } from "../src/storage/collaboration-store";
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

test("a message key replays its text: a changed text is a conflict", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const opened = await thread(run_id, unit, revisions[0]!);
  if (opened.kind !== "written") throw new Error("thread not written");
  const message = (text: string) => addCollaborationMessage(authority.db, { id: "m1", run_id, unit_id: unit, thread_id: opened.value.id, body: { text, author: "op" } });
  const first = await message("hi");
  const replayed = await message("hi");
  const changed = await message("bye");
  expect([first.kind, replayed.kind, changed.kind]).toEqual(["written", "replayed", "conflict"]);
});

test("the thread view spans the revision chain, with write capability only on the latest", async () => {
  const { run_id, unit, revisions } = await drafted(1);
  const old_thread = await thread(run_id, unit, revisions[0]!);
  if (old_thread.kind !== "written") throw new Error("thread not written");
  await addCollaborationMessage(authority.db, { id: "m-old", run_id, unit_id: unit, thread_id: old_thread.value.id, body: { text: "hi", author: "op" } });
  await addReviewItem(authority.db, { id: "r-old", run_id, unit_id: unit, thread_id: old_thread.value.id, body: { title: "t", detail: "d", status: "open" } });
  const action = await actionOf(authority, run_id, "writer");
  await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "v2" },
    predecessor: revisions[0]!, by: action }, writer: executor(action) });
  const latest = `${unit}:draft:2`;
  await thread(run_id, unit, latest, "new");
  const views = await readCollaborationThreads(authority.db, { run_id, unit_id: unit, revision_id: latest });
  expect(views.map((view) => [view.artifact_revision_id, view.capabilities.can_write, view.messages.length, view.review_items.length]))
    .toEqual([[revisions[0], false, 1, 1], [latest, true, 0, 0]]);
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
