import { sampleDefinition } from "./committed-fixture";
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
import { actionOf, openAuthority, unitOf, type Authority } from "./authority-fixture";

const CONTROL_TOKEN = "ingress-test-token";
const OPERATOR_SUBJECT = `credential:${createHash("sha256").update(CONTROL_TOKEN).digest("hex").slice(0, 24)}`;
const FORGED: Writer = { kind: "engine" };

let authority: Authority;
let app: Hono;
let definition_id: string;
beforeAll(async () => {
  authority = await openAuthority();
  ({ definition_id } = await sampleDefinition());
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
  const response = await send("POST", "/api/runs", { request_id, definition_id, input: { topic: "Oakridge" } });
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
  await send("POST", "/api/runs", { request_id, definition_id, input: { topic: "Oakridge" }, writer: FORGED });
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
    status: 409, body: { error: "unit is a group", code: "conflict" }, faults: 0,
  });
});

test("a retry addressed to a group unit is rejected without recording a commit fault", async () => {
  const run_id = await launched();
  const response = await send("POST", path("runs", run_id, "units", run_id, "workers", "writer", "retry"),
    { request_id: crypto.randomUUID() });
  const faults = await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect({ status: response.status, body: await response.json(), faults: faults.length }).toEqual({
    status: 409, body: { error: "unit is a group", code: "conflict" }, faults: 0,
  });
});

test("an operator revision addressed to a group unit is rejected without recording a commit fault", async () => {
  const run_id = await launched();
  const response = await publish(run_id, draft(), `Bearer ${CONTROL_TOKEN}`, run_id);
  const faults = await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  expect({ status: response.status, body: await response.json(), faults: faults.length }).toEqual({
    status: 409, body: { error: "unit is a group", code: "conflict" }, faults: 0,
  });
});

test("K4: publish takes its writer and its `by` from the session secret, not the body", async () => {
  const sid = `sid-${crypto.randomUUID()}`;
  const run_id = await sessionRun("publish-secret", sid);
  const response = await publish(run_id, draft({ writer: { kind: "operator", subject: "forged" }, by: "someone-else" }), "Bearer publish-secret");
  const last = (await events(run_id)).at(-1);
  expect({ status: response.status, writer: last?.writer, by: last?.payload.kind === "revision_published" ? last.payload.by : null })
    .toEqual({ status: 201, writer: { kind: "session", session: sid, attempt: await writerAction(run_id) }, by: { action: await writerAction(run_id), seq: 1 } });
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
  const revision = await authority.db.selectFrom("authority.artifact_revision").select("by_action_id").where("run_id", "=", run_id).executeTakeFirst();
  expect({ status: response.status, writer: last?.writer, by: last?.payload.kind === "revision_published" ? last.payload.by : "absent",
    by_action_id: revision?.by_action_id }).toEqual({ status: 201, writer: { kind: "operator", subject: OPERATOR_SUBJECT }, by: null, by_action_id: null });
});

test("D2: a loopback-open publication requires explicit operator intent when no session secret is supplied", async () => {
  const open = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test",
    access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
  const run_id = await sessionRun("open-secret");
  const put = (authorization: string | null, publisher?: string) => Promise.resolve(open.request(path("runs", run_id, "units", unitOf(run_id, "document"), "artifacts", "draft"),
    { method: "PUT", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}),
      ...(publisher ? { "x-oakridge-publisher": publisher } : {}) }, body: JSON.stringify(draft()) }));
  const statuses = [(await put("Bearer wrong-secret")).status, (await put("Bearer wrong-secret", "operator")).status,
    (await put(null)).status,
    (await put(null, "operator")).status];
  expect({ statuses, writer: (await events(run_id)).at(-1)?.writer }).toEqual({ statuses: [401, 401, 401, 201], writer: { kind: "operator", subject: "local-control" } });
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
  const response = await send("POST", "/api/runs", { request_id: crypto.randomUUID(), definition_id, input: { topic: "Oakridge" } }, null);
  expect(response.status).toBe(401);
});

