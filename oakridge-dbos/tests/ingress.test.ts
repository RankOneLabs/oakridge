/**
 * Ingress (rescue spec R2, part 1 §7.1) against a migrated database: every
 * route resolves its writer from the credential and never from the body (K4),
 * and each makes exactly one commit.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { Writer } from "../src/core-client/core-types";
import type { RunId } from "../src/domain/primitives";
import { createHttpApp } from "../src/http/app";
import { browserWritePolicy } from "../src/http/browser-write-policy";
import { launchRunId } from "../src/storage/commit";
import { reportWorker, type WorkerReport } from "../src/workflows/executor-ingress";
import { actionOf, openAuthority, pinSample, unitOf, type Authority } from "./authority-fixture";

const CONTROL_TOKEN = "ingress-test-token";
const OPERATOR_SUBJECT = `credential:${createHash("sha256").update(CONTROL_TOKEN).digest("hex").slice(0, 24)}`;
const FORGED: Writer = { kind: "engine" };

let authority: Authority;
let app: Hono;
let digest: string;
beforeAll(async () => {
  authority = await openAuthority();
  ({ digest } = await pinSample(authority));
  app = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test",
    access: { kind: "token_required", token: CONTROL_TOKEN }, write_policy: browserWritePolicy([]) });
});
afterAll(async () => { await authority.close(); });

const path = (...segments: readonly string[]): string => `/api/${segments.map(encodeURIComponent).join("/")}`;
function send(method: string, url: string, body: unknown, authorization: string | null = `Bearer ${CONTROL_TOKEN}`): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== null) headers.authorization = authorization;
  return Promise.resolve(app.request(url, { method, headers, body: JSON.stringify(body) }));
}
const events = (run_id: RunId) => authority.db.selectFrom("authority.event").select(["payload", "writer"])
  .where("run_id", "=", run_id).orderBy("created_at").execute();
const writerAction = (run_id: RunId): Promise<string> => actionOf(authority, run_id, "writer");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function launched(): Promise<RunId> {
  const request_id = crypto.randomUUID();
  const response = await send("POST", "/api/runs", { request_id, digest, input: { topic: "Oakridge" } });
  if (response.status !== 201) throw new Error(`launch failed: ${response.status} ${await response.text()}`);
  return launchRunId(request_id);
}
async function report(run_id: RunId, report: WorkerReport): Promise<void> {
  const action_id = await writerAction(run_id);
  const attempt = await authority.db.selectFrom("authority.attempt").select("seq").where("run_id", "=", run_id)
    .where("action_id", "=", action_id).orderBy("seq", "desc").executeTakeFirstOrThrow();
  const result = await reportWorker({ db: authority.db, core: authority.core, wake: () => undefined }, { run_id, attempt: { action_id, seq: attempt.seq }, report });
  if (!result.ok || (result.value.kind !== "committed" && result.value.kind !== "replayed")) throw new Error(`report refused: ${JSON.stringify(result)}`);
}
/** A launched run whose writer attempt is running in kbbl session `sid`, holding `secret`. */
async function sessionRun(secret: string, sid = `sid-${crypto.randomUUID()}`): Promise<RunId> {
  const run_id = await launched();
  await report(run_id, { kind: "started", session_id: sid, publication_secret_hash: sha256(secret) });
  return run_id;
}
const publish = (run_id: RunId, body: unknown, authorization: string | null, unit = unitOf(run_id, "document")) =>
  send("PUT", path("runs", run_id, "units", unit, "artifacts", "draft"), body, authorization);
const draft = (overrides: Record<string, unknown> = {}) => ({ request_id: crypto.randomUUID(), body: { title: "T", body: "B" }, ...overrides });

test("K4: launch takes its writer from the control token, not the body", async () => {
  const request_id = crypto.randomUUID();
  await send("POST", "/api/runs", { request_id, digest, input: { topic: "Oakridge" }, writer: FORGED });
  expect((await events(launchRunId(request_id))).map((event) => event.writer)).toEqual([{ kind: "operator", subject: OPERATOR_SUBJECT }]);
});

test("K4: cancel takes its writer from the control token, not the body", async () => {
  const run_id = await launched();
  await send("POST", path("runs", run_id, "cancel"), { request_id: crypto.randomUUID(), writer: FORGED });
  expect((await events(run_id)).at(-1)?.writer).toEqual({ kind: "operator", subject: OPERATOR_SUBJECT });
});

