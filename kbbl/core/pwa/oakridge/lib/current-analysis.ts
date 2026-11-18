import type { CurrentAnalysis, CurrentFinding, CanonicalRequirement } from "./current-contract";
export type CurrentRequirementStatus = "blocked" | "warning" | "implementable" | "not_analyzed";
export function requirementStatus(requirement: CurrentAnalysis["requirements"][number]): CurrentRequirementStatus {
  if (requirement.findings.length === 0) return "not_analyzed";
  if (requirement.findings.some((finding) => finding.severity === "blocking")) return "blocked";
  return requirement.findings.some((finding) => finding.severity === "warning") ? "warning" : "implementable";
}
export interface FindingReference { readonly requirement_id: string; readonly finding: CurrentFinding; readonly path: string }
export const selectAnalysisFindings = (analysis: CurrentAnalysis): FindingReference[] => analysis.requirements.flatMap((requirement, i) =>
  requirement.findings.map((finding, j) => ({ requirement_id: requirement.id, finding, path: `/requirements/${i}/findings/${j}` })));
export function selectAnalysisCounts(analysis: CurrentAnalysis) {
  const findings = selectAnalysisFindings(analysis);
  return {
    requirements: (["blocked", "warning", "implementable", "not_analyzed"] as const).map((status) => ({ status, count: analysis.requirements.filter((requirement) => requirementStatus(requirement) === status).length })),
    findings: (["blocking", "warning", "info"] as const).map((severity) => ({ severity, count: findings.filter(({ finding }) => finding.severity === severity).length })),
  };
}
export interface CodeHotspot { readonly path: string; readonly references: readonly FindingReference[] }
export function selectCodeHotspots(analysis: CurrentAnalysis): CodeHotspot[] {
  const groups = new Map<string, FindingReference[]>();
  for (const reference of selectAnalysisFindings(analysis)) {
    const paths = new Set([...reference.finding.expected_change_locations.map((location) => location.path), ...reference.finding.evidence.filter((evidence) => evidence.kind === "file").map((evidence) => evidence.ref)]);
    for (const path of paths) groups.set(path, [...(groups.get(path) ?? []), reference]);
  }
  return [...groups].map(([path, references]) => ({ path, references }));
}
export const selectOperatorDecisions = (analysis: CurrentAnalysis) => selectAnalysisFindings(analysis)
  .filter(({ finding }) => finding.resolution?.kind === "operator_decision")
  .map((reference) => ({ ...reference, question: reference.finding.resolution?.question ?? null,
    alternatives: reference.finding.resolution?.alternatives ?? [], chosen: reference.finding.resolution?.chosen ?? "undecided" }));
export function selectRequirementFindings(requirement: CanonicalRequirement, analysis: CurrentAnalysis | null) {
  const references = analysis ? selectAnalysisFindings(analysis) : [];
  return requirement.analysis_finding_ids.map((id) => ({ id, reference: references.find(({ finding }) => finding.id === id) ?? null }));
}