import { Hono as IntegrationApp } from "hono";
import { installIngress } from "../src/http/ingress";
import { installReadModels } from "../src/http/read-models";
import type { PrIntegration } from "../src/domain/pr-integration";
import type { PrIntegrationHealth } from "../src/runtime/pr-launch-preflight";
import { readCommittedRunConfig } from "../src/storage/read-store";
import { openDatabase } from "../src/storage/database";
import { launch as launchLegacy } from "./authority-fixture";
import { readSkillIndex } from "../src/runtime/definition-store";

function integrationApp(integration: PrIntegration, health: PrIntegrationHealth = { kind: "healthy" }) {
  const app = new IntegrationApp();
  const deps = { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => true,
    pr_integration_default: integration, probe_pr_integration: async () => health };
  installIngress(app, deps);
  installReadModels(app, deps);
  return app;
}
async function integrationLaunch(app: IntegrationApp, selection?: PrIntegration, config?: unknown, name: "review-loop" | "development" = "review-loop") {
  const request_id = crypto.randomUUID();
  const { definition_id } = await sampleDefinition(name);
  const response = await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id, definition_id, input: { topic: "integration persistence" },
      ...(selection === undefined ? {} : { pr_integration: selection }), ...(config === undefined ? {} : { config }) }) });
  return { response, run_id: launchRunId(request_id) };
}

test("launch records the explicit integration, install default and none skill pins", async () => {
  const index = readSkillIndex();
  if (!index.ok) throw new Error(JSON.stringify(index.error));
  for (const selection of ["github-cli", undefined, "none"] as const) {
    const { response, run_id } = await integrationLaunch(integrationApp("gated-review"), selection);
    expect(response.status).toBe(201);
    const integration = selection ?? "gated-review";
    expect(await readCommittedRunConfig(authority.db, run_id)).toEqual({ state: "committed", config: {
      sessions: {}, grading_enabled: false, pr_integration: integration,
      pr_skill_digest: integration === "none" ? null : index.value[integration] } });
  }
});
test("client-supplied skill pin creates no authority run", async () => {
  const { response, run_id } = await integrationLaunch(integrationApp("none"), undefined, { pr_skill_digest: "forged" });
  expect({ status: response.status, run: await authority.db.selectFrom("authority.run").select("id").where("id", "=", run_id).executeTakeFirst() })
    .toEqual({ status: 400, run: undefined });
});
test("run read model exposes recorded and legacy integration", async () => {
  const app = integrationApp("none");
  const { response, run_id } = await integrationLaunch(app, "github-cli");
  expect(response.status).toBe(201);
  const result = await app.request(`/api/runs/${run_id}`);
  const body = await result.json();
  expect(body.pr_integration).toBe("github-cli");
  const legacy = await launchLegacy(authority, { definition_id: (await sampleDefinition()).definition_id,
    request_id: crypto.randomUUID(), input: { topic: "legacy" } });
  const legacyResponse = await app.request(`/api/runs/${legacy.run_id}`);
  expect((await legacyResponse.json()).pr_integration).toBe("gated-review");
});
test("legacy stored config resolves to gated-review with no skill pin", async () => {
  const legacy = await launchLegacy(authority, { definition_id: (await sampleDefinition()).definition_id,
    request_id: crypto.randomUUID(), input: { topic: "legacy settings" },
    config: { sessions: {}, grading_enabled: false } as import("../src/domain/run-config").RunConfig });
  expect(await readCommittedRunConfig(authority.db, legacy.run_id)).toEqual({ state: "committed", config: {
    sessions: {}, grading_enabled: false, pr_integration: "gated-review", pr_skill_digest: null } });
});
test("retry and a reopened database retain recorded pins despite a changed install default", async () => {
  const { response, run_id } = await integrationLaunch(integrationApp("github-cli"));
  expect(response.status).toBe(201);
  const before = await readCommittedRunConfig(authority.db, run_id);
  await report(run_id, { kind: "started", session_id: "integration-retry", publication_secret_hash: null });
  await report(run_id, { kind: "ended", result: { kind: "failed", code: "test_failure", detail: "retry pin" } });
  const changedDefaultApp = integrationApp("none");
  const retry = await changedDefaultApp.request(path("runs", run_id, "units", unitOf(run_id, "document"), "workers", "writer", "retry"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID() }) });
  expect(retry.status).toBe(201);
  const reopened = openDatabase(authority.url);
  try { expect(await readCommittedRunConfig(reopened, run_id)).toEqual(before); }
  finally { await reopened.destroy(); }
});
test("PR-dependent refusals leave no run and retain the selected integration", async () => {
  for (const [integration, health, kind] of [
    ["none", { kind: "healthy" }, "integration_none"],
    ["gated-review", { kind: "unconfigured", detail: "URL unset" }, "integration_unconfigured"],
    ["gated-review", { kind: "unreachable", detail: "closed port" }, "integration_unreachable"],
    ["github-cli", { kind: "unconfigured", detail: "gh absent" }, "integration_unconfigured"],
  ] as const) {
    const { response, run_id } = await integrationLaunch(integrationApp(integration, health), undefined, undefined, "development");
    expect({ status: response.status, body: await response.json(), run: await authority.db.selectFrom("authority.run").select("id").where("id", "=", run_id).executeTakeFirst() })
      .toMatchObject({ status: 422, body: { kind, integration }, run: undefined });
  }
});
test("review-loop launches with none and unreachable gated-review", async () => {
  for (const integration of ["none", "gated-review"] as const) {
    const { response } = await integrationLaunch(integrationApp(integration, { kind: "unreachable", detail: "offline" }));
    expect(response.status).toBe(201);
  }
});

