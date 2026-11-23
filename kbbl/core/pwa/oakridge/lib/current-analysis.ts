import type { CurrentAnalysis, CurrentFinding, CanonicalRequirement } from "./viewer-data";
import type { SubnavSection } from "./artifact-subnav";
export type CurrentRequirementStatus = "blocked" | "warning" | "implementable" | "not_analyzed";
/** Most urgent first: the order requirements are listed and counted in. */
export const REQUIREMENT_STATUS_ORDER: readonly CurrentRequirementStatus[] = ["blocked", "warning", "implementable", "not_analyzed"];
export function requirementStatus(requirement: CurrentAnalysis["requirements"][number]): CurrentRequirementStatus {
  if (requirement.findings.length === 0) return "not_analyzed";
  if (requirement.findings.some((finding) => finding.finding_impact === "blocking")) return "blocked";
  return requirement.findings.some((finding) => finding.finding_impact === "warning") ? "warning" : "implementable";
}
export interface FindingReference { readonly requirement_id: string; readonly finding: CurrentFinding; readonly path: string }
export const selectAnalysisFindings = (analysis: CurrentAnalysis): FindingReference[] => analysis.requirements.flatMap((requirement, i) =>
  requirement.findings.map((finding, j) => ({ requirement_id: requirement.id, finding, path: `/requirements/${i}/findings/${j}` })));
export function selectAnalysisCounts(analysis: CurrentAnalysis) {
  const findings = selectAnalysisFindings(analysis);
  return {
    requirements: REQUIREMENT_STATUS_ORDER.map((status) => ({ status, count: analysis.requirements.filter((requirement) => requirementStatus(requirement) === status).length })),
    findings: (["blocking", "warning", "info"] as const).map((severity) => ({ severity, count: findings.filter(({ finding }) => finding.finding_impact === severity).length })),
  };
}
export interface OrderedRequirement { readonly requirement: CurrentAnalysis["requirements"][number]; readonly index: number; readonly status: CurrentRequirementStatus }
/** Requirements most urgent first, authored order within a status; `index` stays the requirement's position in the analysis. */
export const selectRequirementsByStatus = (analysis: CurrentAnalysis): readonly OrderedRequirement[] => analysis.requirements
  .map((requirement, index) => ({ requirement, index, status: requirementStatus(requirement) }))
  .sort((left, right) => REQUIREMENT_STATUS_ORDER.indexOf(left.status) - REQUIREMENT_STATUS_ORDER.indexOf(right.status) || left.index - right.index);
export interface CodeHotspot { readonly path: string; readonly references: readonly FindingReference[] }
export function selectFindingCitations(finding: CurrentFinding) {
  return (finding.supporting_citations).flatMap((citation) => {
    const location = citation.citation_location;
    return location ? [{ kind: citation.kind, location, detail: citation.detail }] : [];
  });
}
export function selectCodeHotspots(analysis: CurrentAnalysis): CodeHotspot[] {
  const groups = new Map<string, FindingReference[]>();
  for (const reference of selectAnalysisFindings(analysis)) {
    const paths = new Set([...reference.finding.expected_change_locations.map((location) => location.path),
      ...selectFindingCitations(reference.finding).filter((citation) => citation.kind === "file").map((citation) => citation.location)]);
    for (const path of paths) groups.set(path, [...(groups.get(path) ?? []), reference]);
  }
  return [...groups].map(([path, references]) => ({ path, references }));
}
export const selectFindingResolution = (finding: CurrentFinding) => finding.finding_resolution;
export const selectDecisionPrompt = (resolution: ReturnType<typeof selectFindingResolution>) =>
  resolution?.decision_prompt ?? null;

export const selectOperatorDecisions = (analysis: CurrentAnalysis) => selectAnalysisFindings(analysis)
  .flatMap((reference) => {
    const resolution = selectFindingResolution(reference.finding);
    return resolution?.kind === "operator_decision"
      ? [{ ...reference, prompt: selectDecisionPrompt(resolution), alternatives: resolution.alternatives ?? [], chosen: resolution.chosen ?? "undecided" }]
      : [];
  });
export function selectRequirementFindings(requirement: CanonicalRequirement, analysis: CurrentAnalysis | null) {
  const references = analysis ? selectAnalysisFindings(analysis) : [];
  return requirement.analysis_finding_ids.map((id) => ({ id, reference: references.find(({ finding }) => finding.id === id) ?? null }));
}
export type AnalysisSection = "requirements" | "hotspots" | "decisions" | "original_input";
/** The analysis viewer's subnav, requirements first. */
export const selectAnalysisSections = (analysis: CurrentAnalysis): readonly SubnavSection<AnalysisSection>[] => [
  { value: "requirements", label: "Requirements", count: analysis.requirements.length },
  { value: "hotspots", label: "Code hotspots", count: selectCodeHotspots(analysis).length },
  { value: "decisions", label: "Operator decisions", count: selectOperatorDecisions(analysis).length },
  { value: "original_input", label: "Original input", count: null },
];
