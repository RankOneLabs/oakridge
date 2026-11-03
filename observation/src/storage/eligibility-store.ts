import { sql, type Selectable } from "kysely";
import type { ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { PinnedExpectation, QuestionDefinition } from "../grading/question";
import { PILOT_EVIDENCE_RECIPES } from "../grading/evidence-packages/pilot-recipe";
import { hasJudgeRecipe } from "../grading/evidence-packages/judge-recipe";
import { pilotSubjectArtifactKind } from "../producers/oakridge/evidence-packages";
import { deriveSubjectEvidence } from "./captured-evidence-store";
import type { ObservationQuestionDefinition } from "./db-types";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import { provenanceEligibility, type EligibilityRow, type ProvenanceDecision } from "../grading/eligibility";
import type { Page } from "./projection-store";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";

export interface EligibilityStoreError { readonly operation: "eligibility_store"; readonly entity_id: string; readonly detail: string }

/** A question pin receives one immutable decision for each captured subject occurrence. */
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
      .doNothing()).execute());
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
  const subject_artifact_kind = pilotSubjectArtifactKind(question_id);
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
  for (const subject of subjects) {
    const decision = provenanceEligibility(question.pinned_expectation, subject);
    if (decision.tag === "inapplicable") {
      const row: EligibilityRow = { ...tenant, subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
        question_id: question.question_id, question_version, ...decision };
      const recorded = await recordEligibility(db, tenant, row);
      if (!recorded.ok) throw new Error(recorded.error.detail);
      decisions.set(subject.occurrence_id, row);
    } else if (!decisions.has(subject.occurrence_id) && (Object.hasOwn(PILOT_EVIDENCE_RECIPES, question_id) || hasJudgeRecipe(question))) {
      const derived = await deriveSubjectEvidence(db, tenant, { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
        question_id: question.question_id, question_version, question });
      if (!derived.ok) throw new Error(derived.error.detail);
    }
  }
  // Concurrent reads may have won the insert; return the authoritative first decisions.
  const rows = await storedEligibility(db, tenant, selection, subject_ids);
  return { ...page, total: population.total, items: rows.map((row) => decisions.get(row.subject_occurrence_id)?.tag === "inapplicable"
    ? decisions.get(row.subject_occurrence_id)! : row) };
}
