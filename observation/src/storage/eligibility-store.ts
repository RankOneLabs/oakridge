import { sql, type Selectable } from "kysely";
import type { ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { PinnedExpectation, QuestionDefinition } from "../grading/question";
import { hasCapturedEvidenceRecipe, schemaSupport } from "../grading/evidence-packages/recipe";
import { pinnedPilotRecipe } from "../grading/evidence-packages/pilot-recipe";
import { deriveRunQuestionEvidence, deriveSubjectEvidence, subjectEvidenceFrom, type RunQuestionEvidence } from "./captured-evidence-store";
import type { ObservationQuestionDefinition } from "./db-types";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import { provenanceEligibility, type EligibilityRow, type ProvenanceDecision, type GradingSupportRow, type EvidenceReadiness, type GradingExecutionState } from "../grading/eligibility";
import type { Page } from "./projection-store";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";

export interface EligibilityStoreError { readonly operation: "eligibility_store"; readonly entity_id: string; readonly detail: string }

/** Cache the derived decision for a question pin and captured subject occurrence. The row is a
 * cache, so a later derivation refreshes it; an exclusion recorded before its evidence arrived
 * must not outlive the capture that settles it. An `eligible` row is the exception and is never
 * overwritten, because an assignment or execution pins the evidence set it names. */
export async function recordEligibility(db: Database, tenant: TenantScope, row: EligibilityRow)
  : Promise<Result<void, EligibilityStoreError>> {
  if (row.producer !== tenant.producer || row.namespace !== tenant.namespace)
    return err({ operation: "eligibility_store", entity_id: row.subject_occurrence_id, detail: "tenant differs from row" });
  try {
    await withTenant(db, tenant, (trx) => trx.insertInto("observation.evaluation_eligibility").values({
      producer: row.producer, namespace: row.namespace, subject_occurrence_id: row.subject_occurrence_id,
      question_id: row.question_id, question_version: row.question_version, tag: row.tag,
      payload: sql<JsonValue>`${JSON.stringify(row.payload)}::jsonb`,
    }).onConflict((conflict) => conflict.columns(["producer", "namespace", "subject_occurrence_id", "question_id", "question_version"])
      .doUpdateSet({ tag: row.tag, payload: sql<JsonValue>`${JSON.stringify(row.payload)}::jsonb`,
        recorded_at: sql<Date>`clock_timestamp()` })
      .where(sql<boolean>`observation.evaluation_eligibility.tag <> 'eligible'`)).execute());
    return ok(undefined);
  } catch (cause) {
    return err({ operation: "eligibility_store", entity_id: row.subject_occurrence_id, detail: String(cause) });
  }
}

export interface EligibilitySelection extends Page {
  readonly run_id: string;
  readonly revision_id?: string | null;
  readonly question_id: string;
  readonly question_version: string;
}
export interface EligibilityPage extends Page {
  readonly items: readonly EligibilityRow[];
  readonly total: number;
}

async function storedEligibility(db: Database, tenant: TenantScope, selection: EligibilitySelection,
  subject_ids: readonly string[]): Promise<readonly EligibilityRow[]> {
  if (subject_ids.length === 0) return [];
  const rows = await withTenant(db, tenant, (trx) => {
    let query = trx.selectFrom("observation.evaluation_eligibility as e")
      .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "e.producer")
        .onRef("i.namespace", "=", "e.namespace").onRef("i.occurrence_id", "=", "e.subject_occurrence_id"))
      .selectAll("e").where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace)
      .where("i.run_id", "=", selection.run_id).where("e.subject_occurrence_id", "in", subject_ids)
      .where("e.question_id", "=", selection.question_id).where("e.question_version", "=", selection.question_version)
      .orderBy("e.subject_occurrence_id").limit(selection.limit);
    if (selection.revision_id) query = query.where("i.revision_id", "=", selection.revision_id);
    return query.execute();
  });
  return rows.map((row) => ({ producer: row.producer, namespace: row.namespace,
    subject_occurrence_id: row.subject_occurrence_id as EligibilityRow["subject_occurrence_id"],
    question_id: row.question_id as EligibilityRow["question_id"], question_version: row.question_version,
    tag: row.tag, payload: row.payload } as EligibilityRow));
}

