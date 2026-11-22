import { ROOT_DECLARATION } from "../operator-contracts/constants";
import type { OperatorDefinitionSummary } from "../operator-contracts/projections/definition-view";
import type { ObservationGradingDefinition } from "../grading-contracts/grading/configuration";
import type { ObservationJsonValue as Json } from "../grading-contracts/domain/primitives";
export interface WorkflowArtifactTarget { definition_id: string; workflow: string; stage: string; artifact: string }
export interface GradingTargetSource { readonly id: string; readonly targets: readonly { artifact: string; selector: string }[] }
export interface GradingMatch<T extends GradingTargetSource = GradingTargetSource> { source: T; artifact: WorkflowArtifactTarget; selectors: string[] }
export interface GradingRequirements { question_text: string | null; response: string; scope: string; evaluators: { runner: string; model: string | null }[]; evidence: { capability: string; params: Json | null }[] }
export function selectWorkflowArtifactTargets(summary: OperatorDefinitionSummary): WorkflowArtifactTarget[] {
  const targets = summary.bundle.units.filter(unit => unit.key !== ROOT_DECLARATION && unit.stage !== null).flatMap(unit => unit.artifacts.map(artifact => ({ definition_id: summary.definition_id, workflow: summary.bundle.key, stage: unit.stage as string, artifact: artifact.key })));
  return targets.filter((target, index) => targets.findIndex(other => other.stage === target.stage && other.artifact === target.artifact) === index);
}
export function selectGradingMatches<T extends GradingTargetSource>(sources: readonly T[], artifacts: readonly WorkflowArtifactTarget[]): GradingMatch<T>[] {
  return sources.flatMap(source => artifacts.flatMap(artifact => {
    const selectors = [...new Set(source.targets.filter(target => target.artifact === artifact.artifact).map(target => target.selector))];
    return selectors.length ? [{ source, artifact, selectors }] : [];
  }));
}
export function selectGradingRequirements(definition: ObservationGradingDefinition): GradingRequirements {
  return { question_text: definition.question.text, response: definition.question.response, scope: definition.scope,
    evaluators: definition.evaluators.map(entry => ({ runner: entry.runner, model: "model" in entry ? entry.model : null })),
    evidence: definition.evidence.map(entry => typeof entry === "string" ? { capability: entry, params: null } : { capability: entry.capability, params: entry.params ?? null }) };
}
export const selectArtifactGrading = <T extends GradingTargetSource>(matches: readonly GradingMatch<T>[], target: Pick<WorkflowArtifactTarget, "definition_id" | "stage" | "artifact">): GradingMatch<T>[] => matches.filter(match => match.artifact.definition_id === target.definition_id && match.artifact.stage === target.stage && match.artifact.artifact === target.artifact);
export const gradingEditorHref = (id: string): string => `#settings/workflows/grading-config/definitions/${encodeURIComponent(id)}`;
export const GRADING_NOTE = "Separate from this workflow's reviews. Grading runs only for runs launched with grading enabled.";
export interface PublishedGradingContext { definitions: readonly ObservationGradingDefinition[]; isLoading: boolean; error: string | null }

export type GradingWorkflowTargets =
  | { status: "loading" }
  | { status: "unavailable"; detail: string }
  | { status: "ready"; artifacts: readonly WorkflowArtifactTarget[] };
export interface WorkflowGradingGroup<T extends GradingTargetSource> { source: T; matches: readonly GradingMatch<T>[] }
export function selectWorkflowGradingGroups<T extends GradingTargetSource>(matches: readonly GradingMatch<T>[]): WorkflowGradingGroup<T>[] {
  const sources = [...new Set(matches.map(match => match.source))];
  return sources.map(source => ({ source, matches: matches.filter(match => match.source === source) }));
}
