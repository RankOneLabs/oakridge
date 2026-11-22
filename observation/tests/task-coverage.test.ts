import { stampCapture } from "../src/grading/configuration";
import { pinIdentity } from "./grading-fixture";
import { questionVersion } from "./grading-fixture";
import { expect, test } from "bun:test";
import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../src/domain/identity";
import { ok, type JsonValue } from "../src/domain/primitives";
import { parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import { gradeNext } from "../src/grading/worker";
import type { CapturedRevision, CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import { oakridgeEvidence } from "./grading-fixture";
import { oakridgeGradingRegistry, fixtureDefinitions, createFeed, integration, runConfig, scratchDatabase, tenant } from "./grading-fixture";
import { CONTRIBUTION_COVERAGE_ID, TASK_COVERAGE_ID } from "./grading-fixture";
import { CaptureArtifactSource } from "../src/storage/capture-artifact-source";
import { collectPinnedQuestion, pinOccurrenceInTransaction, readOccurrenceEvidence } from "../src/storage/captured-evidence-store";
import { withTenant } from "../src/storage/database";
import { createEvidenceReconciler } from "../src/storage/evidence-pipeline";
import { readItemMeasurements } from "../src/storage/execution-store";
import { registerDefinitions } from "../src/storage/grading-store";

const requirement = { id: "R1", text: "Organizations expose their opportunities", acceptance_conditions: ["Reads show opportunities"],
  analysis_finding_ids: [], source_refs: ["input.spec"] };
const specifications = { requirements: [requirement] };
const analysis = { requirements: [{ id: "R1", text: requirement.text, findings: [{ id: "F1", observation: "Reads needed" }] }] };
const allocation = { requirement_id: "R1", contribution: "Read and expose organization opportunities" };
const cohort = { id: "api", allocations: [allocation] };
const plan = { cohorts: [cohort] };
const buildItem = { id: "B1", instructions: "Implement the allocation", requirement_ids: ["R1"], verification: ["Run tests"] };
const brief = { cohort_id: "api", repository_key: "oakridge", build_items: [buildItem], technical_decisions: [] };
const revision = (id: string, artifact_kind: string, body: JsonValue): CapturedRevision =>
  ({ revision_id: id as ArtifactRevisionId, stage: artifact_kind, artifact_kind, body, subject_id: null, input_bindings: [] });
const revisions = [revision("analysis-1", "analysis", analysis), revision("spec-1", "spec", specifications),
  revision("plan-1", "plan", plan), revision("brief-1", "brief", brief)];
const repository = { hasCommit: async () => false, readFile: async () => ({ state: "absent" as const }) };
function sources(context: readonly CapturedRevision[] = revisions): CapturedSources {
  return { repository, readRunInput: async () => ({ spec: "Original specification" }),
    readLogicalItemAt: async () => ({ revision_id: "spec-1" as ArtifactRevisionId, item_path: "/requirements/0", item_kind: "requirement", selected_value: requirement }),
    readLinkedItems: async () => [],
    readRevision: async (id) => context.find((revision) => revision.revision_id === id) ?? null,
    readRevisionAt: async (kind) => context.find((revision) => revision.artifact_kind === kind) ?? null };
}
const subject = (item_kind: string, revision_id: string, item_path: string, selected_value: JsonValue): SourceArtifact =>
  ({ item_kind, revision_id: revision_id as ArtifactRevisionId, item_path, occurrence_id: "item" as ItemOccurrenceId,
    run_id: "run-1" as RunId, selected_value });
const specSubject = subject("requirement", "spec-1", "/requirements/0", requirement);
const planSubject = subject("allocation", "plan-1", "/cohorts/0/allocations/0", allocation);
const briefSubject = subject("build_item", "brief-1", "/build_items/0", buildItem);
const question = (question_id: typeof TASK_COVERAGE_ID) => ({ task_id: null, question_id, question_version: questionVersion(question_id) });

test("coverage reads the whole approved requirement at its exact source path", async () => {
  const result = await oakridgeEvidence.collect(specSubject, question(TASK_COVERAGE_ID), sources());
  expect(result).toMatchObject({ state: "ready", references: [
    { ref: "subject", revision_id: "spec-1", item_path: "/requirements/0", content: requirement },
    { ref: "spec", revision_id: "spec-1", content: specifications },
    { ref: "spec_task", revision_id: "spec-1", item_path: "/requirements/0", content: requirement },
    { ref: "requirement:0", revision_id: "spec-1", item_path: "/requirements/0", content: requirement }] });
});

test("an absent authored requirement waits instead of grading incomplete context", async () => {
  const context = revisions.map((entry) => entry.artifact_kind === "spec" ? revision("spec-1", "spec", { requirements: [] }) : entry);
  const result = await oakridgeEvidence.collect(planSubject, question(CONTRIBUTION_COVERAGE_ID), sources(context));
  expect(result).toMatchObject({ state: "not_ready", reason: { code: "requirements_unavailable", detail: expect.stringContaining("R1") } });
});

test("a plan allocation retains its exact requirement and the whole plan", async () => {
  const result = await oakridgeEvidence.collect(planSubject, question(CONTRIBUTION_COVERAGE_ID), sources());
  expect(result).toMatchObject({ state: "ready", references: expect.arrayContaining([
    { source: "revision", ref: "plan", revision_id: "plan-1", item_path: null, content: plan },
    { source: "revision", ref: "requirement:0", revision_id: "spec-1", item_path: "/requirements/0", content: requirement }]) });
});

test("a brief build item carries its brief and matching cohort alongside the approved requirement", async () => {
  const { oakridgeCapabilities } = await import("../src/producers/oakridge/evidence");
  const result = await oakridgeCapabilities.build_item_context!.resolve({ artifact: briefSubject, sources: sources(),
    question: { ...question(TASK_COVERAGE_ID), task_id: "requirement:R1" as import("../src/domain/identity").LogicalItemId } }, {});
  expect(result).toMatchObject({ state: "ready", references: expect.arrayContaining([
    { source: "revision", ref: "requirement:0", revision_id: "spec-1", item_path: "/requirements/0", content: requirement },
    { source: "revision", ref: "cohort", revision_id: "plan-1", item_path: "/cohorts/0", content: cohort },
    { source: "revision", ref: "brief", revision_id: "brief-1", item_path: null, content: brief }]) });
});

test("an unassigned allocation never guesses a requirement from similar wording", async () => {
  const artifact = { ...planSubject, selected_value: { ...allocation, requirement_id: "R404" } };
  expect(await oakridgeEvidence.collect(artifact, question(CONTRIBUTION_COVERAGE_ID), sources()))
    .toMatchObject({ state: "not_ready", reason: { code: "requirements_unavailable", detail: expect.stringContaining("R404") } });
});

integration("requirements and plan allocations freeze their original context and execute through the ordinary worker", async () => scratchDatabase(async (db) => {
  const parsed = parseGradingDefinitions(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const registered = await registerDefinitions(db, tenant, registration.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  const coverage = { pins: registration.value.capture.pins.filter((pin) =>
    pin.question_id === TASK_COVERAGE_ID || pin.question_id === CONTRIBUTION_COVERAGE_ID) };
  const feed = createFeed(db, tenant, stampCapture(coverage, pinIdentity));
  await feed.launch({ spec: "Original spec" }, "run-1", runConfig(true));
  for (const [index, entry] of revisions.entries()) await feed.revision({ revision_id: entry.revision_id, artifact_kind: entry.artifact_kind, body: entry.body,
    recorded_at: `2026-11-01T00:00:0${index}.000Z` });
  // Deliberately collect after future edits. They must not become the context of older items.
  await feed.revision({ revision_id: "spec-2", artifact_kind: "spec", body: { requirements: [] }, recorded_at: "2026-11-01T00:00:10.000Z" });
  await feed.revision({ revision_id: "plan-2", artifact_kind: "plan", body: { cohorts: [], risks: [] }, recorded_at: "2026-11-01T00:00:12.000Z" });
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence, repository });
  const items = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "artifact_kind"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("item_kind", "in", ["requirement", "allocation"]).where("artifact_kind", "in", ["spec", "plan"]).execute());
  for (const item of items) {
    const occurrence = item.occurrence_id as ItemOccurrenceId;
    const pinned = await readOccurrenceEvidence(db, tenant, occurrence);
    expect(pinned).toHaveLength(1);
    const collected = await collectPinnedQuestion(db, tenant, source, pinned[0]!);
    expect(collected).toMatchObject({ ok: true, value: { readiness: { state: "ready" } } });
    if (!collected.ok || collected.value.readiness.state !== "ready") throw new Error("coverage was not ready");
    expect(collected.value.readiness.references.filter((ref) => ref.source === "revision").map((ref) => ref.revision_id))
      .not.toContain("spec-2");
    expect(await collectPinnedQuestion(db, tenant, source, collected.value)).toEqual(collected);
  }
  const reconciler = createEvidenceReconciler({ db, collector: oakridgeEvidence, repository, admission: { retry_limit: 3 }, log: () => undefined });
  await reconciler.reconcileRun(tenant, "run-1");
  let requests = 0;
  const worker = { db, tenants: [tenant], lease_owner: "coverage-worker", log: () => undefined,
    controls: { run_spend: 5, retry_limit: 3, provider_deadline_ms: 30000, lease_ms: 45000 },
    runners: () => ({ kind: "model" as const, async run(_context: unknown, onRequest?: () => Promise<boolean>) {
      if (onRequest && !await onRequest()) throw new Error("claim lost");
      requests++;
      return ok({ answer: { state: "answered" as const, kind: "choice" as const, value: "partially_covers" }, confidence: null,
        probabilities: null, external_execution_id: null });
    } }) };
  while ((await gradeNext(worker, tenant)).kind !== "idle") { /* drain ordinary leased executions */ }
  expect(requests).toBe(2);
  for (const item of items) expect((await readItemMeasurements(db, tenant, item.occurrence_id))?.questions[0]?.machine[0]?.measurement)
    .toMatchObject({ state: "answered", answer: { value: "partially_covers" } });
}));

integration("an explicit coverage upgrade adds only the new question and leaves prior capture pins unchanged", async () => scratchDatabase(async (db) => {
  const parsed = parseGradingDefinitions(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  await registerDefinitions(db, tenant, registration.value);
  const old = { pins: stampCapture(registration.value.capture, pinIdentity).pins.filter((pin) => pin.question_id !== TASK_COVERAGE_ID) };
  const feed = createFeed(db, tenant, old);
  await feed.launch({ spec: "The original spec" });
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: analysis });
  await feed.revision({ revision_id: "spec-1", artifact_kind: "spec", body: specifications });
  const before = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll().execute());
  const item = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id")
    .where("item_kind", "=", "requirement").where("artifact_kind", "=", "spec").executeTakeFirstOrThrow());
  const coverage = { pins: stampCapture(registration.value.capture, pinIdentity).pins.filter((pin) => pin.question_id === TASK_COVERAGE_ID) };
  for (let replay = 0; replay < 2; replay++) await withTenant(db, tenant, (trx) =>
    pinOccurrenceInTransaction(trx, tenant, item.occurrence_id as ItemOccurrenceId, coverage));
  expect(await readOccurrenceEvidence(db, tenant, item.occurrence_id as ItemOccurrenceId)).toHaveLength(1);
  const original = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("question_id", "!=", TASK_COVERAGE_ID).execute());
  expect(original).toEqual(before);
}));

