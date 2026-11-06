import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { jsonText, withTenant, type Database } from "../src/storage/database";
import { evidenceSetId } from "../src/grading/evidence";
import { evidence, evaluator, question, tenant } from "./grading-fixture";

/** Seed target-schema rows directly; the service has no grading admission writer in this cohort. */
export async function seedGradingRecords(db: Database, occurrence_id: ItemOccurrenceId, is_incomplete = false) {
  const identity = { subject_occurrence_id: occurrence_id, question_id: question.question_id, question_version: question.question_version };
  const id = evidenceSetId(identity);
  const digest = canonicalDigest(["fixture-evaluator"]);
  if (!id.ok || !digest.ok) throw new Error("fixture identity cannot be encoded");
  await withTenant(db, tenant, async (trx) => {
    await trx.insertInto("observation.question_definition").values({ ...tenant, ...question }).execute();
    await trx.insertInto("observation.evidence_set").values({ ...tenant, ...identity, evidence_set_id: id.value,
      evidence_refs: jsonText(is_incomplete ? [] : evidence.references.map((reference) => ({ ref: reference.ref, content: reference.content }))), is_incomplete,
      incompleteness_reason: is_incomplete ? "source not captured" : null }).execute();
    await trx.insertInto("observation.evaluator_definition").values({ ...tenant, ...evaluator("human"), identity_digest: digest.value }).execute();
  });
  return id.value;
}