test("a PR-dependent launch commits when its gated-review URL answers an HTTP error status", async () => {
  const { probePrIntegration } = await import("../src/runtime/compose");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 401 }) });
  try {
    const app = new IntegrationApp();
    installIngress(app, { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => true,
      pr_integration_default: "gated-review", probe_pr_integration: (integration) => probePrIntegration(integration, server.url.href) });
    const { definition_id } = await sampleDefinition("development");
    const response = await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: crypto.randomUUID(), definition_id, input: {
        title: "Reachable integration", spec: "test", final_merge_policy: "require_merge", primary_repository_key: "app",
        repositories: [{ key: "app", preparation: { checkout_root: "/tmp", expected_head: null },
          forge: { namespace: "oakridge-test", path: "app", build_base: "develop", final_base: "main" } }] } }) });
    expect(response.status).toBe(201);
    const { run_id } = await response.json();
    expect((await authority.db.selectFrom("authority.run").select("id").where("id", "=", run_id).executeTakeFirst())?.id).toBe(run_id);
  } finally { await server.stop(true); }
});

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "kysely";
import { commitEvent } from "../src/storage/commit";
import { parseRunConfig } from "../src/domain/run-config";

test("launch retries replay before defaults, skill pins and health, and reject changed client content", async () => {
  const { definition_id } = await sampleDefinition("development");
  const request_id = crypto.randomUUID();
  const body = { request_id, definition_id, input: {
    title: "Replay launch", spec: "test", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { checkout_root: "/tmp", expected_head: null },
      forge: { namespace: "oakridge-test", path: "app", build_base: "develop", final_base: "main" } }] } };
  const sendTo = (app: IntegrationApp, content: unknown) => app.request("/api/runs", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(content) });
  const original = await sendTo(integrationApp("gated-review"), body);
  expect(original.status).toBe(201);
  const receipt = await original.json();
  const run_id = launchRunId(request_id);
  const config = await readCommittedRunConfig(authority.db, run_id);
  const retryApp = new IntegrationApp();
  let probes = 0;
  installIngress(retryApp, { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => true,
    pr_integration_default: "none", probe_pr_integration: async () => { probes++; return { kind: "unreachable", detail: "offline" }; } });
  const unhealthyApp = new IntegrationApp();
  installIngress(unhealthyApp, { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => true,
    pr_integration_default: "gated-review", probe_pr_integration: async () => { probes++; return { kind: "unreachable", detail: "offline" }; } });
  const indexPath = resolve(process.env.OAKRIDGE_DEFINITION_ROOT!, "skills.json");
  const index = readFileSync(indexPath);
  try {
    writeFileSync(indexPath, "changed and unreadable skill index");
    for (const app of [retryApp, unhealthyApp]) {
      const retried = await sendTo(app, body);
      expect({ status: retried.status, body: await retried.json(), probes }).toEqual({ status: 200, body: receipt, probes: 0 });
    }
    for (const changed of [
      { ...body, input: { ...body.input, title: "other content" } },
      { ...body, config: { grading_enabled: true } },
      { ...body, pr_integration: "github-cli" },
      { ...body, pr_integration: "gated-review" },
      { ...body, definition_id: "0".repeat(64) },
      { ...body, project_id: "other-project" },
    ]) expect((await sendTo(retryApp, changed)).status).toBe(409);
  } finally { writeFileSync(indexPath, index); }
  expect(await readCommittedRunConfig(authority.db, run_id)).toEqual(config);
  expect((await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute()).length).toBe(1);
});

