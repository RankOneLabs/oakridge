import type { Selectable } from "kysely";
import type { EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, LogicalItemId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { COLLECTION_PENDING, evidenceSetId, gradingSubjects, isPinTarget, type CapturePin, type GradingSubject, type CaptureConfiguration, type EvidenceReadiness, type EvidenceReference, type EvidenceSet } from "../grading/evidence";
import type { ArtifactSource, EvidenceCollection } from "../ports/artifact-source";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationEvidenceSet } from "./db-types";

export interface EvidenceStoreError { readonly operation: "evidence_store"; readonly entity_id: string; readonly detail: string }

const TARGET_COLUMNS = ["occurrence_id", "json_pointer", "artifact_kind", "item_selector", "item_kind", "selected_value"] as const;

/** Pin every question whose declared target is this occurrence's artifact, selector and item kind, in the
 * capture transaction, whether or not its evidence exists, whether or not automatic grading is on, and
 * without any execution. */
export async function pinOccurrenceInTransaction(trx: DatabaseTransaction, tenant: TenantScope, occurrence_id: ItemOccurrenceId,
  configuration: CaptureConfiguration, resolved_task_id?: LogicalItemId): Promise<void> {
  const occurrence = await trx.selectFrom("observation.item_occurrence").select(TARGET_COLUMNS)
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("occurrence_id", "=", occurrence_id).executeTakeFirstOrThrow();
  const relations = await trx.selectFrom("observation.item_relation").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where((eb) => eb.or([eb("source_occurrence_id", "=", occurrence_id), eb("source_occurrence_id", "in",
      trx.selectFrom("observation.item_relation").select("target_occurrence_id").where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("source_occurrence_id", "=", occurrence_id))])).execute();
  for (const pin of configuration.pins.filter((candidate) => isPinTarget(candidate, occurrence))) {
    const subjects = gradingSubjects({ occurrence: { ...occurrence, occurrence_id }, scope: pin, relations });
    for (const subject of subjects.filter((subject) => resolved_task_id === undefined || subject.task_id === resolved_task_id)) {
      if (resolved_task_id !== undefined) {
        const existing = await trx.selectFrom("observation.evidence_set").select("evidence_set_id")
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("subject_occurrence_id", "=", occurrence_id).where("task_id", "=", resolved_task_id)
          .where("question_id", "=", pin.question_id).executeTakeFirst();
        if (existing) continue;
      }
      const pinned = await pinSubjectInTransaction(trx, tenant, { subject, pin });
      if (!pinned.ok) throw new Error(pinned.error.detail);
    }
  }
}

export interface SubjectPin { readonly subject: GradingSubject; readonly pin: CapturePin }
/** A caller cannot pin a question to an occurrence outside its declared target, nor a task that this
 * occurrence does not explicitly assess. Refusals write nothing. */
export async function pinSubjectInTransaction(trx: DatabaseTransaction, tenant: TenantScope, { subject, pin }: SubjectPin)
  : Promise<Result<void, EvidenceStoreError>> {
  const occurrence = await trx.selectFrom("observation.item_occurrence").select(TARGET_COLUMNS)
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("occurrence_id", "=", subject.subject_occurrence_id).executeTakeFirst();
  if (occurrence && !isPinTarget(pin, occurrence)) return err({ operation: "evidence_store", entity_id: subject.subject_occurrence_id,
    detail: `question ${pin.question_id} targets ${pin.artifact_kind} ${pin.item_selector}, not ${occurrence.artifact_kind} ${occurrence.item_selector}` });
  const relations = await trx.selectFrom("observation.item_relation").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where((eb) => eb.or([eb("source_occurrence_id", "=", subject.subject_occurrence_id), eb("source_occurrence_id", "in",
      trx.selectFrom("observation.item_relation").select("target_occurrence_id").where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("source_occurrence_id", "=", subject.subject_occurrence_id))])).execute();
  const permitted = occurrence && gradingSubjects({ occurrence: { ...occurrence, occurrence_id: subject.subject_occurrence_id },
    scope: pin, relations }).some((candidate) => candidate.task_id === subject.task_id);
  if (!permitted) return err({ operation: "evidence_store", entity_id: subject.subject_occurrence_id,
    detail: "task is not a resolved assesses target under the question's task_ids pointer" });
  const id = evidenceSetId({ ...subject, question: pin });
  if (!id.ok) return err({ operation: "evidence_store", entity_id: subject.subject_occurrence_id, detail: id.error.detail });
  await trx.insertInto("observation.evidence_set").values({ producer: tenant.producer, namespace: tenant.namespace,
    evidence_set_id: id.value, ...subject, question_id: pin.question_id,
    question_version: pin.question_version, collection_plan: pin.collection_plan ? jsonText(pin.collection_plan as unknown as JsonValue) : null, pinned_evaluator_definition_ids: [...pin.evaluator_definition_ids],
    readiness: "not_ready", not_ready_code: COLLECTION_PENDING.code, not_ready_detail: COLLECTION_PENDING.detail,
    incompleteness_reason: null, ready_at: null })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "subject_occurrence_id", "task_id", "question_id", "question_version"]).doNothing()).execute();
  return ok(undefined);
}