test("coverage sources and list pointers come from capability parameters and share captured reads", async () => {
  const { createCapabilityCollector } = await import("../src/grading/evidence");
  const { oakridgeCapabilities } = await import("../src/producers/oakridge/evidence");
  const question = { task_id: null, question_id: TASK_COVERAGE_ID, question_version: "test-parameters" };
  const task_source = { artifact: "work", list: "/entries" };
  const task = { id: "T1", requirement_ids: ["R1"] };
  const context = [revision("work-1", "work", { entries: [task] }), revision("rules-1", "rules", { clauses: [requirement] })];
  const calls: string[] = [];
  const source = { ...sources(context), readRevisionAt: async (kind: string) => {
    calls.push(kind);
    return context.find((entry) => entry.artifact_kind === kind) ?? null;
  } };
  const collector = createCapabilityCollector([{ ...question, evidence: ["subject", { capability: "spec_task", params: task_source },
    { capability: "requirement", params: { artifact: "rules", list: "/clauses", task_source } }] }], oakridgeCapabilities);
  const result = await collector.collect(subject("task", "work-1", "/entries/0", task), question, source);
  expect(result).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { ref: "spec_task", revision_id: "work-1", item_path: "/entries/0", content: task },
    { ref: "requirement:0", revision_id: "rules-1", item_path: "/clauses/0", content: requirement }] });
  expect(calls).toEqual(["work", "rules"]);
});

