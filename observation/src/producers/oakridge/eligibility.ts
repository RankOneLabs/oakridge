import { err, ok, type Result } from "../../domain/primitives";
import type { QuestionId } from "../../domain/identity";
import { recordEligibility, type EligibilityStoreError } from "../../storage/eligibility-store";
import { jsonText, withTenant, type Database, type TenantScope } from "../../storage/database";
import type { RunPackages } from "./evidence-packages";

/** Persist the manifest's complete population, including deferred pilot questions. */
export async function persistOakridgeEligibility(db: Database, tenant: TenantScope, manifest: RunPackages)
  : Promise<Result<number, EligibilityStoreError>> {
  try {
    await withTenant(db, tenant, async (trx) => {
      for (const pack of manifest.packages) await trx.insertInto("observation.evidence_set").values({
        producer: tenant.producer, namespace: tenant.namespace, evidence_set_id: pack.evidence.evidence_set_id,
        evidence_refs: jsonText(pack.evidence.references as unknown as import("../../domain/primitives").JsonValue),
        is_incomplete: pack.evidence.is_incomplete, incompleteness_reason: pack.evidence.incompleteness_reason,
      }).onConflict((conflict) => conflict.columns(["producer", "namespace", "evidence_set_id"]).doNothing()).execute();
    });
  } catch (cause) { return err({ operation: "eligibility_store", entity_id: tenant.namespace, detail: String(cause) }); }
  let count = 0;
  for (const item of manifest.eligibility) {
    const result = await recordEligibility(db, tenant, { producer: tenant.producer, namespace: tenant.namespace,
      subject_occurrence_id: item.occurrence_id, question_id: item.question_id as QuestionId,
      question_version: "v1", ...item.decision });
    if (!result.ok) return err(result.error);
    count++;
  }
  return ok(count);
}