export function evidenceSetFromRow(row: Selectable<ObservationEvidenceSet>): EvidenceSet {
  const readiness: EvidenceReadiness = row.readiness === "ready"
    ? { state: "ready", references: row.evidence_refs as unknown as readonly EvidenceReference[], ready_at: row.ready_at! }
    : { state: "not_ready", reason: { code: row.not_ready_code!, detail: row.not_ready_detail! } };
  return { evidence_set_id: row.evidence_set_id as EvidenceSetId, subject_occurrence_id: row.subject_occurrence_id as ItemOccurrenceId,
    task_id: row.task_id as LogicalItemId | null, question_id: row.question_id as QuestionId, question_version: row.question_version,
    pinned_evaluator_definition_ids: row.pinned_evaluator_definition_ids as EvaluatorDefinitionId[], readiness,
    is_incomplete: row.is_incomplete, incompleteness_reason: row.incompleteness_reason };
}

/** Every question pinned to an occurrence, each with its own readiness. */
export async function readOccurrenceEvidence(db: Database, tenant: TenantScope, occurrence_id: ItemOccurrenceId): Promise<readonly EvidenceSet[]> {
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("subject_occurrence_id", "=", occurrence_id).orderBy("question_id").orderBy("question_version").orderBy("task_id").execute());
  return rows.map(evidenceSetFromRow);
}

/** Record one collection. A not-ready result replaces the waiting reason; a ready result freezes
 * the references. Ready evidence is already final, so a later collection leaves it untouched. */
export async function recordCollection(db: Database, tenant: TenantScope, evidence_set_id: EvidenceSetId, collection: EvidenceCollection)
  : Promise<Result<EvidenceSet, EvidenceStoreError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const waiting = trx.updateTable("observation.evidence_set").where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("evidence_set_id", "=", evidence_set_id).where("readiness", "=", "not_ready");
      await (collection.state === "ready"
        ? waiting.set({ readiness: "ready", not_ready_code: null, not_ready_detail: null, ready_at: new Date(),
          evidence_refs: jsonText(collection.references as unknown as JsonValue) })
        : waiting.set({ not_ready_code: collection.reason.code, not_ready_detail: collection.reason.detail })).execute();
      const row = await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("evidence_set_id", "=", evidence_set_id).executeTakeFirst();
      return row ? ok(evidenceSetFromRow(row))
        : err({ operation: "evidence_store" as const, entity_id: evidence_set_id, detail: "evidence set is not pinned in namespace" });
    });
  } catch (cause) { return err({ operation: "evidence_store", entity_id: evidence_set_id, detail: String(cause) }); }
}

/** Collect one pinned question through the port and record its outcome. Ready evidence is not
 * collected again, so a retry cannot change what earlier answers were given. */
export async function collectPinnedQuestion(db: Database, tenant: TenantScope, source: ArtifactSource, evidence: EvidenceSet)
  : Promise<Result<EvidenceSet, EvidenceStoreError>> {
  if (evidence.readiness.state === "ready") return ok(evidence);
  const artifact = await source.read(evidence.subject_occurrence_id);
  if (!artifact) return err({ operation: "evidence_store", entity_id: evidence.subject_occurrence_id,
    detail: "subject occurrence is outside this source" });
  return recordCollection(db, tenant, evidence.evidence_set_id, await source.collect(artifact, evidence));
}

/** The questions of one run still waiting for evidence, oldest first. */
export async function readWaitingEvidence(db: Database, tenant: TenantScope, run_id: string): Promise<readonly EvidenceSet[]> {
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set as e")
    .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "e.producer")
      .onRef("i.namespace", "=", "e.namespace").onRef("i.occurrence_id", "=", "e.subject_occurrence_id"))
    .selectAll("e").where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace)
    .where("i.run_id", "=", run_id).where("e.readiness", "=", "not_ready")
    .orderBy("e.created_at").orderBy("e.evidence_set_id").execute());
  return rows.map(evidenceSetFromRow);
}

/** Runs with any question still waiting, so a restart can retry them. */
export async function readWaitingRuns(db: Database, tenant: TenantScope): Promise<readonly string[]> {
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set as e")
    .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "e.producer")
      .onRef("i.namespace", "=", "e.namespace").onRef("i.occurrence_id", "=", "e.subject_occurrence_id"))
    .select("i.run_id").distinct().where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace)
    .where("e.readiness", "=", "not_ready").orderBy("i.run_id").execute());
  return rows.map((row) => row.run_id);
}

/** What one pass over a run's waiting questions found. */
export interface RunCollection {
  readonly run_id: string;
  readonly ready: readonly EvidenceSetId[];
  readonly waiting: readonly { readonly evidence_set_id: EvidenceSetId; readonly code: string }[];
  readonly failed: readonly EvidenceStoreError[];
}

/** Collect each waiting question of a run on its own. A question that stays not ready, or whose
 * collection fails, holds back nothing else. */
export async function collectWaitingEvidence(db: Database, tenant: TenantScope, source: ArtifactSource, run_id: string): Promise<RunCollection> {
  const ready: EvidenceSetId[] = [];
  const waiting: { evidence_set_id: EvidenceSetId; code: string }[] = [];
  const failed: EvidenceStoreError[] = [];
  for (const pinned of await readWaitingEvidence(db, tenant, run_id)) {
    const collected = await collectPinnedQuestion(db, tenant, source, pinned).catch((cause: unknown): Result<EvidenceSet, EvidenceStoreError> =>
      err({ operation: "evidence_store", entity_id: pinned.evidence_set_id, detail: String(cause) }));
    if (!collected.ok) failed.push(collected.error);
    else if (collected.value.readiness.state === "ready") ready.push(collected.value.evidence_set_id);
    else waiting.push({ evidence_set_id: collected.value.evidence_set_id, code: collected.value.readiness.reason.code });
  }
  return { run_id, ready, waiting, failed };
}
