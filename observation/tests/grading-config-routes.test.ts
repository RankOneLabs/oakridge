import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type JsonValue } from "../src/domain/primitives";
import { planRegistration } from "../src/grading/configuration";
import { createGradingConfigStore } from "../src/grading/configuration-store";
import { createGradingPublication, type GradingPublication, type PublicationError } from "../src/grading/publication";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { oakridgeProfile, oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { registerGradingConfigRoutes } from "../src/http/grading-config";
import { credentialsFromEnv } from "../src/http/ingest-auth";
import type { Database } from "../src/storage/database";
import { fixtureDefinitions } from "./grading-fixture";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(publicationOverride?: GradingPublication) {
  const root = await mkdtemp(join(tmpdir(), "config-routes-")); directories.push(root);
  const store = createGradingConfigStore(root);
  const registration = planRegistration([], oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const runtime = new RuntimeConfiguration(runtimeSnapshot({ version: null, hash: null, registration: registration.value,
    profile: oakridgeProfile([], registration.value.collector), applied_at: "2026-11-01T00:00:00Z" }));
  const credentials = credentialsFromEnv({ OBSERVATION_CONFIGURE_CREDENTIALS: '[{"token":"configure"}]',
    OBSERVATION_INGEST_CREDENTIALS: '[{"token":"ingest","producer":"oakridge","namespace":"n"}]',
    OBSERVATION_READ_CREDENTIALS: '[{"token":"read","producer":"oakridge","namespace":"n"}]',
    OBSERVATION_GRADE_CREDENTIALS: '[{"token":"grade","producer":"oakridge","namespace":"n","reviewer_id":"reviewer"}]' });
  let registrations = 0;
  const publication = publicationOverride ?? createGradingPublication({ store, runtime, db: {} as Database, registry: oakridgeGradingRegistry,
    credentials, env: {}, profile: (registration) => oakridgeProfile(registration.questions, registration.collector),
    register: async () => { registrations++; return ok(undefined); } });
  const app = new Hono();
  registerGradingConfigRoutes(app, { store, runtime, publication, registry: oakridgeGradingRegistry, credentials, env: {} });
  const request = (path: string, method = "GET", body?: unknown, token = "configure") => app.request(`/v1/grading-config/${path}`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const definitions = (await fixtureDefinitions()).map((entry) => ({ ...entry, evaluators: [] }));
  const save = (expected_draft_digest: string | null = null) => request("draft", "PUT", { expected_draft_digest,
    document: { status: "draft", definitions } });
  return { store, runtime, app, request, definitions, save, registrations: () => registrations };
}
for (const token of ["", "wrong", "ingest", "read", "grade"]) test(`all configuration routes refuse token ${token || "missing"}`, async () => {
  const h = await fixture();
  for (const [path, method] of [["draft", "GET"], ["draft", "PUT"], ["draft/validate", "POST"], ["versions", "GET"], ["versions/1", "GET"], ["publish", "POST"], ["runtime", "GET"]])
    expect((await h.request(path!, method, {}, token)).status).toBe(401);
});
test("configure credentials are global and reject tenant fields and duplicate capabilities", () => {
  expect(credentialsFromEnv({ OBSERVATION_CONFIGURE_CREDENTIALS: '[{"token":"configure"}]' }).configure).toEqual([{ token: "configure" }]);
  expect(() => credentialsFromEnv({ OBSERVATION_CONFIGURE_CREDENTIALS: '[{"token":"configure","namespace":"n"}]' })).toThrow("invalid observation configure");
  expect(() => credentialsFromEnv({ OBSERVATION_CONFIGURE_CREDENTIALS: '[{"token":"same"}]',
    OBSERVATION_READ_CREDENTIALS: '[{"token":"same","producer":"oakridge","namespace":"n"}]' })).toThrow("unique");
});
test("draft saves compare digests; validation leaves history and runtime untouched", async () => {
  const h = await fixture();
  expect(await (await h.request("draft")).json()).toBeNull();
  const saved = await (await h.save()).json() as { digest: string };
  const stale = await h.save();
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: expect.objectContaining({ code: "draft_conflict", current_digest: saved.digest }) })]);
  expect(await (await h.request("draft/validate", "POST")).json()).toEqual({ valid: true });
  expect([await h.store.listVersions(), h.runtime.current().hash, h.registrations()]).toEqual([ok([]), null, 0]);
});
test("publish exposes immutable version history, runtime identity, unchanged and stale version conflicts", async () => {
  const h = await fixture();
  const saved = await (await h.save()).json() as { digest: string };
  const body = { expected_draft_digest: saved.digest, expected_latest_version: null };
  const first = await h.request("publish", "POST", body);
  expect([first.status, await first.json()]).toEqual([201, expect.objectContaining({ outcome: "published", version: 1 })]);
  const stale = await h.request("publish", "POST", body);
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: expect.objectContaining({ code: "version_conflict", current_latest_version: 1 }) })]);
  const unchanged = await h.request("publish", "POST", { ...body, expected_latest_version: 1 });
  expect([unchanged.status, await unchanged.json()]).toEqual([200, expect.objectContaining({ outcome: "unchanged" })]);
  expect(await (await h.request("versions")).json()).toMatchObject({ versions: [{ version: 1, definition_count: h.definitions.length }] });
  expect(await (await h.request("versions/1")).json()).toMatchObject({ status: "published", definitions: h.definitions });
  expect(await (await h.request("runtime")).json()).toMatchObject({ version: 1, hash: h.runtime.current().hash, last_failure: null });
});
test("version URLs accept digits only and refuse paths, exponents and fractions", async () => {
  const h = await fixture();
  for (const text of ["0", "1.5", "1e2", "-1", "999999999999999999999"]) expect((await h.request(`versions/${text}`)).status).toBe(400);
});
test("invalid draft and missing running credentials cannot publish", async () => {
  const h = await fixture();
  for (const definitions of [[{}], await fixtureDefinitions()]) {
    const draft = await h.store.readDraft();
    if (!draft.ok) throw new Error(draft.error.detail);
    const saved = await h.store.saveDraft(draft.value?.digest ?? null, { status: "draft", definitions: definitions as JsonValue[] });
    if (!saved.ok) throw new Error(saved.error.detail);
    expect((await h.request("publish", "POST", { expected_draft_digest: saved.value.digest, expected_latest_version: null })).status)
      .toBe(definitions[0] && "id" in definitions[0] ? 409 : 422);
  }
});
const errors: readonly PublicationError[] = [
  { operation: "grading_publication", kind: "invalid_configuration", entity_id: "draft", detail: "invalid", issues: [] },
  { operation: "grading_publication", kind: "draft_conflict", entity_id: "draft", detail: "conflict", current_digest: "current" },
  { operation: "grading_publication", kind: "version_conflict", entity_id: "versions", detail: "conflict", current_latest_version: 2 },
  { operation: "grading_publication", kind: "unconfigured_credential", entity_id: "key", detail: "missing", restart_required: true },
  ...(["registration_failed", "persistence_failed", "runtime_apply_failed"] as const).map((kind) => ({ operation: "grading_publication" as const, kind, entity_id: "test", detail: "failed" })),
];
for (const error of errors) test(`publication outcome ${error.kind} has its status and typed detail`, async () => {
  const h = await fixture({ publish: async () => err(error), restoreDraft: async () => err(error) });
  const response = await h.request("publish", "POST", { expected_draft_digest: null, expected_latest_version: null });
  expect([response.status, await response.json()]).toEqual([error.kind === "invalid_configuration" ? 422
    : ["draft_conflict", "version_conflict", "unconfigured_credential"].includes(error.kind) ? 409 : 500,
  { error: { code: error.kind, message: error.detail, ...error } }]);
  expect(await (await h.request("runtime")).json()).toMatchObject({ last_failure: error });
});
for (const outcome of ["published", "unchanged", "reapplied"] as const) test(`successful ${outcome} response names its outcome`, async () => {
  const h = await fixture({ publish: async () => ok({ outcome, version: 1, hash: "hash", published_at: "now" }),
    restoreDraft: async () => { throw new Error("unused"); } });
  const response = await h.request("publish", "POST", { expected_draft_digest: null, expected_latest_version: null });
  expect([response.status, await response.json()]).toEqual([outcome === "published" ? 201 : 200, { outcome, version: 1, hash: "hash", published_at: "now" }]);
});
