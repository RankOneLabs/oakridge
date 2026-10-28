import type { Database, TenantScope } from "../storage/database";
import { recordHumanGrade, type HumanGradeInput } from "../storage/grading-store";
import type { GradeRunner } from "../ports/grade-runner";
import type { GradeDetails } from "../storage/grading-store";

export function humanIntakeRunner(details: GradeDetails): GradeRunner {
  return { kind: "human", run: async () => ({ ok: true, value: { answer: details.answer,
    probabilities: details.probabilities, confidence: details.confidence,
    comments: details.comments, rationale: details.rationale, quality_flags: details.quality_flags } }) };
}

export function acceptHumanGrade(db: Database, tenant: TenantScope, input: HumanGradeInput) {
  return recordHumanGrade(db, tenant, input);
}
