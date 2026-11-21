// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorAssessmentBody {
  readonly head_sha: string; readonly item_assessments: readonly OperatorItemAssessment[];
  readonly additional_findings: readonly OperatorAdditionalFinding[]; readonly next_actions: readonly OperatorAssessmentAction[];
  readonly test_evidence: OperatorAssessmentTestEvidence; readonly verdict: "pass" | "pass_with_notes" | "fail";
}

export interface OperatorItemAssessment {
  readonly subject: OperatorAssessmentSubject; readonly status: "met" | "partial" | "not_met";
  readonly observation: string; readonly evidence: readonly OperatorAssessmentEvidence[];
}

export interface OperatorAdditionalFinding {
  readonly id: string; readonly severity: "blocking" | "warning" | "info"; readonly observation: string;
  readonly related_build_item_ids: readonly string[]; readonly evidence: readonly OperatorAssessmentEvidence[];
}

export interface OperatorAssessmentAction { readonly id: string; readonly audience: "rework" | "operator"; readonly source: OperatorActionSource; readonly text: string }

export interface OperatorAssessmentTestEvidence {
  readonly passed: number; readonly failed: number; readonly output?: string | null;
  readonly summary?: string | null; readonly cargo_test_output?: string | null;
}

export interface OperatorAssessmentSubject { readonly kind: string; readonly id: string }

export interface OperatorAssessmentEvidence { readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail?: string | null }

export interface OperatorActionSource { readonly kind: "item_assessment" | "additional_finding"; readonly id: string }
