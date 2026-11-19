import { parseCurrentAssessment, type CurrentAssessment } from "./current-assessment";
import type { Result } from "../../lib/result";
import { selectArtifactComponent } from "./artifact-version";
import { parseCanonicalSpec, parseCurrentAnalysis, parseCurrentBrief, parseCurrentPlan, type CanonicalSpec, type CurrentAnalysis, type CurrentBrief, type CurrentPlan, type CurrentParseError } from "./current-contract";
export type CurrentArtifactBody =
  | { readonly kind: "analysis"; readonly body: CurrentAnalysis }
  | { readonly kind: "spec"; readonly body: CanonicalSpec }
  | { readonly kind: "plan"; readonly body: CurrentPlan }
  | { readonly kind: "brief"; readonly body: CurrentBrief }
  | { readonly kind: "assessment"; readonly body: CurrentAssessment };
export type CurrentArtifactRead = Result<CurrentArtifactBody | null, CurrentParseError>;
/** The adapter validates current bodies before presentation. Unknown/legacy bodies stay untouched. */
export function parseVersionedBody(input: { readonly schema: string; readonly version: string | null; readonly is_adjudicated?: boolean; readonly body: unknown }): CurrentArtifactRead {
  switch (selectArtifactComponent(input)) {
    case "dev-current-analysis-viewer": {
      const result = parseCurrentAnalysis(input.body);
      return result.ok ? { ok: true, value: { kind: "analysis", body: result.value } } : result;
    }
    case "dev-current-spec-viewer": {
      const result = parseCanonicalSpec(input.body);
      return result.ok ? { ok: true, value: { kind: "spec", body: result.value } } : result;
    }
    case "dev-current-plan-viewer": {
      const result = parseCurrentPlan(input.body);
      return result.ok ? { ok: true, value: { kind: "plan", body: result.value } } : result;
    }
    case "dev-current-brief-viewer": {
      const result = parseCurrentBrief(input.body);
      return result.ok ? { ok: true, value: { kind: "brief", body: result.value } } : result;
    }
    case "dev-current-assessment-viewer": {
      const result = parseCurrentAssessment(input.body);
      return result.ok ? { ok: true, value: { kind: "assessment", body: result.value } } : result;
    }
    default: return { ok: true, value: null };
  }
}