/** Convert the relational question pin to its public domain contract. */
export function questionFromRow(row: Selectable<ObservationQuestionDefinition>): QuestionDefinition {
  return { ...row, question_id: row.question_id as QuestionId,
    pinned_expectation: { definition_id: row.expected_definition_id, artifact_schema_version: row.expected_artifact_schema_version },
    target_item_kinds: row.target_item_kinds as QuestionDefinition["target_item_kinds"],
    input_recipe: row.input_recipe as QuestionDefinition["input_recipe"],
    response_kind: row.response_kind as QuestionDefinition["response_kind"],
    allowed_values: row.allowed_values as QuestionDefinition["allowed_values"],
    missing_evidence_policy: row.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"] };
}

export interface ProvenanceSelection {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly pinned_expectation?: PinnedExpectation;
}

/** Read only capture identity: unsupported inputs never require an artifact decoder. */
export async function subjectProvenance(trx: DatabaseTransaction, tenant: TenantScope, input: ProvenanceSelection)
  : Promise<Result<ProvenanceDecision, EligibilityStoreError>> {
  const fail = (detail: string) => err({ operation: "eligibility_store" as const, entity_id: input.subject_occurrence_id, detail });
  const recorded = await trx.selectFrom("observation.item_occurrence as i")
    .innerJoin("observation.source_revision as r", (join) => join.onRef("r.revision_id", "=", "i.revision_id")
      .onRef("r.producer", "=", "i.producer").onRef("r.namespace", "=", "i.namespace"))
    .select(["r.definition_id", "r.artifact_schema_version"])
    .where("i.producer", "=", tenant.producer).where("i.namespace", "=", tenant.namespace)
    .where("i.occurrence_id", "=", input.subject_occurrence_id).executeTakeFirst();
  if (!recorded) return fail("subject occurrence does not exist in namespace");
  let expected = input.pinned_expectation;
  if (!expected) {
    const question = await trx.selectFrom("observation.question_definition")
      .select(["expected_definition_id", "expected_artifact_schema_version"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("question_id", "=", input.question_id).where("question_version", "=", input.question_version).executeTakeFirst();
    if (!question) return fail("question definition does not exist in namespace");
    expected = { definition_id: question.expected_definition_id, artifact_schema_version: question.expected_artifact_schema_version };
  }
  return ok(provenanceEligibility(expected, recorded));
}

/** Check supplied pins before registration, or use the already registered immutable question. */
export async function checkGradingProvenance(db: Database, tenant: TenantScope, input: ProvenanceSelection)
  : Promise<Result<void, EligibilityStoreError>> {
  try {
    const decision = await withTenant(db, tenant, (trx) => subjectProvenance(trx, tenant, input));
    if (!decision.ok) return decision;
    return decision.value.tag === "eligible" ? ok(undefined) : err({ operation: "eligibility_store",
      entity_id: input.subject_occurrence_id, detail: decision.value.payload.reason });
  } catch (cause) {
    return err({ operation: "eligibility_store", entity_id: input.subject_occurrence_id, detail: String(cause) });
  }
}

/** Gate metadata first, derive supported pilot decisions from captures, then record each pin once. */
export async function readEligibility(db: Database, tenant: TenantScope, selection: EligibilitySelection)
  : Promise<EligibilityPage> {
  const { question_id, question_version } = selection;
  const page = { limit: selection.limit, offset: selection.offset };
  const question_row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", question_id).where("question_version", "=", question_version).executeTakeFirst());
  if (!question_row) return { ...page, items: [], total: 0 };
  const question = questionFromRow(question_row);
  // The subject's artifact kind comes from the question's own pin, so a read never consults a
  // producer-side table keyed by question id. A judge pin binds no artifact kind and filters none.
  const subject_artifact_kind = pinnedPilotRecipe(question)?.subject.artifact_kind ?? null;
  const population = await withTenant(db, tenant, async (trx) => {
    let query = trx.selectFrom("observation.item_occurrence as i")
    .innerJoin("observation.source_revision as r", (join) => join.onRef("r.revision_id", "=", "i.revision_id")
      .onRef("r.producer", "=", "i.producer").onRef("r.namespace", "=", "i.namespace"))
    .where("i.producer", "=", tenant.producer).where("i.namespace", "=", tenant.namespace)
    .where("i.run_id", "=", selection.run_id).where("i.item_kind", "in", question.target_item_kinds);
    if (subject_artifact_kind) query = query.where("i.artifact_kind", "=", subject_artifact_kind);
    if (selection.revision_id) query = query.where("i.revision_id", "=", selection.revision_id);
    const count = await query.select(sql<string>`count(*)::text`.as("total")).executeTakeFirstOrThrow();
    const subjects = await query.select(["i.occurrence_id", "r.definition_id", "r.artifact_schema_version"])
      .orderBy("i.occurrence_id").limit(selection.limit).offset(selection.offset).execute();
    return { total: Number(count.total), subjects };
  });
  const subjects = population.subjects;
  const subject_ids = subjects.map((subject) => subject.occurrence_id);
  const stored = await storedEligibility(db, tenant, selection, subject_ids);
  const decisions = new Map(stored.map((row) => [String(row.subject_occurrence_id), row]));
  // Derive on every read, because a cached exclusion recorded before the subject's evidence was
  // captured would otherwise never settle. Derive once for the page, not once per subject: the
  // capture load and package build depend on the run and the pin, never on an individual subject.
  const derivable = hasCapturedEvidenceRecipe(question)
    && subjects.some((subject) => provenanceEligibility(question.pinned_expectation, subject).tag !== "inapplicable");
  let page_derivation: RunQuestionEvidence | undefined;
  if (derivable) {
    const derived = await deriveRunQuestionEvidence(db, tenant, selection.run_id, question);
    if (!derived.ok) throw new Error(derived.error.detail);
    page_derivation = derived.value;
  }
  for (const subject of subjects) {
    const decision = provenanceEligibility(question.pinned_expectation, subject);
    if (decision.tag === "inapplicable") {
      const row: EligibilityRow = { ...tenant, subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
        question_id: question.question_id, question_version, ...decision };
      const recorded = await recordEligibility(db, tenant, row);
      if (!recorded.ok) throw new Error(recorded.error.detail);
      decisions.set(subject.occurrence_id, row);
    } else if (page_derivation) {
      const derived = await deriveSubjectEvidence(db, tenant, { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
        question_id: question.question_id, question_version, question, derived: page_derivation });
      if (!derived.ok) throw new Error(derived.error.detail);
    }
  }
  // Re-read the refreshed cache. An inapplicable provenance decision stays authoritative here
  // because it is derived from the pin and the capture, not from evidence that can arrive later.
  const rows = await storedEligibility(db, tenant, selection, subject_ids);
  return { ...page, total: population.total, items: rows.map((row) => decisions.get(row.subject_occurrence_id)?.tag === "inapplicable"
    ? decisions.get(row.subject_occurrence_id)! : row) };
}

export interface SupportSelection extends Page {
  readonly run_id: string;
  readonly question_id?: string | null;
  readonly question_version?: string | null;
}
export interface GradingSupportPage extends Page {
  readonly query_version: "grading-support/v1";
  readonly run_id: string;
  readonly run_state: "no_captured_artifacts" | "no_applicable_question_pins" | "applicable_question_pins";
  readonly items: readonly GradingSupportRow[];
  readonly total: number;
}

/** Read-side contract: no writes to legacy eligibility or human coverage. Unsupported and
 * unready subjects stay in the population. Packages are derived once per question per run. */
export async function readGradingSupport(db: Database, tenant: TenantScope, selection: SupportSelection): Promise<GradingSupportPage> {
  const captured = await withTenant(db, tenant, async (trx) => {
    const revisions = await trx.selectFrom("observation.source_revision").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", selection.run_id).execute();
    const subjects = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", selection.run_id).orderBy("occurrence_id").execute();
    const questions = await trx.selectFrom("observation.question_definition").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .orderBy("question_id").orderBy("question_version").execute();
    const jobs = await trx.selectFrom("observation.grading_job").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", selection.run_id).orderBy("created_at", "desc").orderBy("job_id", "desc").execute();
    const executions = await trx.selectFrom("observation.evaluation_execution as x")
      .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "x.producer")
        .onRef("i.namespace", "=", "x.namespace").onRef("i.occurrence_id", "=", "x.subject_occurrence_id"))
      .selectAll("x").where("x.producer", "=", tenant.producer).where("x.namespace", "=", tenant.namespace)
      .where("i.run_id", "=", selection.run_id).orderBy("x.started_at", "desc").orderBy("x.execution_id", "desc").execute();
    return { revisions, subjects, questions: questions.map(questionFromRow), jobs, executions };
  });
  const pins = captured.questions.filter((question) => !selection.question_id
    || (question.question_id === selection.question_id && question.question_version === selection.question_version));
  const revisionById = new Map(captured.revisions.map((row) => [row.revision_id, row]));
  // This run-level diagnostic describes all registered pins, independently of the selected page.
  const hasApplicablePin = captured.revisions.some((revision) => captured.questions.some((question) => {
    const recipe = pinnedPilotRecipe(question);
    return revision.artifact_schema_version === question.pinned_expectation.artifact_schema_version
      && (!recipe || recipe.subject.artifact_kind === revision.artifact_kind);
  }));
  const pairs = captured.subjects.flatMap((subject) => pins.map((question) => ({ subject, question })));
  const pagePairs = pairs.slice(selection.offset, selection.offset + selection.limit);
  const derivations = new Map<string, Result<RunQuestionEvidence, import("./captured-evidence-store").CapturedEvidenceError>>();
  const items: GradingSupportRow[] = [];
  for (const { subject, question } of pagePairs) {
    const revision = revisionById.get(subject.revision_id)!;
    const provenance = { definition_id: revision.definition_id, artifact_schema_version: revision.artifact_schema_version };
    const support = schemaSupport(question, { ...provenance, item_kind: subject.item_kind, artifact_kind: subject.artifact_kind });
    let readiness: EvidenceReadiness = { state: "not_applicable" };
    if (support.state === "supported") {
      const key = `${question.question_id}/${question.question_version}`;
      if (!derivations.has(key)) derivations.set(key, await deriveRunQuestionEvidence(db, tenant, selection.run_id, question, "schema"));
      const derived = derivations.get(key)!;
      const evidence = derived.ok ? subjectEvidenceFrom(derived.value, question, subject.occurrence_id as ItemOccurrenceId) : derived;
      readiness = evidence.ok && evidence.value.evidence ? { state: "ready", evidence_set_id: evidence.value.evidence.evidence_set_id }
        : { state: "unready", reason: evidence.ok ? JSON.stringify(evidence.value.decision) : evidence.error.detail };
    }
    const matches = (row: { subject_occurrence_id: string; question_id: string; question_version: string }) =>
      row.subject_occurrence_id === subject.occurrence_id && row.question_id === question.question_id && row.question_version === question.question_version;
    const job = captured.jobs.find(matches);
    const execution = captured.executions.find(matches);
    const executionState: GradingExecutionState = job && ["queued", "claimed", "reclaimable"].includes(job.state)
      ? { state: "pending", job_id: job.job_id, execution_id: execution?.execution_id ?? null }
      : execution ? { state: execution.status === "completed" ? "completed" : execution.status === "failed" ? "failed" : "pending",
        job_id: job?.job_id ?? null, execution_id: execution.execution_id }
        : job ? { state: "failed", job_id: job.job_id, execution_id: null } : { state: "not_started" };
    items.push({ subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId, question_id: question.question_id,
      question_version: question.question_version, provenance, support, readiness, execution: executionState });
  }
  return { query_version: "grading-support/v1", run_id: selection.run_id,
    run_state: captured.revisions.length === 0 ? "no_captured_artifacts" : hasApplicablePin ? "applicable_question_pins" : "no_applicable_question_pins",
    items, total: pairs.length, limit: selection.limit, offset: selection.offset };
}
