import { objectValue } from "../adapters/core";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { parseCanonicalSpec, parseCurrentAnalysis, assignmentSchema, parseCurrent, type CanonicalRequirement, type CanonicalSpec, type CurrentAnalysis } from "./current-contract";
export interface CurrentArtifactContext { readonly spec: CanonicalSpec | null; readonly requirements: readonly CanonicalRequirement[]; readonly analysis: CurrentAnalysis | null; readonly analysis_revision_id?: string | null }
/** Source inputs and the approved analysis on this unit, never an unapproved sibling revision. */
export function selectCurrentArtifactContext(unit: OperatorUnitView, attemptId: string | null = null): CurrentArtifactContext {
  const intent = unit.attempts.find((attempt) => attempt.id === attemptId)?.intent;
  const input = objectValue(intent?.inputs ?? unit.input);
  const spec = parseCanonicalSpec(input?.spec);
  const assignment = parseCurrent(assignmentSchema, input?.assignment, "parse_assignment");
  const analysisArtifact = unit.artifacts.find((artifact) => artifact.artifact_key === "analysis");
  const latest = analysisArtifact?.latest_revision;
  const decision = latest ? unit.recorded_decisions.filter((entry) => entry.target_revision_id === latest.id).at(-1) : null;
  const analysis = parseCurrentAnalysis(input?.approved_analysis ?? (decision?.effect === "approve" ? latest?.body : null));
  return { spec: spec.ok ? spec.value : null, requirements: spec.ok ? spec.value.requirements : assignment.ok ? assignment.value.requirements : [], analysis: analysis.ok ? analysis.value : null,
    analysis_revision_id: intent?.input_provenance?.status === "recorded"
      ? intent.input_provenance.entries.find((entry) => entry.input === "approved_analysis")?.revision_id ?? latest?.id ?? null
      : latest?.id ?? null };
}
