import type { ItemOccurrenceId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { CapturedItem } from "../grading/evidence-packages/capture";
import type { EvidenceSet } from "../grading/evidence";
import type { EligibilityDecision } from "../grading/eligibility";
import type { QuestionDefinition } from "../grading/question";
import { runPackages } from "../producers/oakridge/evidence-packages";
import type { Database, TenantScope } from "./database";
import { loadRunCapture } from "./run-capture-store";

export interface CapturedEvidenceSelection {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question: QuestionDefinition;
}
export interface CapturedEvidence {
  readonly subject: CapturedItem;
  readonly revision_id: string;
  readonly evidence: EvidenceSet | null;
  readonly decision: EligibilityDecision;
}
export interface CapturedEvidenceError {
  readonly operation: "captured_evidence";
  readonly entity_id: string;
  readonly detail: string;
}

/** One live capture-to-package path for a specific subject and immutable question pin. */
export async function deriveCapturedEvidence(db: Database, tenant: TenantScope, run_id: string,
  selection: CapturedEvidenceSelection): Promise<Result<CapturedEvidence, CapturedEvidenceError>> {
  const fail = (detail: string) => err({ operation: "captured_evidence" as const,
    entity_id: selection.subject_occurrence_id, detail });
  const capture = await loadRunCapture(db, tenant, run_id);
  if (!capture.ok) return fail(capture.error.detail);
  const subject = capture.value.flatMap((revision) => revision.items)
    .find((item) => item.occurrence_id === selection.subject_occurrence_id);
  if (!subject) return fail("subject occurrence is absent from captured run");
  const question = selection.question;
  const manifest = runPackages(capture.value, { [question.question_id]: { definition: question, text: question.question_text ?? "" } });
  if (!manifest.ok) return fail(manifest.error.detail);
  const decision = manifest.value.eligibility.find((item) => item.question_id === question.question_id
    && item.occurrence_id === subject.occurrence_id)?.decision;
  if (!decision) return fail("question does not target captured subject");
  const pack = decision.tag === "eligible" ? manifest.value.packages.find((item) =>
    item.subject.occurrence_id === subject.occurrence_id && item.question_id === question.question_id
    && item.evidence.evidence_set_id === decision.payload.evidence_set_id) : undefined;
  if (decision.tag === "eligible" && !pack) return fail("eligible decision has no captured evidence package");
  return ok({ subject, revision_id: pack?.revision_id ?? subject.revision_id,
    evidence: pack?.evidence ?? null, decision });
}
