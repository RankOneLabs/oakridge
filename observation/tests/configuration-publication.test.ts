import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type JsonValue } from "../src/domain/primitives";
import { configurationHash, planRegistration, type GradingDefinitions } from "../src/grading/configuration";
import { createGradingConfigStore, type GradingConfigStore } from "../src/grading/configuration-store";
import { createGradingPublication, type PublicationDependencies } from "../src/grading/publication";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { type Database, withTenant } from "../src/storage/database";
import { registerDefinitions } from "../src/storage/grading-store";
import { createEvidenceReconciler } from "../src/storage/evidence-pipeline";
import { gradeNext } from "../src/grading/worker";
import { committedDefinitions, createFeed, credentialEnv, integration, oakridgeGradingRegistry, runConfig, scratchDatabase, tenant } from "./grading-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const original = await committedDefinitions();
const definitions = original.map((definition) => ({ ...definition, evaluators: [] }));
const changed = definitions.map((definition) => ({ ...definition, question: { ...definition.question, text: "Changed question" } }));
function snapshot(selected: GradingDefinitions, version: number | null = null) {
  const registration = planRegistration(selected, oakridgeGradingRegistry);
  const hash = configurationHash(selected);
  if (!registration.ok || !hash.ok) throw new Error("invalid fixture configuration");
  return runtimeSnapshot({ version, hash: hash.value, registration: registration.value,
    profile: oakridgeProfile(registration.value.questions, registration.value.collector), applied_at: "2026-11-01T00:00:00Z" });
}
async function fixture(overrides: Partial<PublicationDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), "grading-publication-")); roots.push(root);
  const store = overrides.store ?? createGradingConfigStore(root);
  const runtime = overrides.runtime ?? new RuntimeConfiguration(snapshot(definitions));
  const calls: string[] = [];
  const deps: PublicationDependencies = { db: {} as Database, store, runtime, registry: oakridgeGradingRegistry, env: {},
    credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }, { producer: "other", namespace: "ignored", token: "other" }],
      grade: [{ ...tenant, namespace: "review", token: "grade", reviewer_id: "reviewer" }] },
    profile: (registration) => oakridgeProfile(registration.questions, registration.collector), now: () => "2026-11-02T00:00:00Z",
    register: async (_db, scope) => { calls.push(scope.namespace); return ok(undefined); }, ...overrides };
  const service = createGradingPublication(deps);
  const save = async (selected: unknown = definitions) => {
    const current = await store.readDraft();
    if (!current.ok) throw new Error(current.error.detail);
    const saved = await store.saveDraft(current.value?.digest ?? null, { status: "draft", definitions: selected as JsonValue[] });
    if (!saved.ok) throw new Error(saved.error.detail);
    return saved.value.digest;
  };
  const publish = async (expected_latest_version: number | null = null) => {
    const draft = await store.readDraft();
    if (!draft.ok) throw new Error(draft.error.detail);
    return service.publish({ expected_draft_digest: draft.value?.digest ?? null, expected_latest_version });
  };
  return { root, store, runtime, service, save, publish, calls };
}

