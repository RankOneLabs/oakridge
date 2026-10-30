import { sql } from "kysely";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import type { EligibilityRow } from "../grading/eligibility";
import { withTenant, type Database, type TenantScope } from "./database";

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
    }).execute());
    return ok(undefined);
  } catch (cause) {
    return err({ operation: "eligibility_store", entity_id: row.subject_occurrence_id, detail: String(cause) });
  }
}

export async function readEligibility(db: Database, tenant: TenantScope, question_id: string, question_version: string)
  : Promise<readonly EligibilityRow[]> {
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility")
    .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", question_id).where("question_version", "=", question_version)
    .orderBy("subject_occurrence_id").orderBy("recorded_at").orderBy("eligibility_id").execute());
  return rows.map((row) => ({ producer: row.producer, namespace: row.namespace,
    subject_occurrence_id: row.subject_occurrence_id as EligibilityRow["subject_occurrence_id"],
    question_id: row.question_id as EligibilityRow["question_id"], question_version: row.question_version,
    tag: row.tag, payload: row.payload } as EligibilityRow));
}
