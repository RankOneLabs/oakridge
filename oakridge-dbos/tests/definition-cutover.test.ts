import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import { createHttpApp } from "../src/http/app";
import { browserWritePolicy } from "../src/http/browser-write-policy";
import { launchRunId } from "../src/storage/commit";
import { readRun } from "../src/storage/read-store";
import type { DefinitionDetail, DefinitionPage } from "../src/projections/definition-view";
import { reportWorker } from "../src/workflows/executor-ingress";
import { commitTestDefinition, sampleDefinition } from "./committed-fixture";
import { actionOf, openAuthority, sampleWorkflow, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });
function app(core = authority.core) {
  return createHttpApp({ db: authority.db, core, wake: () => undefined, application_version: "cutover-test",
    access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
}
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

for (const kind of ["definition_not_launchable", "missing_prompt", "missing_operation_registry"] as const) {
  test(`${kind} names its operation and identifier and leaves no run`, async () => {
    const { definition_id } = await sampleDefinition();
    const request_id = crypto.randomUUID();
    const root = process.env.OAKRIDGE_DEFINITION_ROOT!;
    const object = JSON.parse(readFileSync(resolve(root, "workflows", `${definition_id}.json`), "utf8"));
    const reference = kind === "missing_prompt" ? Object.values(object.prompts)[0] : object.operation_registry_id;
    const path = kind === "definition_not_launchable" ? null : resolve(root, kind === "missing_prompt" ? "prompts" : "operations", `${reference}.${kind === "missing_prompt" ? "md" : "json"}`);
    const saved = path ? readFileSync(path) : null;
    try {
      if (path) unlinkSync(path);
      const response = await app().request("/api/runs", json({ request_id, definition_id: kind === "definition_not_launchable" ? "0".repeat(64) : definition_id, input: { topic: "store" } }));
      const body = await response.json() as { kind: string; operation: string; identifier: string };
      const run = await authority.db.selectFrom("authority.run").select("id").where("id", "=", launchRunId(request_id)).executeTakeFirst();
      expect({ status: response.status, kind: body.kind, operation: body.operation, identifier: body.identifier, run }).toEqual({
        status: kind === "definition_not_launchable" ? 404 : 422, kind,
        operation: kind === "definition_not_launchable" ? "read_launchable" : kind === "missing_prompt" ? "read_prompt" : "read_operation_registry",
        identifier: kind === "definition_not_launchable" ? "0".repeat(64) : reference, run: undefined });
    } finally { if (path && saved) writeFileSync(path, saved); }
  });
}

test("definition list and detail preserve authored schema and stage order", async () => {
  const source = sampleWorkflow("review-loop");
  const { definition_id } = await commitTestDefinition({ source: { ...source, workflow: "ordered",
    schemas: { z_schema: "text", a_schema: "text", ...source.schemas },
    stages: { z_stage: source.stages.document, a_stage: source.stages.document },
    run: { ...source.run, units: { document: { ...source.run.units.document, stage: "z_stage" } } } } });
  const detail = await (await app().request(`/api/definitions/${definition_id}`)).json() as DefinitionDetail;
  const list = await (await app().request("/api/definitions")).json() as DefinitionPage;
  expect([detail.bundle.schemas.slice(0, 2).map((schema) => schema.key), detail.bundle.stages,
    list.items.find((item) => item.definition_id === definition_id)?.bundle.stages])
    .toEqual([["z_schema", "a_schema"], ["z_stage", "a_stage"], ["z_stage", "a_stage"]]);
});

test("removed definition mutations return 404 and inspection routes still answer", async () => {
  const { definition_id } = await sampleDefinition();
  const removed = ["/api/definitions/compile", "/api/definitions", `/api/definitions/${definition_id}/archive`, `/api/definitions/${definition_id}/unarchive`];
  const statuses = await Promise.all(removed.map(async (path) => (await app().request(path, json({}))).status));
  const surviving = await Promise.all(["/api/definitions", `/api/definitions/${definition_id}`, "/api/prompts"].map(async (path) => (await app().request(path)).status));
  expect({ statuses, surviving }).toEqual({ statuses: [404, 404, 404, 404], surviving: [200, 200, 200] });
});

test("HTTP publication, operator edit and decision recover from exact committed inputs on a fresh core", async () => {
  const { definition_id } = await sampleDefinition();
  const response = await app().request("/api/runs", json({ request_id: crypto.randomUUID(), definition_id, input: { topic: "store" } }));
  const { run_id } = await response.json() as { run_id: import("../src/domain/primitives").RunId };
  const unit = unitOf(run_id, "document");
  const action_id = await actionOf(authority, run_id, "writer");
  const secret = "publication-test-secret";
  const report = (value: Parameters<typeof reportWorker>[1]["report"]) => reportWorker({ ...authority, wake: () => undefined },
    { run_id, attempt: { action_id, seq: 1 }, report: value });
  await report({ kind: "started", session_id: "cutover-session", publication_secret_hash: new Bun.CryptoHasher("sha256").update(secret).digest("hex") });
  const path = `/api/runs/${run_id}/units/${encodeURIComponent(unit)}/artifacts/draft`;
  const publish = async (body: unknown, secret: string | null = null) => {
    const request = json(body);
    return app().request(path, { ...request, method: "PUT", headers: { ...request.headers, ...(secret ? { authorization: `Bearer ${secret}` } : { "x-oakridge-publisher": "operator" }) } });
  };
  const published = await publish({ request_id: crypto.randomUUID(), body: { title: "First", body: "Text" }, predecessor: null, subject: null }, secret);
  const edited = await publish({ request_id: crypto.randomUUID(), body: { title: "Edited", body: "Text" }, predecessor: `${unit}:draft:1`, subject: null });
  await report({ kind: "ended", result: { kind: "succeeded" } });
  const decided = await app().request(`/api/runs/${run_id}/units/${encodeURIComponent(unit)}/reviews/editor/decide`, json({ request_id: crypto.randomUUID(),
    decision: "request_changes", target: `${unit}:draft:2`, payload: { feedback: "Shorter" } }));
  const before = await readRun(authority.db, run_id);
  const restarted = CoreClient.start();
  if (!restarted.ok) throw new Error(restarted.error.detail.detail);
  try {
    const retry = await app(restarted.value).request(`/api/runs/${run_id}/units/${encodeURIComponent(unit)}/workers/writer/retry`, json({ request_id: crypto.randomUUID() }));
    // The pending revise is not a failed worker, so this is rejected after resolving and recompiling on the empty core.
    const after = await readRun(authority.db, run_id);
    const pinned = await app(restarted.value).request(`/api/runs/${run_id}/definition`);
    expect({ responses: [response.status, published.status, edited.status, decided.status, retry.status, pinned.status],
      definition_id: after?.run.definition_id, same_state: JSON.stringify(before?.units) === JSON.stringify(after?.units) })
      .toEqual({ responses: [201, 201, 201, 201, 409, 200], definition_id, same_state: true });
  } finally { restarted.value.close(); }
});