test("invalid draft definitions return indexed paths and write no versions", async () => {
  const h = await fixture(); await h.save([{ id: "unfinished" }]);
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "invalid_configuration", issues: [{ definition_index: 0, path: [0, "scope"] }] } });
  expect(await h.store.listVersions()).toEqual(ok([]));
  expect(h.calls).toEqual([]);
});
test("no draft is an invalid configuration", async () => {
  const h = await fixture();
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "invalid_configuration" } });
});
test("draft and latest-version conflicts return current tokens before registration", async () => {
  const h = await fixture(); const digest = await h.save();
  expect(await h.service.publish({ expected_draft_digest: "stale", expected_latest_version: null })).toMatchObject({
    ok: false, error: { kind: "draft_conflict", current_digest: digest },
  });
  expect(await h.publish(1)).toMatchObject({ ok: false, error: { kind: "version_conflict", current_latest_version: null } });
  expect(h.calls).toEqual([]);
});
test("successful publication registers every distinct producer tenant before persisting and swapping", async () => {
  let registrations = 0;
  const h = await fixture();
  // Inspect files directly inside the registration boundary: store methods would wait for its mutex.
  const checked = createGradingPublication({ db: {} as Database, store: h.store, runtime: h.runtime, registry: oakridgeGradingRegistry,
    env: {}, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }, { ...tenant, namespace: "second", token: "second" }] },
    profile: (registration) => oakridgeProfile(registration.questions, registration.collector),
    register: async () => { expect(await readdir(join(h.root, "versions")).catch(() => [])).toEqual([]); registrations++; return ok(undefined); } });
  const digest = await h.save(changed);
  expect(await checked.publish({ expected_draft_digest: digest, expected_latest_version: null })).toMatchObject({ ok: true, value: { outcome: "published", version: 1 } });
  expect([registrations, h.runtime.current().version]).toEqual([2, 1]);
  expect(await h.store.latestVersion()).toMatchObject({ ok: true, value: { hash: h.runtime.current().hash } });
});
test("publishing the latest content twice is unchanged without registration or new files", async () => {
  const h = await fixture(); await h.save();
  expect(await h.publish()).toMatchObject({ ok: true, value: { outcome: "published", version: 1 } });
  const calls = h.calls.length;
  const applied = h.runtime.current();
  expect(await h.publish(1)).toMatchObject({ ok: true, value: { outcome: "unchanged", version: 1 } });
  expect([h.calls.length, h.runtime.current() === applied]).toEqual([calls, true]);
  expect(await h.store.listVersions()).toEqual(ok([1]));
});
test("latest content with a different runtime is registered and reapplied without a new version", async () => {
  const h = await fixture(); await h.save(); await h.publish();
  h.runtime.replace(snapshot(changed));
  const calls = h.calls.length;
  expect(await h.publish(1)).toMatchObject({ ok: true, value: { outcome: "reapplied", version: 1 } });
  expect(h.calls.length).toBeGreaterThan(calls);
  expect(h.runtime.current().version).toBe(1);
  expect(await h.store.listVersions()).toEqual(ok([1]));
});
test("restore only saves a draft; publishing old content creates a new version with a repeated hash", async () => {
  const h = await fixture(); await h.save(); const first = await h.publish();
  await h.save(changed); await h.publish(1);
  const current = await h.store.readDraft(); if (!current.ok) throw new Error(current.error.detail);
  expect(await h.service.restoreDraft(1, "stale")).toMatchObject({ ok: false, error: { kind: "draft_conflict" } });
  expect((await h.service.restoreDraft(1, current.value!.digest)).ok).toBe(true);
  expect(h.runtime.current().version).toBe(2);
  expect(await h.publish(2)).toMatchObject({ ok: true, value: { outcome: "published", version: 3, hash: first.ok ? first.value.hash : "" } });
});
test("missing provider credentials require a restart and prevent registration and persistence", async () => {
  const h = await fixture(); await h.save(original);
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "unconfigured_credential", restart_required: true } });
  expect(h.calls).toEqual([]);
  expect(await h.store.listVersions()).toEqual(ok([]));
});
test("registration failure leaves no published version and does not swap runtime", async () => {
  const h = await fixture({ register: async () => err({ operation: "register", entity_id: "tenant", detail: "unavailable" }) });
  await h.save(changed); const before = h.runtime.current();
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "registration_failed" } });
  expect(await h.store.listVersions()).toEqual(ok([]));
  expect(h.runtime.current()).toBe(before);
});
test("a thrown registration IO error becomes a registration failure", async () => {
  const h = await fixture({ register: async () => { throw new Error("connection closed"); } }); await h.save();
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "registration_failed" } });
});
test("persistence failure follows registration and does not apply runtime", async () => {
  const base = await fixture();
  const broken: GradingConfigStore = { ...base.store, withLock: (work) => base.store.withLock((store) => work({ ...store,
    allocateAndWritePublished: async () => err({ operation: "grading_config_store", kind: "io", entity_id: "versions", detail: "disk full" }),
  })) };
  const h = await fixture({ store: broken }); await h.save(changed); const before = h.runtime.current();
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "persistence_failed" } });
  expect(h.calls.length).toBeGreaterThan(0);
  expect(h.runtime.current()).toBe(before);
});
test("a failed runtime swap is never acknowledged as Ok", async () => {
  class FailedRuntime extends RuntimeConfiguration { override replace(): void { throw new Error("swap failed"); } }
  const h = await fixture({ runtime: new FailedRuntime(snapshot(definitions)) }); await h.save(changed);
  expect(await h.publish()).toMatchObject({ ok: false, error: { kind: "runtime_apply_failed" } });
  expect(await h.store.listVersions()).toEqual(ok([1]));
});
test("concurrent publications serialize and the loser observes a latest-version conflict", async () => {
  const h = await fixture(); const digest = await h.save();
  const request = { expected_draft_digest: digest, expected_latest_version: null };
  const results = await Promise.all([h.service.publish(request), h.service.publish(request)]);
  expect(results).toMatchObject([{ ok: true, value: { outcome: "published" } }, { ok: false, error: { kind: "version_conflict", current_latest_version: 1 } }]);
});

