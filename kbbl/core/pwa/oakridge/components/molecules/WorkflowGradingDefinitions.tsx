import { GRADING_NOTE, gradingEditorHref, selectGradingMatches, selectWorkflowArtifactTargets, type PublishedGradingContext } from "../../lib/grading-applicability";
import type { OperatorDefinitionSummary } from "../../operator-contracts/projections/definition-view";
interface Props { definition: OperatorDefinitionSummary; grading: PublishedGradingContext }
export function WorkflowGradingDefinitions({ definition, grading }: Props) {
  const matches = selectGradingMatches(grading.definitions, selectWorkflowArtifactTargets(definition));
  return <section aria-label="Independent grading definitions"><h2>Independent grading definitions</h2><p>{GRADING_NOTE}</p>
    {grading.isLoading ? <p>Loading grading configuration…</p> : grading.error ? <p>Grading configuration unavailable: {grading.error}</p> : matches.length === 0 ? <p>No published grading definition targets this workflow's artifacts.</p> : grading.definitions.filter(source => matches.some(match => match.source === source)).map(source => <article key={source.id} className="[overflow-wrap:anywhere]"><a aria-label={`Open ${source.id} in grading editor`} href={gradingEditorHref(source.id)}>{source.id}</a><ul>{matches.filter(match => match.source === source).map(match => <li key={`${match.artifact.stage}/${match.artifact.artifact}`}>{match.artifact.stage} › {match.artifact.artifact} · {match.selectors.join(", ")}</li>)}</ul></article>)}
  </section>;
}