test("explicit-integration launch retries survive a changed install default", async () => {
  const { definition_id } = await sampleDefinition();
  const body = { request_id: crypto.randomUUID(), definition_id, input: { topic: "explicit replay" }, pr_integration: "github-cli" };
  const sendTo = (app: IntegrationApp) => app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const original = await sendTo(integrationApp("none"));
  const receipt = await original.json();
  const retried = await sendTo(integrationApp("gated-review", { kind: "unreachable", detail: "offline" }));
  expect({ status: retried.status, body: await retried.json() }).toEqual({ status: 200, body: receipt });
});

test("launch receipts from before client identity separation still replay with their recorded config", async () => {
  const { definition_id } = await sampleDefinition();
  const request_id = crypto.randomUUID();
  const run_id = launchRunId(request_id);
  const input = { topic: "old receipt" };
  const launched = await commitEvent({ db: authority.db, core: authority.core, wake: () => undefined }, {
    run_id, ingress_id: request_id, writer: { kind: "operator", subject: "local-control" }, event: { kind: "launched", input },
    launch: { definition_id, project_id: null, config: parseRunConfig({ pr_integration: "github-cli", pr_skill_digest: "old-pin" }) } });
  if (!launched.ok || launched.value.kind !== "committed") throw new Error(JSON.stringify(launched));
  const app = integrationApp("none");
  const sendTo = (config?: unknown) => app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id, definition_id, input, ...(config ? { config } : {}) }) });
  const replay = await sendTo();
  expect({ status: replay.status, body: await replay.json() }).toEqual({ status: 200,
    body: { kind: "committed", run_id, event_id: launched.value.event_id } });
  expect((await sendTo({ grading_enabled: true })).status).toBe(409);
});

test("malformed recorded settings have no provider and expose their error in run reads", async () => {
  const app = integrationApp("none");
  const { response, run_id } = await integrationLaunch(app);
  expect(response.status).toBe(201);
  await sql`UPDATE authority.run SET config = '{"pr_integration":"bogus"}'::jsonb WHERE id = ${run_id}`.execute(authority.db);
  const read = await app.request(`/api/runs/${run_id}`);
  expect(await read.json()).toMatchObject({ pr_integration: null, pr_skill_digest: null, config_error: "recorded run config is malformed" });
  const list = await app.request("/api/runs");
  expect((await list.json()).items.find((run: { readonly run_id: string }) => run.run_id === run_id))
    .toMatchObject({ pr_integration: null, config_error: "recorded run config is malformed" });
});

test("concurrent unchanged launches share one receipt even when server defaults differ", async () => {
  const { definition_id } = await sampleDefinition();
  const request_id = crypto.randomUUID();
  const body = { request_id, definition_id, input: { topic: "concurrent replay" } };
  const responses = await Promise.all(["none", "github-cli"].map((integration) => integrationApp(integration as PrIntegration).request("/api/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  const receipts = await Promise.all(responses.map((response) => response.json()));
  expect(receipts[0]).toEqual(receipts[1]);
  expect((await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", launchRunId(request_id)).execute()).length).toBe(1);
});
