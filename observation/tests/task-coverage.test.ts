import { expect, test } from "bun:test";
import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../src/domain/identity";
import { ok, type JsonValue } from "../src/domain/primitives";
import { parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import { gradeNext } from "../src/grading/worker";
import type { CapturedRevision, CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import { oakridgeEvidence } from "../src/producers/oakridge/evidence";
import { oakridgeGradingRegistry, committedDefinitions, createFeed, integration, runConfig, scratchDatabase, tenant } from "./grading-fixture";
import { CONTRIBUTION_COVERAGE_ID, TASK_COVERAGE_ID } from "../src/producers/oakridge/evidence";
import { CaptureArtifactSource } from "../src/storage/capture-artifact-source";
import { collectPinnedQuestion, pinOccurrenceInTransaction, readOccurrenceEvidence } from "../src/storage/captured-evidence-store";
import { withTenant } from "../src/storage/database";
import { createEvidenceReconciler } from "../src/storage/evidence-pipeline";
import { readItemMeasurements } from "../src/storage/execution-store";
import { registerDefinitions } from "../src/storage/grading-store";

const TASK = { id: "T1", description: "Add organization reads", requirement_ids: ["R1"] };
const requirement = { id: "R1", description: "Organizations expose their opportunities", status: "implementable" };
const tasks = { tasks: [TASK] };
const analysis = { summary: "One requirement", findings: [], requirements: [requirement], risks: [], proposed_spec_updates: [] };
const contribution = { id: "T1", text: "Read and expose organization opportunities", decision_ids: [] };
const cohort = { id: "api", scope: "Organization API", decisions: [], acceptance_criteria: [contribution] };
const plan = { cohorts: [cohort], risks: [] };
const brief = { cohort_id: "api", goal: "Organization reads", files_in_scope: ["api.ts"], decisions_made: [], approaches_rejected: [], acceptance_criteria: [contribution] };
const revision = (id: string, artifact_kind: string, body: JsonValue): CapturedRevision =>
  ({ revision_id: id as ArtifactRevisionId, artifact_kind, body, subject_id: null });
const revisions = [revision("analysis-1", "analysis", analysis), revision("spec-1", "spec", "Approved specification with explicit Spec tasks"),
  revision("tasks-1", "tasks", tasks), revision("plan-1", "plan", plan), revision("brief-1", "brief", brief)];
const repository = { hasCommit: async () => false, readFile: async () => ({ state: "absent" as const }) };
function sources(context: readonly CapturedRevision[] = revisions): CapturedSources {
  return { repository, readRunInput: async () => ({ spec: "Original specification" }), readLogicalItemAt: async () => ({ revision_id: "tasks-1" as ArtifactRevisionId, item_path: "/tasks/0", item_kind: "task", selected_value: { id: "T7" } }), readLinkedItems: async () => [],
    readRevision: async (id) => context.find((revision) => revision.revision_id === id) ?? null,
    readRevisionAt: async (kind) => context.find((revision) => revision.artifact_kind === kind) ?? null };
}
const subject = (kind: "task" | "acceptance_entry", revision_id: string, path: string): SourceArtifact =>
  ({ item_kind: kind, revision_id: revision_id as ArtifactRevisionId, item_path: path, occurrence_id: "item" as ItemOccurrenceId,
    run_id: "run-1" as RunId, selected_value: kind === "task" ? TASK : contribution });

test("a spec task is judged against full linked requirements at exact revision paths, not just their status", async () => {
  const result = await oakridgeEvidence.collect(subject("task", "tasks-1", "/tasks/0"), { task_id: null, question_id: TASK_COVERAGE_ID, question_version: "1" }, sources());
  expect(result).toMatchObject({ state: "ready", references: [
    { ref: "subject", revision_id: "tasks-1", item_path: "/tasks/0" },
    { ref: "spec", revision_id: "spec-1", content: "Approved specification with explicit Spec tasks" },
    { ref: "spec_task", revision_id: "tasks-1", item_path: "/tasks/0", content: TASK },
    { ref: "requirement:0", revision_id: "analysis-1", item_path: "/requirements/0", content: requirement }] });
});

test("an absent explicit requirement waits instead of silently grading the remaining context", async () => {
  const context = revisions.map((entry) => entry.artifact_kind === "analysis" ? revision("analysis-1", "analysis", { ...analysis, requirements: [] }) : entry);
  const result = await oakridgeEvidence.collect(subject("task", "tasks-1", "/tasks/0"), { task_id: null, question_id: TASK_COVERAGE_ID, question_version: "1" }, sources(context));
  expect(result).toMatchObject({ state: "not_ready", reason: { code: "requirements_unavailable", detail: expect.stringContaining("R1") } });
});

test("a plan contribution retains its exact cohort context and the combined plan for a shared task", async () => {
  const result = await oakridgeEvidence.collect(subject("acceptance_entry", "plan-1", "/cohorts/0/acceptance_criteria/0"),
    { task_id: null, question_id: CONTRIBUTION_COVERAGE_ID, question_version: "1" }, sources());
  expect(result).toMatchObject({ state: "ready", references: expect.arrayContaining([
    { source: "revision", ref: "plan", revision_id: "plan-1", item_path: null, content: plan },
    { source: "revision", ref: "contribution_context", revision_id: "plan-1", item_path: "/cohorts/0", content: cohort }]) });
});

test("a brief contribution carries its brief and plan alongside the original spec task", async () => {
  const result = await oakridgeEvidence.collect(subject("acceptance_entry", "brief-1", "/acceptance_criteria/0"),
    { task_id: null, question_id: CONTRIBUTION_COVERAGE_ID, question_version: "1" }, sources());
  expect(result).toMatchObject({ state: "ready", references: expect.arrayContaining([
    { source: "revision", ref: "spec_task", revision_id: "tasks-1", item_path: "/tasks/0", content: TASK },
    { source: "revision", ref: "plan", revision_id: "plan-1", item_path: null, content: plan },
    { source: "revision", ref: "contribution_context", revision_id: "brief-1", item_path: null, content: brief }]) });
});

test("an unassigned contribution never guesses a spec task from similar wording", async () => {
  const artifact = { ...subject("acceptance_entry", "plan-1", "/cohorts/0/acceptance_criteria/0"), selected_value: { ...contribution, id: "T404" } };
  expect(await oakridgeEvidence.collect(artifact, { task_id: null, question_id: CONTRIBUTION_COVERAGE_ID, question_version: "1" }, sources()))
    .toMatchObject({ state: "not_ready", reason: { code: "task_unavailable" } });
});

integration("tasks, plan contributions and briefs freeze their original context and execute through the ordinary worker", async () => scratchDatabase(async (db) => {
  const parsed = parseGradingDefinitions(await committedDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const registered = await registerDefinitions(db, tenant, registration.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  const feed = createFeed(db, tenant, registration.value.capture);
  await feed.launch({ spec: "Original spec" }, "run-1", runConfig(true));
  for (const [index, entry] of revisions.entries()) await feed.revision({ revision_id: entry.revision_id, artifact_kind: entry.artifact_kind, body: entry.body,
    recorded_at: `2026-11-01T00:00:0${index}.000Z` });
  // Deliberately collect after future edits. They must not become the context of older items.
  await feed.revision({ revision_id: "spec-2", artifact_kind: "spec", body: "Later spec", recorded_at: "2026-11-01T00:00:10.000Z" });
  await feed.revision({ revision_id: "tasks-2", artifact_kind: "tasks", body: { tasks: [] }, recorded_at: "2026-11-01T00:00:11.000Z" });
  await feed.revision({ revision_id: "plan-2", artifact_kind: "plan", body: { cohorts: [], risks: [] }, recorded_at: "2026-11-01T00:00:12.000Z" });
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence, repository });
  const items = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "artifact_kind"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("item_kind", "in", ["task", "acceptance_entry"]).execute());
  for (const item of items) {
    const occurrence = item.occurrence_id as ItemOccurrenceId;
    const pinned = await readOccurrenceEvidence(db, tenant, occurrence);
    expect(pinned).toHaveLength(1);
    const collected = await collectPinnedQuestion(db, tenant, source, pinned[0]!);
    expect(collected).toMatchObject({ ok: true, value: { readiness: { state: "ready" } } });
    if (!collected.ok || collected.value.readiness.state !== "ready") throw new Error("coverage was not ready");
    expect(collected.value.readiness.references.filter((ref) => ref.source === "revision").map((ref) => ref.revision_id))
      .not.toContain("oakridge:grading-test:tasks-2");
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
  expect(requests).toBe(3);
  for (const item of items) expect((await readItemMeasurements(db, tenant, item.occurrence_id))?.questions[0]?.machine[0]?.measurement)
    .toMatchObject({ state: "answered", answer: { value: "partially_covers" } });
}));

integration("an explicit coverage upgrade adds only the new question and leaves prior capture pins unchanged", async () => scratchDatabase(async (db) => {
  const parsed = parseGradingDefinitions(await committedDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  await registerDefinitions(db, tenant, registration.value);
  const old = { pins: registration.value.capture.pins.filter((pin) => pin.question_id !== TASK_COVERAGE_ID) };
  const feed = createFeed(db, tenant, old);
  await feed.launch({ spec: "The original spec" });
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: { ...analysis, findings: [{ id: "F1", description: "An existing finding", severity: "warning" }] } });
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: tasks });
  const before = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll().execute());
  const item = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id")
    .where("item_kind", "=", "task").executeTakeFirstOrThrow());
  const coverage = { pins: registration.value.capture.pins.filter((pin) => pin.question_id === TASK_COVERAGE_ID) };
  for (let replay = 0; replay < 2; replay++) await withTenant(db, tenant, (trx) =>
    pinOccurrenceInTransaction(trx, tenant, item.occurrence_id as ItemOccurrenceId, "task", coverage));
  expect(await readOccurrenceEvidence(db, tenant, item.occurrence_id as ItemOccurrenceId)).toHaveLength(1);
  const original = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("question_id", "!=", TASK_COVERAGE_ID).execute());
  expect(original).toEqual(before);
}));
