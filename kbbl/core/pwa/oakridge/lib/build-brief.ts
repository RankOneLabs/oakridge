export interface BriefDecision {
  decision: string;
  rationale: string;
}

export interface RejectedApproach {
  approach: string;
  reason: string;
}

/** Mirrors the registered oakridge-core `dev.build_brief` artifact body. */
export interface BuildBrief {
  cohort_id: string;
  repository_key: string;
  title: string;
  depends_on: string[];
  goal: string;
  files_in_scope: string[];
  decisions_made: BriefDecision[];
  approaches_rejected: RejectedApproach[];
  acceptance_criteria: string[];
  next_action: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isBuildBrief(value: unknown): value is BuildBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const brief = value as Partial<BuildBrief>;
  return typeof brief.cohort_id === "string"
    && typeof brief.repository_key === "string"
    && typeof brief.title === "string"
    && isStringArray(brief.depends_on)
    && typeof brief.goal === "string"
    && isStringArray(brief.files_in_scope)
    && Array.isArray(brief.decisions_made)
    && brief.decisions_made.every((entry) => entry
      && typeof entry === "object"
      && typeof (entry as Partial<BriefDecision>).decision === "string"
      && typeof (entry as Partial<BriefDecision>).rationale === "string")
    && Array.isArray(brief.approaches_rejected)
    && brief.approaches_rejected.every((entry) => entry
      && typeof entry === "object"
      && typeof (entry as Partial<RejectedApproach>).approach === "string"
      && typeof (entry as Partial<RejectedApproach>).reason === "string")
    && isStringArray(brief.acceptance_criteria)
    && typeof brief.next_action === "string";
}
