import { expect, test } from "bun:test";
import { configurationHash, planRegistration, type GradingDefinitions } from "../src/grading/configuration";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { registerDefinitions } from "../src/storage/grading-store";
import { fixtureDefinitions, integration, oakridgeGradingRegistry, revisionOutcome, scratchDatabase, tenant } from "./grading-fixture";

function snapshot(definitions: GradingDefinitions, version: number | null = null) {
  const registration = planRegistration(definitions, oakridgeGradingRegistry);
  const hash = configurationHash(definitions);
  if (!registration.ok || !hash.ok) throw new Error("invalid fixture configuration");
  return runtimeSnapshot({ registration: registration.value, version, hash: hash.value,
    profile: oakridgeProfile(registration.value.questions, registration.value.collector), applied_at: "2026-11-01T00:00:00Z" });
}
const definitions = await fixtureDefinitions();

test("runtime replacement swaps a complete immutable snapshot and retains earlier snapshots", () => {
  const initial = snapshot(definitions);
  const runtime = new RuntimeConfiguration(initial);
  const previous = runtime.current();
  runtime.replace(snapshot(definitions.slice(0, 1), 2));
  expect([runtime.current().version, previous.version]).toEqual([2, null]);
  expect(runtime.current().hash).not.toBe(previous.hash);
  expect(Object.isFrozen(runtime.current().registration.capture.pins)).toBe(true);
  expect(runtime.current()).not.toBe(initial);
});

integration("replacement reaches new HTTP captures and health while existing pins remain frozen", async () => scratchDatabase(async (db) => {
  const before = snapshot(definitions);
  const selected = definitions.filter((definition) => definition.id === "finding.relevance");
  const changed = selected.map((definition) => ({ ...definition, question: { ...definition.question, text: "Changed question" } }));
  const after = snapshot(changed, 1);
  const runtime = new RuntimeConfiguration(before);
  for (const registration of [before.registration, after.registration]) {
    const result = await registerDefinitions(db, tenant, registration);
    if (!result.ok) throw new Error(result.error.detail);
  }
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] }, runtime_configuration: runtime });
  let previous = { commit_txid: "0", id: "" };
  const send = async (revision_id: string) => {
    const outcome = revisionOutcome({ revision_id, artifact_kind: "analysis", body: { summary: "Summary", findings: [
      { id: "F1", description: "Observation", severity: "warning" }], requirements: [], risks: [], proposed_spec_updates: [] } });
    const cursor = { commit_txid: String(Number(previous.commit_txid) + 1), id: outcome.event_id };
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
      headers: { authorization: "Bearer ingest", "content-type": "application/json" }, body: JSON.stringify({ previous, cursor, outcome }) });
    expect(response.status).toBe(200);
    previous = cursor;
  };
  const pins = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll().orderBy("evidence_set_id").execute());
  await send("before");
  const frozen = await pins();
  expect(frozen.length).toBeGreaterThan(0);
  runtime.replace(after);
  await send("after");
  const all = await pins();
  expect(all.filter((row) => frozen.some((old) => old.evidence_set_id === row.evidence_set_id))).toEqual(frozen);
  const later = all.filter((row) => !frozen.some((old) => old.evidence_set_id === row.evidence_set_id));
  expect(later.map((row) => row.question_version)).toEqual([after.registration.questions[0]!.question_version]);
  const health = await app.request("/health");
  expect(await health.json()).toMatchObject({ graders: after.grader_capability });
}));

integration("each reconciliation reads the current collector while retaining the original capture plan", async () => scratchDatabase(async (db) => {
  const initial = snapshot(definitions.filter((definition) => definition.id === "finding.relevance"));
  const registered = await registerDefinitions(db, tenant, initial.registration);
  if (!registered.ok) throw new Error(registered.error.detail);
  const calls: string[] = [];
  const runtime = new RuntimeConfiguration({ ...initial, profile: { ...initial.profile, evidence: {
    collect: async () => { calls.push("before"); return { state: "not_ready", reason: { code: "waiting", detail: "test input absent" } }; },
  } } });
  const { createFeed } = await import("./grading-fixture");
  const feed = createFeed(db, tenant, initial.capture_configuration);
  await feed.revision({ revision_id: "collector", artifact_kind: "analysis", body: { summary: "Summary", findings: [
    { id: "F1", description: "Observation", severity: "warning" }], requirements: [], risks: [], proposed_spec_updates: [] } });
  const { createEvidenceReconciler } = await import("../src/storage/evidence-pipeline");
  const reconciler = createEvidenceReconciler({ db, runtime_configuration: runtime, log: () => undefined,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" as const }) } });
  await reconciler.reconcileRun(tenant, "run-1");
  runtime.replace({ ...initial, profile: { ...initial.profile, evidence: {
    collect: async (_artifact, question) => {
      calls.push("after");
      expect(question.collection_plan?.question_version).toBe(initial.registration.questions[0]!.question_version);
      return { state: "ready", references: [] };
    },
  } } });
  const result = await reconciler.reconcileRun(tenant, "run-1");
  expect([calls, result.collection.ready.length]).toEqual([["before", "after"], 1]);
}));