test("K4: retry takes its writer from the control token, not the body", async () => {
  const run_id = await launched();
  await report(run_id, { kind: "started", session_id: "sid", publication_secret_hash: null });
  await report(run_id, { kind: "ended", result: { kind: "failed", code: "boom", detail: "test" } });
  const response = await send("POST", path("runs", run_id, "units", unitOf(run_id, "document"), "workers", "writer", "retry"),
    { request_id: crypto.randomUUID(), writer: FORGED });
  expect({ status: response.status, writer: (await events(run_id)).at(-1)?.writer })
    .toEqual({ status: 201, writer: { kind: "operator", subject: OPERATOR_SUBJECT } });
});

test("K4: decide takes its writer from the control token, not the body", async () => {
  const run_id = await sessionRun("decide-secret");
  const unit = unitOf(run_id, "document");
  await publish(run_id, draft(), "Bearer decide-secret");
  const response = await send("POST", path("runs", run_id, "units", unit, "reviews", "editor", "decide"),
    { request_id: crypto.randomUUID(), decision: "approve", target: `${unit}:draft:1`, payload: {}, writer: FORGED });
  const last = (await events(run_id)).at(-1);
  expect({ status: response.status, kind: last?.payload.kind, writer: last?.writer })
    .toEqual({ status: 201, kind: "operator_decided", writer: { kind: "operator", subject: OPERATOR_SUBJECT } });
});

test("a decision addressed to a group unit is rejected without recording a commit fault", async () => {
  const run_id = await launched();
  const response = await send("POST", path("runs", run_id, "units", run_id, "reviews", "editor", "decide"),
    { request_id: crypto.randomUUID(), decision: "approve", target: "missing", payload: {} });
  const faults = await authority.db.selectFrom("authority.operator_event").select("payload").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect({ status: response.status, body: await response.json(), faults: faults.length }).toEqual({
    status: 409, body: { kind: "rejected", reason: "unit is a group" }, faults: 0,
  });
});

test("a retry addressed to a group unit is rejected without recording a commit fault", async () => {
  const run_id = await launched();
  const response = await send("POST", path("runs", run_id, "units", run_id, "workers", "writer", "retry"),
    { request_id: crypto.randomUUID() });
  const faults = await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect({ status: response.status, body: await response.json(), faults: faults.length }).toEqual({
    status: 409, body: { kind: "rejected", reason: "unit is a group" }, faults: 0,
  });
});

test("an operator revision addressed to a group unit is rejected without recording a commit fault", async () => {
  const run_id = await launched();
  const response = await publish(run_id, draft(), `Bearer ${CONTROL_TOKEN}`, run_id);
  const faults = await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect({ status: response.status, body: await response.json(), faults: faults.length }).toEqual({
    status: 409, body: { kind: "rejected", reason: "unit is a group" }, faults: 0,
  });
});

test("K4: publish takes its writer and its `by` from the session secret, not the body", async () => {
  const sid = `sid-${crypto.randomUUID()}`;
  const run_id = await sessionRun("publish-secret", sid);
  const response = await publish(run_id, draft({ writer: { kind: "operator", subject: "forged" }, by: "someone-else" }), "Bearer publish-secret");
  const last = (await events(run_id)).at(-1);
  expect({ status: response.status, writer: last?.writer, by: last?.payload.kind === "revision_published" ? last.payload.by : null })
    .toEqual({ status: 201, writer: { kind: "session", session: sid, attempt: await writerAction(run_id) }, by: await writerAction(run_id) });
});

test("K4: an executor report is written by the executor, bound to the attempt it reports", async () => {
  const run_id = await sessionRun("executor-secret");
  expect((await events(run_id)).at(-1)?.writer).toEqual({ kind: "executor", attempt: await writerAction(run_id) });
});

test("K4: every recorded event carries a writer of a known kind", async () => {
  const rows = await authority.db.selectFrom("authority.event").select("writer").execute();
  expect({ has_events: rows.length > 0, unknown: rows.filter((row) => !["operator", "session", "executor", "engine"].includes(row.writer?.kind)) })
    .toEqual({ has_events: true, unknown: [] });
});

test("launch produces exactly one event", async () => {
  expect((await events(await launched())).length).toBe(1);
});

test("cancel produces exactly one event", async () => {
  const run_id = await launched();
  const before = (await events(run_id)).length;
  await send("POST", path("runs", run_id, "cancel"), { request_id: crypto.randomUUID() });
  expect((await events(run_id)).length - before).toBe(1);
});

test("retry produces exactly one event", async () => {
  const run_id = await launched();
  await report(run_id, { kind: "started", session_id: "sid", publication_secret_hash: null });
  await report(run_id, { kind: "ended", result: { kind: "failed", code: "boom", detail: "test" } });
  const before = (await events(run_id)).length;
  await send("POST", path("runs", run_id, "units", unitOf(run_id, "document"), "workers", "writer", "retry"), { request_id: crypto.randomUUID() });
  expect((await events(run_id)).length - before).toBe(1);
});

