/** Run a deliberately selected, revisioned pilot population. No credentials enter the output file. */
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../src/canonical/canonical-json";
import { evaluationDigest, type EvaluationIdentity, type EvaluationExecution } from "../src/grading/execution";
import { evaluatorIdentity } from "../src/grading/evaluator";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { PilotQuestionId } from "../src/langfuse/evidence-recipe";
import type { GradeObservation } from "../src/grading/observation";
import type { GradingContext } from "../src/grading/runner";
import type { GradeDetails } from "../src/storage/grading-store";
import { openDatabase, withTenant } from "../src/storage/database";
import { readEligibility } from "../src/storage/eligibility-store";
import type { ExportManifest } from "../src/export/manifest";
import { assayItemEvidenceDigest, makePopulationManifestFromEligibility, type PopulationManifest,
  type PopulationSelection } from "../src/langfuse/population-manifest";
import { evidenceSetDigest } from "../src/langfuse/mapping";
import type { ComparisonMeasurement, DisagreementCause, PilotSplit } from "../src/langfuse/comparison-report";

export interface PilotAttempt {
  readonly identity: EvaluationIdentity;
  readonly context: GradingContext;
  readonly runner: "deterministic" | "coverage" | "jev_direct" | "fastino_glide" | "llm_judge";
  readonly split: PilotSplit;
  readonly question_text: string;
  readonly disagreement_cause: DisagreementCause | null;
}
export interface PilotHumanGrade { readonly identity: EvaluationIdentity; readonly context: GradingContext;
  readonly details: GradeDetails }
export interface PilotAnnotationImport { readonly mapping_key: string; readonly queue_item_id: string;
  readonly score_id: string }
export interface PilotRunPlan {
  readonly tenant: { readonly producer: string; readonly namespace: string };
  readonly population: PopulationSelection;
  readonly attempts: readonly PilotAttempt[];
  readonly human_grades: readonly PilotHumanGrade[];
  readonly annotation_imports: readonly PilotAnnotationImport[];
  readonly examples: readonly PilotExample[];
}
export interface PilotExample { readonly occurrence_id: string; readonly evidence_refs: readonly string[];
  readonly finding: string }
export interface PilotOperation { readonly operation: string; readonly entity_id: string;
  readonly status: number; readonly detail: string }
export interface PilotRunOutput {
  readonly format_version: "langfuse-pilot-run/v1";
  readonly population: PopulationManifest;
  readonly assay_manifest: ExportManifest | null;
  readonly measurements: readonly ComparisonMeasurement[];
  readonly operations: readonly PilotOperation[];
  readonly examples: readonly PilotExample[];
}

