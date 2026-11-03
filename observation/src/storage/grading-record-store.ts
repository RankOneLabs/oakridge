import { withTenant, type Database, type TenantScope } from "./database";

/** Immutable admission records, read under the same tenant boundary as executions. */
export interface QuestionRecordKey { readonly question_id: string; readonly question_version: string }
export function readQuestionRecord(db: Database, tenant: TenantScope, key: QuestionRecordKey) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", key.question_id).where("question_version", "=", key.question_version)
    .executeTakeFirst());
}
export function readEvidenceSetRecord(db: Database, tenant: TenantScope, evidence_set_id: string) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("evidence_set_id", "=", evidence_set_id).executeTakeFirst());
}