test("publish succeeds with the session secret", async () => {
  const run_id = await sessionRun("good-secret");
  const response = await publish(run_id, draft(), "Bearer good-secret");
  const revisions = await authority.db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id).execute();
  expect({ status: response.status, revisions: revisions.map((revision) => revision.id) })
    .toEqual({ status: 201, revisions: [`${unitOf(run_id, "document")}:draft:1`] });
});

test("publish fails without a secret or with a wrong one", async () => {
  const run_id = await sessionRun("only-secret");
  const statuses = await Promise.all([null, "Bearer wrong-secret"]
    .map(async (authorization) => (await publish(run_id, draft(), authorization)).status));
  const revisions = await authority.db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id).execute();
  expect({ statuses, revisions: revisions.length }).toEqual({ statuses: [401, 401], revisions: 0 });
});

test("D2: the control token on the publish route is the operator's edit, which names no attempt", async () => {
  const run_id = await sessionRun("edit-secret");
  const response = await publish(run_id, draft({ by: "forged" }), `Bearer ${CONTROL_TOKEN}`);
  const last = (await events(run_id)).at(-1);
  const revision = await authority.db.selectFrom("authority.artifact_revision").select("by_id").where("run_id", "=", run_id).executeTakeFirst();
  expect({ status: response.status, writer: last?.writer, by: last?.payload.kind === "revision_published" ? last.payload.by : "absent",
    by_id: revision?.by_id }).toEqual({ status: 201, writer: { kind: "operator", subject: OPERATOR_SUBJECT }, by: null, by_id: null });
});

test("D2: on a loopback-open control plane a publish with no secret is the operator's, and a wrong secret is still refused", async () => {
  const open = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test",
    access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
  const run_id = await sessionRun("open-secret");
  const put = (authorization: string | null) => Promise.resolve(open.request(path("runs", run_id, "units", unitOf(run_id, "document"), "artifacts", "draft"),
    { method: "PUT", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify(draft()) }));
  const statuses = [(await put("Bearer wrong-secret")).status, (await put(null)).status];
  expect({ statuses, writer: (await events(run_id)).at(-1)?.writer }).toEqual({ statuses: [401, 201], writer: { kind: "operator", subject: "local-control" } });
});

test("a session secret speaks for nothing once its attempt has ended", async () => {
  const run_id = await sessionRun("ended-secret");
  await report(run_id, { kind: "ended", result: { kind: "failed", code: "boom", detail: "test" } });
  expect((await publish(run_id, draft(), "Bearer ended-secret")).status).toBe(401);
});

test("a session secret does not publish into another unit or another run", async () => {
  const run_id = await sessionRun("scoped-secret");
  const other = await launched();
  const statuses = [(await publish(run_id, draft(), "Bearer scoped-secret", unitOf(run_id, "elsewhere"))).status,
    (await publish(other, draft(), "Bearer scoped-secret")).status];
  expect(statuses).toEqual([401, 401]);
});

test("the started report stores the publication secret's hash on the attempt it starts", async () => {
  const run_id = await sessionRun("stored-secret");
  const attempt = await authority.db.selectFrom("authority.attempt").select("publication_secret_hash")
    .where("run_id", "=", run_id).where("action_id", "=", await writerAction(run_id)).executeTakeFirstOrThrow();
  expect(attempt.publication_secret_hash).toBe(sha256("stored-secret"));
});

test("a decision on a stale revision is refused by step and records no event", async () => {
  const run_id = await sessionRun("stale-secret");
  const unit = unitOf(run_id, "document");
  await publish(run_id, draft(), "Bearer stale-secret");
  await publish(run_id, draft({ body: { title: "T", body: "second" }, predecessor: `${unit}:draft:1` }), "Bearer stale-secret");
  const before = (await events(run_id)).length;
  const response = await send("POST", path("runs", run_id, "units", unit, "reviews", "editor", "decide"),
    { request_id: crypto.randomUUID(), decision: "approve", target: `${unit}:draft:1`, payload: {} });
  expect({ status: response.status, added: (await events(run_id)).length - before }).toEqual({ status: 409, added: 0 });
});

test("an operator route refuses a request without the control token", async () => {
  const response = await send("POST", "/api/runs", { request_id: crypto.randomUUID(), digest, input: { topic: "Oakridge" } }, null);
  expect(response.status).toBe(401);
});
