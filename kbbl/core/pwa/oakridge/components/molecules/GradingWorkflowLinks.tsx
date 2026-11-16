import { selectGradingMatches, type GradingTargetSource, type WorkflowArtifactTarget } from "../../lib/grading-applicability";
import { definitionStageHref } from "../../lib/definition-selection";
import { stageElementId } from "../../lib/stage-inspector";
interface Props { source: GradingTargetSource; artifacts: readonly WorkflowArtifactTarget[] }
export function GradingWorkflowLinks({ source, artifacts }: Props) {
  const matches = selectGradingMatches([source], artifacts);
  return <section aria-label="Applies to workflow artifacts" className="[overflow-wrap:anywhere]"><h3>Applies to workflow artifacts</h3>{matches.length === 0 ? <p>No workflow artifact matches this definition's targets.</p> : <ul>{matches.map(({ artifact, selectors }) => <li key={`${artifact.definition_id}/${artifact.stage}/${artifact.artifact}`}>{artifact.workflow} › <a href={definitionStageHref(artifact.definition_id, artifact.stage)}>{artifact.stage}</a> › <a href={`${definitionStageHref(artifact.definition_id, artifact.stage)}#${stageElementId({ stage: artifact.stage, kind: "artifact", name: artifact.artifact })}`}>{artifact.artifact}</a> · {selectors.join(", ")}</li>)}</ul>}</section>;
}