integration("publication leaves nonempty capture pins, grades, evidence and executions byte-for-byte unchanged", async () => scratchDatabase(async (db) => {
  const selected = original.filter((definition) => definition.id === "finding.relevance");
  const initial = snapshot(selected);
  const registered = await registerDefinitions(db, tenant, initial.registration);
  if (!registered.ok) throw new Error(registered.error.detail);
  const feed = createFeed(db, tenant, initial.capture_configuration);
  await feed.launch({ spec: "Ship reads" }, "run-1", runConfig(true));
  await feed.revision({ revision_id: "analysis", artifact_kind: "analysis", body: { summary: "Reads", findings: [
    { id: "F1", description: "Reads required", severity: "warning" }], requirements: [], risks: [], proposed_spec_updates: [] } });
  await createEvidenceReconciler({ db, collector: initial.profile.evidence,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" as const }) },
    admission: { retry_limit: 1 }, log: () => undefined }).reconcileRun(tenant, "run-1");
  const workers = { db, tenants: [tenant], lease_owner: "publication-test", log: () => undefined,
    controls: { run_spend: 5, retry_limit: 1, provider_deadline_ms: 30000, lease_ms: 45000 },
    runners: () => ({ kind: "model" as const, async run(_context: unknown, onRequest?: () => Promise<boolean>) {
      if (onRequest && !await onRequest()) throw new Error("lost claim");
      return ok({ answer: { state: "answered" as const, kind: "choice" as const, value: "relevant" },
        confidence: null, probabilities: null, external_execution_id: null });
    } }) };
  while ((await gradeNext(workers, tenant)).kind !== "idle") { /* finish the seeded executions */ }
  const history = () => withTenant(db, tenant, async (trx) => ({
    evidence: await trx.selectFrom("observation.evidence_set").selectAll().orderBy("evidence_set_id").execute(),
    grades: await trx.selectFrom("observation.grade_observation").selectAll().orderBy("observation_id").execute(),
    executions: await trx.selectFrom("observation.evaluation_execution").selectAll().orderBy("execution_id").execute(),
    pins: await trx.selectFrom("observation.evidence_set").select(["evidence_set_id", "question_id", "question_version", "pinned_evaluator_definition_ids", "collection_plan"]).orderBy("evidence_set_id").execute(),
  }));
  const before = await history();
  expect([before.pins.length, before.grades.length, before.evidence.length, before.executions.length].every((count) => count > 0)).toBe(true);
  // Row timestamps are Date objects; JSON is the storage boundary representation.
  const beforeJson = JSON.stringify(before);
  const runtime = new RuntimeConfiguration(initial);
  const h = await fixture({ db, runtime, register: registerDefinitions, env: credentialEnv(original),
    credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] } });
  await h.save(original);
  expect(await h.publish()).toMatchObject({ ok: true, value: { outcome: "published" } });
  expect(JSON.stringify(await history())).toBe(beforeJson);
  expect(runtime.current().version).toBe(1);
}));
