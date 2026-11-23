import { objectValue } from "../adapters/core";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { OperatorInputProvenanceView } from "../operator-contracts/domain/unit-status";
import { parseCanonicalSpec, parseCurrentAnalysis, readAssignment, type CanonicalRequirement, type CanonicalSpec, type CurrentAnalysis } from "./viewer-data";
export interface CurrentArtifactContext { readonly spec: CanonicalSpec | null; readonly requirements: readonly CanonicalRequirement[]; readonly analysis: CurrentAnalysis | null; readonly analysis_revision_id?: string | null }
/** Source inputs and the approved analysis on this unit, never an unapproved sibling revision. */
export function selectCurrentArtifactContext(unit: OperatorUnitView, attemptId: string | null = null): CurrentArtifactContext {
  const intent = unit.attempts.find((attempt) => attempt.id === attemptId)?.intent;
  const input = objectValue(intent?.inputs ?? unit.input);
  const spec = parseCanonicalSpec(input?.spec);
  const assignment = readAssignment(input?.assignment);
  const analysisArtifact = unit.artifacts.find((artifact) => artifact.artifact_key === "analysis");
  const latest = analysisArtifact?.latest_revision;
  const decision = latest ? unit.recorded_decisions.filter((entry) => entry.target_revision_id === latest.id).at(-1) : null;
  const approvedLatest = decision?.effect === "approve" ? latest ?? null : null;
  const analysis = parseCurrentAnalysis(input?.approved_analysis ?? approvedLatest?.body ?? null);
  return { spec: spec.ok ? spec.value : null, requirements: spec.ok ? spec.value.requirements : assignment?.requirements ?? [], analysis: analysis.ok ? analysis.value : null,
    analysis_revision_id: selectConsumedAnalysisRevisionId({ provenance: intent?.input_provenance ?? null, consumed: input?.approved_analysis, approvedLatest }) };
}

interface ConsumedAnalysisSource {
  readonly provenance: OperatorInputProvenanceView | null;
  /** The analysis body the attempt received, when it saved one. */
  readonly consumed: unknown;
  readonly approvedLatest: { readonly id: string; readonly body: unknown } | null;
}
/** The analysis revision a spec was written from. A saved analysis that differs from
 * the latest approved one has no projected revision here: null, never a newer revision. */
export function selectConsumedAnalysisRevisionId({ provenance, consumed, approvedLatest }: ConsumedAnalysisSource): string | null {
  const recorded = provenance?.status === "recorded" ? provenance.entries.find((entry) => entry.input === "approved_analysis")?.revision_id : undefined;
  if (recorded) return recorded;
  if (consumed === undefined) return approvedLatest?.id ?? null;
  return approvedLatest !== null && isSameJson(approvedLatest.body, consumed) ? approvedLatest.id : null;
}

function isSameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => isSameJson(item, right[index]));
  const leftEntries = Object.entries(left);
  const rightRecord = new Map(Object.entries(right));
  return leftEntries.length === rightRecord.size && leftEntries.every(([key, value]) => rightRecord.has(key) && isSameJson(value, rightRecord.get(key)));
}