integration("a brief resolves its approved requirement and plan at the brief's own revision", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db, tenant);
  await feed.launch({ spec: "Original spec" });
  const publish = (revision_id: string, artifact_kind: string, body: JsonValue, second: number) =>
    feed.revision({ revision_id, artifact_kind, body, recorded_at: `2026-11-01T00:00:0${second}Z` });
  await publish("spec-1", "spec", specifications, 1);
  await publish("plan-1", "plan", plan, 2);
  const revisedRequirement = { ...requirement, text: "Reads must include organization details" };
  const revisedPlan = { ...plan, summary: "More precise contribution" };
  await publish("spec-2", "spec", { requirements: [revisedRequirement] }, 3);
  await publish("plan-2", "plan", revisedPlan, 4);
  await publish("brief-1", "brief", brief, 5);
  await publish("spec-3", "spec", { requirements: [] }, 6);
  await publish("plan-3", "plan", { cohorts: [] }, 7);
  const item = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").selectAll()
    .where("artifact_kind", "=", "brief").where("item_kind", "=", "build_item").executeTakeFirstOrThrow());
  expect(item).toMatchObject({ revision_id: "brief-1", producer_local_id: "B1", json_pointer: "/build_items/0" });
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence, repository });
  const task_id = "oakridge:grading-test:run-1:task:requirement:R1" as import("../src/domain/identity").LogicalItemId;
  const { oakridgeCapabilities } = await import("../src/producers/oakridge/evidence");
  expect(await oakridgeCapabilities.build_item_context!.resolve({
    artifact: { ...briefSubject, occurrence_id: item.occurrence_id as ItemOccurrenceId }, sources: source,
    question: { ...question(TASK_COVERAGE_ID), task_id },
  }, {})).toMatchObject({ state: "ready", references: expect.arrayContaining([
    expect.objectContaining({ ref: "subject", revision_id: "brief-1" }),
    expect.objectContaining({ ref: "requirement:0", revision_id: "spec-2", content: revisedRequirement }),
    expect.objectContaining({ ref: "cohort", revision_id: "plan-2", item_path: "/cohorts/0", content: cohort }),
  ]) });
}));
