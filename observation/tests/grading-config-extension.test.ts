import { expect } from "bun:test";
import { ok } from "../src/domain/primitives";
import { parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import { gradeNext } from "../src/grading/worker";
import { oakridgeProfile as createProfile } from "../src/producers/oakridge/profile";
import { createApp } from "../src/http/app";
import { createEvidenceReconciler } from "../src/storage/evidence-pipeline";
import { readItemMeasurements } from "../src/storage/execution-store";
import { registerDefinitions } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";
import { fixtureDefinitions, createFeed, integration, oakridgeGradingRegistry, runConfig, scratchDatabase, tenant } from "./grading-fixture";

const repository = { hasCommit: async () => false, readFile: async () => ({ state: "absent" as const }) };

for (const is_valid of [true, false]) integration(`a configuration-only question ${is_valid ? "persists a readable grade" : "refuses an answer outside its schema"}`, async () => scratchDatabase(async (db) => {
  const definitions = await fixtureDefinitions();
  const added = { ...definitions[0]!, id: "finding.config_extension", question: { ...definitions[0]!.question, text: "Does this finding match the captured spec?" } };
  const parsed = parseGradingDefinitions([...definitions, added], oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const registered = await registerDefinitions(db, tenant, registration.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  const feed = createFeed(db, tenant, registration.value.capture);
  await feed.launch({ spec: "Ship organization reads" }, "run-1", runConfig(true));
  await feed.revision({ revision_id: "analysis", artifact_kind: "analysis", body: { summary: "Reads", findings: [
    { id: "F1", description: "Organization reads are required", severity: "warning" }], requirements: [], risks: [], proposed_spec_updates: [] } });
  await createEvidenceReconciler({ db, collector: registration.value.collector, repository, admission: { retry_limit: 1 }, log: () => undefined })
    .reconcileRun(tenant, "run-1");
  const workers = { db, tenants: [tenant], lease_owner: "config-extension", log: () => undefined,
    controls: { run_spend: 5, retry_limit: 1, provider_deadline_ms: 30000, lease_ms: 45000 },
    runners: () => ({ kind: "model" as const, async run(_context: unknown, onRequest?: () => Promise<boolean>) {
      if (onRequest && !await onRequest()) throw new Error("lost claim");
      return ok({ answer: { state: "answered" as const, kind: "choice" as const, value: is_valid ? "relevant" : "invented" },
        confidence: null, probabilities: null, external_execution_id: null });
    } }) };
  while ((await gradeNext(workers, tenant)).kind !== "idle") { /* run the ordinary engine */ }
  const items = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  const item = items.items.find((item) => item.item_kind === "finding")!;
  const measurements = await readItemMeasurements(db, tenant, item.occurrence_id);
  const question = measurements!.questions.find((entry) => entry.evidence.question_id === added.id)!;
  expect(question.machine[0]!.measurement).toMatchObject(is_valid
    ? { state: "answered", answer: { kind: "choice", value: "relevant" } } : { state: "failed" });
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] },
    profile: createProfile(registration.value.questions, registration.value.collector), capture_configuration: registration.value.capture });
  const response = await app.request(`/v1/items/${encodeURIComponent(item.occurrence_id)}/answers`, { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  const body = await response.json() as { items: { question: { question_id: string }; answer: { value: string } }[] };
  const answers = body.items.filter((entry) => entry.question.question_id === added.id);
  expect(answers.map((entry) => entry.answer.value)).toEqual(is_valid ? ["relevant"] : []);
}));
