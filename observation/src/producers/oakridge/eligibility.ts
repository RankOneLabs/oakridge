import { err, ok, type Result } from "../../domain/primitives";
import type { QuestionId } from "../../domain/identity";
import { recordEligibility, type EligibilityStoreError } from "../../storage/eligibility-store";
import type { Database, TenantScope } from "../../storage/database";
import type { RunPackages } from "./evidence-packages";

/** Persist the manifest's complete population, including deferred pilot questions. */
export async function persistOakridgeEligibility(db: Database, tenant: TenantScope, manifest: RunPackages)
  : Promise<Result<number, EligibilityStoreError>> {
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
