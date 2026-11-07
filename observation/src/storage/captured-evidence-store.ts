import type { Selectable } from "kysely";
import type { EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { COLLECTION_PENDING, evidenceSetId, type EvidenceReadiness, type EvidenceReference, type EvidenceSet } from "../grading/evidence";
import type { QuestionKey } from "../grading/question";
import type { ArtifactSource, EvidenceCollection } from "../ports/artifact-source";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationEvidenceSet } from "./db-types";

/** One configured question and the evaluators an occurrence of its item kind is pinned to. */
export interface CapturePin extends QuestionKey {
  readonly item_kind: string;
  readonly evaluator_definition_ids: readonly EvaluatorDefinitionId[];
}
/** The configuration in force when an occurrence is captured. Later edits reach later captures. */
export interface CaptureConfiguration { readonly pins: readonly CapturePin[] }
export const NO_CAPTURE_PINS: CaptureConfiguration = { pins: [] };

export interface EvidenceStoreError { readonly operation: "evidence_store"; readonly entity_id: string; readonly detail: string }

/** Pin every applicable question in the capture transaction, whether or not its evidence exists,
 * whether or not automatic grading is on, and without any execution. */
export async function pinOccurrenceInTransaction(trx: DatabaseTransaction, tenant: TenantScope, occurrence_id: ItemOccurrenceId,
  item_kind: string, configuration: CaptureConfiguration): Promise<void> {
  for (const pin of configuration.pins.filter((candidate) => candidate.item_kind === item_kind)) {
    const id = evidenceSetId(occurrence_id, pin);
    if (!id.ok) throw new Error(id.error.detail);
    await trx.insertInto("observation.evidence_set").values({ producer: tenant.producer, namespace: tenant.namespace,
      evidence_set_id: id.value, subject_occurrence_id: occurrence_id, question_id: pin.question_id,
      question_version: pin.question_version, pinned_evaluator_definition_ids: [...pin.evaluator_definition_ids],
      readiness: "not_ready", not_ready_code: COLLECTION_PENDING.code, not_ready_detail: COLLECTION_PENDING.detail,
      incompleteness_reason: null, ready_at: null })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "evidence_set_id"]).doNothing()).execute();
  }
}

export function evidenceSetFromRow(row: Selectable<ObservationEvidenceSet>): EvidenceSet {
  const readiness: EvidenceReadiness = row.readiness === "ready"
    ? { state: "ready", references: row.evidence_refs as unknown as readonly EvidenceReference[], ready_at: row.ready_at! }
    : { state: "not_ready", reason: { code: row.not_ready_code!, detail: row.not_ready_detail! } };
  return { evidence_set_id: row.evidence_set_id as EvidenceSetId, subject_occurrence_id: row.subject_occurrence_id as ItemOccurrenceId,
    question_id: row.question_id as QuestionId, question_version: row.question_version,
    pinned_evaluator_definition_ids: row.pinned_evaluator_definition_ids as EvaluatorDefinitionId[], readiness,
    is_incomplete: row.is_incomplete, incompleteness_reason: row.incompleteness_reason };
}

/** Every question pinned to an occurrence, each with its own readiness. */
export async function readOccurrenceEvidence(db: Database, tenant: TenantScope, occurrence_id: ItemOccurrenceId): Promise<readonly EvidenceSet[]> {
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("subject_occurrence_id", "=", occurrence_id).orderBy("question_id").orderBy("question_version").execute());
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
