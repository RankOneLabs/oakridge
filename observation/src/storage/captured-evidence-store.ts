import type { ItemOccurrenceId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { CapturedItem } from "../grading/evidence-packages/capture";
import { requiresRepositorySnapshot } from "../grading/evidence-packages/recipe";
import type { EvidenceSet } from "../grading/evidence";
import type { EligibilityDecision } from "../grading/eligibility";
import type { QuestionDefinition } from "../grading/question";
import { runPackages, type PackageBatch } from "../producers/oakridge/evidence-packages";
import { withTenant, type Database, type TenantScope } from "./database";
import { persistOakridgeEligibility } from "../producers/oakridge/eligibility";
import { registerQuestion } from "./grading-store";
import { questionFromRow, checkGradingProvenance } from "./eligibility-store";
import { CaptureArtifactSource } from "./capture-artifact-source";
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

/** Every captured subject's decision for one question pin. The work here depends on the run and
 * the pin, never on an individual subject, so a page of subjects derives it once. */
export interface RunQuestionEvidence {
  readonly subjects: readonly CapturedItem[];
  readonly packages: PackageBatch;
}

/** Load the run's capture and build its packages for one immutable question pin. */
export async function deriveRunQuestionEvidence(db: Database, tenant: TenantScope, run_id: string,
  question: QuestionDefinition, provenance_policy: "legacy" | "schema" = "legacy"): Promise<Result<RunQuestionEvidence, CapturedEvidenceError>> {
  const fail = (detail: string) => err({ operation: "captured_evidence" as const, entity_id: run_id, detail });
  const capture = await loadRunCapture(db, tenant, run_id);
  if (!capture.ok) return fail(capture.error.detail);
  const subjects = capture.value.flatMap((revision) => revision.items);
  const sources = new Map<ItemOccurrenceId, EvidenceSet>();
  if (requiresRepositorySnapshot(question)) {
    try {
      const source = new CaptureArtifactSource(db, tenant, run_id);
      for (const item of subjects) {
        const artifact = await source.read(item.occurrence_id);
        if (artifact) sources.set(item.occurrence_id, await source.collect(artifact));
      }
    } catch (cause) { return fail(String(cause)); }
  }
  const manifest = runPackages(capture.value, { [question.question_id]: { definition: question, text: question.question_text ?? "" } },
    "live_all_revisions", sources, provenance_policy);
  if (!manifest.ok) return fail(manifest.error.detail);
  return ok({ subjects, packages: manifest.value });
}

/** Select one subject's decision out of an already derived run. Pure: no database access. */
export function subjectEvidenceFrom(derived: RunQuestionEvidence, question: QuestionDefinition,
  subject_occurrence_id: ItemOccurrenceId): Result<CapturedEvidence, CapturedEvidenceError> {
  const fail = (detail: string) => err({ operation: "captured_evidence" as const, entity_id: subject_occurrence_id, detail });
  const subject = derived.subjects.find((item) => item.occurrence_id === subject_occurrence_id);
  if (!subject) return fail("subject occurrence is absent from captured run");
  const decision = derived.packages.eligibility.find((item) => item.question_id === question.question_id
    && item.occurrence_id === subject.occurrence_id)?.decision;
  if (!decision) return fail("question does not target captured subject");
  const pack = decision.tag === "eligible" ? derived.packages.packages.find((item) =>
    item.subject.occurrence_id === subject.occurrence_id && item.question_id === question.question_id
    && item.evidence.evidence_set_id === decision.payload.evidence_set_id) : undefined;
  if (decision.tag === "eligible" && !pack) return fail("eligible decision has no captured evidence package");
  return ok({ subject, revision_id: pack?.revision_id ?? subject.revision_id,
    evidence: pack?.evidence ?? null, decision });
}

/** One live capture-to-package path for a specific subject and immutable question pin. */
export async function deriveCapturedEvidence(db: Database, tenant: TenantScope, run_id: string,
  selection: CapturedEvidenceSelection): Promise<Result<CapturedEvidence, CapturedEvidenceError>> {
  const derived = await deriveRunQuestionEvidence(db, tenant, run_id, selection.question, "schema");
  if (!derived.ok) return err({ operation: "captured_evidence", entity_id: selection.subject_occurrence_id,
    detail: derived.error.detail });
  return subjectEvidenceFrom(derived.value, selection.question, selection.subject_occurrence_id);
}

export interface SubjectQuestionSelection {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionDefinition["question_id"];
  readonly question_version: string;
  readonly question?: QuestionDefinition;
  /** A run derivation already built by the caller, so a page of subjects loads the capture and
   * builds its packages once instead of once per subject. */
  readonly derived?: RunQuestionEvidence;
}
export interface DerivedSubjectEvidence {
  readonly question: QuestionDefinition;
  readonly evidence: EvidenceSet | null;
  readonly decision: EligibilityDecision;
}

/** Freeze the first derived decision and package, shared by reads, enqueue and assignment. */
export async function deriveSubjectEvidence(db: Database, tenant: TenantScope, selection: SubjectQuestionSelection)
  : Promise<Result<DerivedSubjectEvidence, CapturedEvidenceError>> {
  const fail = (detail: string) => err({ operation: "captured_evidence" as const,
    entity_id: selection.subject_occurrence_id, detail });
  try {
    const provenance = await checkGradingProvenance(db, tenant, { ...selection,
      pinned_expectation: selection.question?.pinned_expectation });
    if (!provenance.ok) return fail(provenance.error.detail);
    const question = selection.question ?? await withTenant(db, tenant, async (trx) => {
      const row = await trx.selectFrom("observation.question_definition").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("question_id", "=", selection.question_id).where("question_version", "=", selection.question_version)
        .executeTakeFirst();
      return row ? questionFromRow(row) : null;
    });
    if (!question) return fail("question definition does not exist in namespace");
    const registered = await registerQuestion(db, tenant, question);
    if (!registered.ok) return fail(registered.error.detail);
    const loadPinned = (decision: Extract<EligibilityDecision, { tag: "eligible" }>) =>
      withTenant(db, tenant, async (trx) => {
        const stored = await trx.selectFrom("observation.evidence_set").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("evidence_set_id", "=", decision.payload.evidence_set_id).executeTakeFirst();
        if (!stored) return fail("eligible decision has no stored evidence");
        return ok({ question, decision, evidence: { evidence_set_id: stored.evidence_set_id as EvidenceSet["evidence_set_id"],
          references: stored.evidence_refs as unknown as EvidenceSet["references"], is_incomplete: stored.is_incomplete,
          incompleteness_reason: stored.incompleteness_reason } });
      });
    // An eligible decision is the one outcome that must not move: an assignment or execution
    // pins the evidence set it names, and a later capture does not repoint it.
    const pinned = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility")
      .select(["tag", "payload"]).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("subject_occurrence_id", "=", selection.subject_occurrence_id)
      .where("question_id", "=", selection.question_id).where("question_version", "=", selection.question_version)
      .where("tag", "=", "eligible").executeTakeFirst());
    if (pinned) return await loadPinned(pinned as Extract<EligibilityDecision, { tag: "eligible" }>);
    // Everything else is derived on every read. A cached exclusion must never short-circuit
    // derivation, or a subject read before its evidence was captured stays excluded forever.
    const derived = selection.derived
      ? subjectEvidenceFrom(selection.derived, question, selection.subject_occurrence_id)
      : await (async () => {
        const subject = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence")
          .select("run_id").where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("occurrence_id", "=", selection.subject_occurrence_id).executeTakeFirstOrThrow());
        return await deriveCapturedEvidence(db, tenant, subject.run_id, { ...selection, question });
      })();
    if (!derived.ok) return derived;
    const value = derived.value;
    const saved = await persistOakridgeEligibility(db, tenant, { selection_policy: "live_all_revisions",
      packages: value.evidence ? [{ question_id: question.question_id,
        subject: value.subject, revision_id: value.revision_id, evidence: value.evidence }] : [], exclusions: [],
      eligibility: [{ question_id: question.question_id, question_version: question.question_version,
        occurrence_id: selection.subject_occurrence_id, decision: value.decision }] });
    if (!saved.ok) return fail(saved.error.detail);
    // Re-read the pinned row after saving, whatever this request derived. An eligible outcome
    // must agree with concurrent derivations on one evidence set. An exclusion must yield to an
    // eligible row another request wrote while this one was deriving: the guarded upsert keeps
    // that row, so returning the local exclusion would refuse work already admitted.
    const winner = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility")
      .select(["tag", "payload"]).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("subject_occurrence_id", "=", selection.subject_occurrence_id)
      .where("question_id", "=", selection.question_id).where("question_version", "=", selection.question_version)
      .where("tag", "=", "eligible").executeTakeFirst());
    if (winner) return await loadPinned(winner as Extract<EligibilityDecision, { tag: "eligible" }>);
    if (value.decision.tag === "eligible") return fail("eligible decision did not persist");
    return ok({ question, evidence: null, decision: value.decision });
  } catch (cause) { return fail(String(cause)); }
}
