import { selectGradingMatches, type GradingTargetSource, type GradingWorkflowTargets } from "../../lib/grading-applicability";
import { definitionStageHref } from "../../lib/definition-selection";
import { stageElementId } from "../../lib/stage-inspector";
interface Props { source: GradingTargetSource; targets: GradingWorkflowTargets }
export function GradingWorkflowLinks({ source, targets }: Props) {
  const matches = selectGradingMatches([source], targets.status === "ready" ? targets.artifacts : []);
  return <section aria-label="Applies to workflow artifacts" className="[overflow-wrap:anywhere]"><h3>Applies to workflow artifacts</h3>{targets.status === "loading" ? <p>Loading workflow artifacts…</p> : targets.status === "unavailable" ? <p>Workflow artifacts unavailable: {targets.detail}</p> : matches.length === 0 ? <p>No workflow artifact matches this definition's targets.</p> : <ul>{matches.map(({ artifact, selectors }) => <li key={`${artifact.definition_id}/${artifact.stage}/${artifact.artifact}`}>{artifact.workflow} › <a href={definitionStageHref(artifact.definition_id, artifact.stage)}>{artifact.stage}</a> › <a href={`${definitionStageHref(artifact.definition_id, artifact.stage)}#${stageElementId({ stage: artifact.stage, kind: "artifact", name: artifact.artifact })}`}>{artifact.artifact}</a> · {selectors.join(", ")}</li>)}</ul>}</section>;
}
