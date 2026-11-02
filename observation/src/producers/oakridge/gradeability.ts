import type { ItemOccurrenceId, QuestionId } from "../../domain/identity";
import { err, ok, type Result } from "../../domain/primitives";
import type { EligibilityDecision, EligibilityRow } from "../../grading/eligibility";
import type { EvidenceSet } from "../../grading/evidence";
import type { RevisionSelection } from "../../grading/evidence-packages/capture";
import { withTenant, type Database, type TenantScope } from "../../storage/database";
import { loadRunCapture } from "../../storage/run-capture-store";
import { runPackages, type RunPackages } from "./evidence-packages";
import { LANGFUSE_PILOT_QUESTIONS, LANGFUSE_PILOT_QUESTIONS_V1 } from "../../grading/catalogue/langfuse-pilot";

export function isPilotQuestionPin(question_id: string, question_version: string): boolean {
  const current = LANGFUSE_PILOT_QUESTIONS[question_id as keyof typeof LANGFUSE_PILOT_QUESTIONS];
  const historical = LANGFUSE_PILOT_QUESTIONS_V1[question_id as keyof typeof LANGFUSE_PILOT_QUESTIONS_V1];
  return current?.definition.question_version === question_version || historical?.definition.question_version === question_version;
}

export interface GradeabilityInput {
  readonly run_id: string;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly selection_policy: RevisionSelection["policy"];
}
export interface GradeabilityResult {
  /** Null means this question has no Oakridge capture recipe; registered generic grading remains available. */
  readonly decision: EligibilityDecision | null;
  readonly evidence: EvidenceSet | null;
}
export interface GradeabilityError { readonly operation: "gradeability"; readonly entity_id: string; readonly detail: string;
  readonly code?: "unknown_question_pin" }

async function packagesForRun(db: Database, tenant: TenantScope, run_id: string,
  policy: RevisionSelection["policy"]): Promise<Result<RunPackages, GradeabilityError>> {
  const captured = await loadRunCapture(db, tenant, run_id);
  if (!captured.ok) return err({ operation: "gradeability", entity_id: run_id, detail: captured.error.detail });
  const built = runPackages(captured.value, policy);
  return built.ok ? ok(built.value) : err({ operation: "gradeability", entity_id: run_id,
    detail: built.error.detail });
}

/** The same captured reader and packaging transform serve every production caller. */
export async function deriveGradeability(db: Database, tenant: TenantScope, input: GradeabilityInput)
  : Promise<Result<GradeabilityResult, GradeabilityError>> {
  if (!isPilotQuestionPin(input.question_id, input.question_version))
    return ok({ decision: null, evidence: null });
  const built = await packagesForRun(db, tenant, input.run_id, input.selection_policy);
  if (!built.ok) return built;
  const row = built.value.eligibility.find((candidate) => candidate.question_id === input.question_id
    && candidate.occurrence_id === input.subject_occurrence_id);
  if (!row) return err({ operation: "gradeability", entity_id: input.subject_occurrence_id,
    detail: "subject and question are not captured in the run" });
  const evidence_set_id = row.decision.tag === "eligible" ? row.decision.payload.evidence_set_id : null;
  const evidence = evidence_set_id ? built.value.packages.find((candidate) =>
    candidate.question_id === input.question_id && candidate.subject.occurrence_id === input.subject_occurrence_id
    && candidate.evidence.evidence_set_id === evidence_set_id)?.evidence ?? null : null;
  return ok({ decision: row.decision, evidence });
}

export async function deriveSubjectGradeability(db: Database, tenant: TenantScope,
  subject_occurrence_id: ItemOccurrenceId, question_id: QuestionId, question_version: string,
  selection_policy: RevisionSelection["policy"] = "live_all_revisions")
  : Promise<Result<GradeabilityResult, GradeabilityError>> {
  const subject = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence")
    .select("run_id").where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("occurrence_id", "=", subject_occurrence_id).executeTakeFirst());
  if (!subject) return err({ operation: "gradeability", entity_id: subject_occurrence_id,
    detail: "subject occurrence is not captured" });
  return deriveGradeability(db, tenant, { run_id: subject.run_id, subject_occurrence_id,
    question_id, question_version, selection_policy });
}

export async function readDerivedEligibility(db: Database, tenant: TenantScope,
  question_id: string, question_version: string,
  policy: RevisionSelection["policy"] = "live_all_revisions", run_id?: string)
  : Promise<Result<readonly EligibilityRow[], GradeabilityError>> {
  if (!isPilotQuestionPin(question_id, question_version))
    return err({ operation: "gradeability", entity_id: question_id, detail: "unknown pilot question pin",
      code: "unknown_question_pin" });
  const run_ids = run_id ? [run_id] : await withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.source_revision").distinct().select("run_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).execute();
    return rows.map((row) => row.run_id);
  });
  const rows: EligibilityRow[] = [];
  for (const id of run_ids) {
    const built = await packagesForRun(db, tenant, id, policy);
    if (!built.ok) return built;
    rows.push(...built.value.eligibility.filter((item) => item.question_id === question_id).map((item) => ({
      producer: tenant.producer, namespace: tenant.namespace,
      subject_occurrence_id: item.occurrence_id, question_id: item.question_id as QuestionId,
      question_version, ...item.decision,
    })));
  }
  return ok(rows.sort((a, b) => a.subject_occurrence_id.localeCompare(b.subject_occurrence_id)));
}