async function request(base_url: string, token: string, path: string, body: unknown): Promise<{
  readonly status: number; readonly value: unknown }> {
  const response = await fetch(new URL(path, base_url), { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
function operation(name: string, entity_id: string, response: { readonly status: number; readonly value: unknown }): PilotOperation {
  return { operation: name, entity_id, status: response.status,
    detail: response.status < 300 ? "recorded" : JSON.stringify(response.value) };
}

export async function runPilot(plan: PilotRunPlan, environment: NodeJS.ProcessEnv,
  freeze: (manifest: PopulationManifest) => Promise<void> = async () => {}): Promise<PilotRunOutput> {
  const database_url = environment.OBSERVATION_DATABASE_URL;
  const base_url = environment.OBSERVATION_PILOT_BASE_URL;
  const grade_token = environment.OBSERVATION_PILOT_GRADE_TOKEN;
  const read_token = environment.OBSERVATION_PILOT_READ_TOKEN;
  if (!database_url || !base_url || !grade_token || !read_token)
    throw new Error("OBSERVATION_DATABASE_URL, OBSERVATION_PILOT_BASE_URL, GRADE_TOKEN and READ_TOKEN are required");
  const db = openDatabase(database_url);
  try {
    const eligibility = (await Promise.all(plan.population.question_pins.map((pin) =>
      readEligibility(db, plan.tenant, pin.question_id, pin.question_version)))).flat();
    const population = makePopulationManifestFromEligibility(plan.population, eligibility);
    if (!population.ok) throw new Error(population.error.detail);
    if (population.value.membership.filter((member) => member.disposition === "included").length < 10
      || population.value.membership.filter((member) => member.disposition === "included").length > 30)
      throw new Error("pilot requires 10 to 30 included item-level cases");
    const included = population.value.membership.filter((member) => member.disposition === "included");
    for (const stratum of ["clearly_easy", "borderline", "known_failure"] as const)
      if (!included.some((member) => member.stratum === stratum)) throw new Error(`pilot lacks ${stratum} cases`);
    for (const pin of population.value.question_pins) {
      const catalogue = LANGFUSE_PILOT_QUESTIONS[pin.question_id as PilotQuestionId];
      if (!catalogue || catalogue.definition.question_version !== pin.question_version)
        throw new Error(`question pin is outside pilot catalogue: ${pin.question_id}@${pin.question_version}`);
    }
    for (const member of included) if (!plan.attempts.some((attempt) =>
      attempt.identity.subject_occurrence_id === member.occurrence_id
        && attempt.identity.question_id === member.question_id
        && attempt.identity.question_version === member.question_version))
      throw new Error(`included case has no planned measurement: ${member.occurrence_id}`);
    for (const example of plan.examples) if (!population.value.membership.some((member) =>
      member.disposition === "included" && member.occurrence_id === example.occurrence_id))
      throw new Error(`example is outside frozen population: ${example.occurrence_id}`);
    const operations: PilotOperation[] = [];
    for (const member of population.value.membership) {
      const source = await withTenant(db, plan.tenant, (trx) => trx.selectFrom("observation.item_occurrence")
        .innerJoin("observation.source_revision", (join) => join.onRef("observation.source_revision.producer", "=", "observation.item_occurrence.producer")
          .onRef("observation.source_revision.namespace", "=", "observation.item_occurrence.namespace")
          .onRef("observation.source_revision.revision_id", "=", "observation.item_occurrence.revision_id"))
        .select("observation.source_revision.body_digest")
        .where("observation.item_occurrence.producer", "=", plan.tenant.producer)
        .where("observation.item_occurrence.namespace", "=", plan.tenant.namespace)
        .where("observation.item_occurrence.occurrence_id", "=", member.occurrence_id).executeTakeFirst());
      if (!source) throw new Error(`selected occurrence has no captured revision: ${member.occurrence_id}`);
    }
    await freeze(population.value);
    for (const attempt of plan.attempts) {
      const member = population.value.membership.find((candidate) => candidate.occurrence_id === attempt.identity.subject_occurrence_id
        && candidate.question_id === attempt.identity.question_id && candidate.question_version === attempt.identity.question_version);
      const evidence = evidenceSetDigest(attempt.context.evidence);
      if (!member || member.disposition !== "included" || !evidence.ok
        || member.evidence_set_digest !== evidence.value)
        throw new Error(`attempt is outside frozen population: ${attempt.identity.subject_occurrence_id}`);
      const catalogue = LANGFUSE_PILOT_QUESTIONS[attempt.identity.question_id as PilotQuestionId];
      const planned = canonicalJson(attempt.context.question);
      const pinned = catalogue ? canonicalJson(catalogue.definition) : null;
      if (!catalogue || attempt.question_text !== catalogue.text || !planned.ok || !pinned?.ok
        || planned.value !== pinned.value)
        throw new Error(`attempt differs from pinned pilot question: ${attempt.identity.question_id}`);
      const evaluated = await request(base_url, grade_token, "/v1/evaluations", attempt);
      operations.push(operation("evaluate", attempt.identity.subject_occurrence_id, evaluated));
      if (evaluated.status >= 300) continue;
      const result = evaluated.value as { execution?: { execution_id?: string } };
      if (!result.execution?.execution_id) continue;
      const projected = await request(base_url, grade_token, "/v1/langfuse/projections", {
        execution_id: result.execution.execution_id, question_text: attempt.question_text,
        projection_version: population.value.projection_version });
      operations.push(operation("project", result.execution.execution_id, projected));
    }
    for (const label of plan.human_grades) {
      const submitted = await request(base_url, grade_token, "/v1/grades", label);
      operations.push(operation("human_grade", label.identity.subject_occurrence_id, submitted));
    }
    for (const label of plan.annotation_imports) {
      const imported = await request(base_url, grade_token, "/v1/langfuse/annotations/import", {
        ...label, allow_notes: false });
      operations.push(operation("annotation_import", label.mapping_key, imported));
    }
    const included_ids = [...new Set(population.value.membership.filter((member) => member.disposition === "included")
      .map((member) => member.occurrence_id))];
    const exported = await request(base_url, read_token, "/v1/exports/assay", {
      selection: { occurrence_ids: included_ids }, target: { name: "langfuse-pilot" } });
    operations.push(operation("assay_export", population.value.manifest_id, exported));
    const assay_manifest = exported.status === 201
      ? (exported.value as { manifest: ExportManifest }).manifest : null;
    if (assay_manifest) {
      const digest = assayItemEvidenceDigest(assay_manifest);
      operations.push({ operation: "population_match", entity_id: assay_manifest.manifest_id,
        status: digest.ok && digest.value === population.value.shared_item_evidence_digest ? 200 : 409,
        detail: digest.ok ? (digest.value === population.value.shared_item_evidence_digest ? "item and evidence digests match"
          : "Assay included membership differs from frozen Langfuse population") : digest.error.detail });
    }
    const measurements: ComparisonMeasurement[] = [];
    for (const attempt of plan.attempts) {
      const digest = evaluationDigest(attempt.identity);
      if (!digest.ok) throw new Error(digest.error.detail);
      const member = population.value.membership.find((candidate) => candidate.occurrence_id === attempt.identity.subject_occurrence_id
        && candidate.question_id === attempt.identity.question_id && candidate.question_version === attempt.identity.question_version)!;
      const version = evaluatorIdentity(attempt.context.evaluator);
      if (!version.ok) throw new Error(version.error.detail);
      const snapshot = await withTenant(db, plan.tenant, async (trx) => {
        const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
          .where("producer", "=", plan.tenant.producer).where("namespace", "=", plan.tenant.namespace)
          .where("idempotency_digest", "=", digest.value).executeTakeFirst();
        const observation = execution ? await trx.selectFrom("observation.grade_observation").selectAll()
          .where("producer", "=", plan.tenant.producer).where("namespace", "=", plan.tenant.namespace)
          .where("execution_id", "=", execution.execution_id).executeTakeFirst() : null;
        const possible_human = await trx.selectFrom("observation.grade_observation").selectAll()
          .where("producer", "=", plan.tenant.producer).where("namespace", "=", plan.tenant.namespace)
          .where("subject_occurrence_id", "=", member.occurrence_id)
          .where("question_id", "=", member.question_id).where("question_version", "=", member.question_version)
          .orderBy("recorded_at", "desc").execute();
        const human = possible_human.find((grade) => grade.label_origin !== "other"
          || plan.human_grades.some((label) => label.identity.evaluator_definition_id === grade.evaluator_definition_id)) ?? null;
        return { execution, observation, human };
      });
      measurements.push({ member, split: attempt.split, evaluator_version: version.value,
        attempt_label: attempt.identity.attempt_label,
        execution: snapshot.execution as unknown as EvaluationExecution | null ?? null,
        observation: snapshot.observation ? { ...snapshot.observation,
          answer: snapshot.observation.answer_payload } as unknown as GradeObservation : null,
        human_label: snapshot.human ? { answer: snapshot.human.answer_payload as GradeObservation["answer"],
          origin: snapshot.human.label_origin === "other" ? "direct_human_unblinded" :
            snapshot.human.label_origin as "langfuse_annotation_blinded" | "oakridge_operator_unblinded",
          reviewer_id: snapshot.human.reviewer_id ?? "unknown" } : null,
        disagreement_cause: attempt.disagreement_cause });
    }
    return { format_version: "langfuse-pilot-run/v1", population: population.value,
      assay_manifest, measurements, operations, examples: plan.examples };
  } finally { await db.destroy(); }
}

if (import.meta.main) {
  const [plan_path, output_path] = Bun.argv.slice(2);
  if (!plan_path || !output_path) throw new Error("usage: bun langfuse-pilot-run.ts <plan.json> <output.json>");
  const plan = await Bun.file(plan_path).json() as PilotRunPlan;
  const output = await runPilot(plan, process.env,
    async (manifest) => { await Bun.write(`${output_path}.population.json`, `${JSON.stringify(manifest, null, 2)}\n`); });
  await Bun.write(output_path, `${JSON.stringify({ run_id: randomUUID(), ...output }, null, 2)}\n`);
  if (output.operations.some((item) => item.status >= 300)) process.exitCode = 2;
}
