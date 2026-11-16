import { GRADING_NOTE, gradingEditorHref, selectArtifactGrading, selectGradingMatches, selectGradingRequirements, selectWorkflowArtifactTargets, type PublishedGradingContext } from "../../lib/grading-applicability";
import type { ArtifactContract } from "../../artifact-types";
import type { StageSectionProps } from "../../lib/stage-inspector";
interface Props extends StageSectionProps { contract: ArtifactContract; grading?: PublishedGradingContext }
export function ArtifactGrading({ model, contract, grading }: Props) {
  const matches = selectArtifactGrading(selectGradingMatches(grading?.definitions ?? [], selectWorkflowArtifactTargets(model.definition)), { definition_id: model.definition.definition_id, stage: model.name, artifact: contract.name });
  return <section aria-label="Independent grading" className="[overflow-wrap:anywhere]"><h5>Independent grading</h5><p>{GRADING_NOTE}</p>
    {grading?.isLoading ? <p>Loading grading configuration…</p> : grading?.error ? <p>Grading configuration unavailable: {grading.error}</p> : matches.length === 0 ? <p>No published grading definition targets this artifact.</p> : matches.map(match => {
      const requirements = selectGradingRequirements(match.source);
      return <article key={match.source.id}><a href={gradingEditorHref(match.source.id)} aria-label={`Open ${match.source.id} in grading editor`}>{match.source.id}</a><dl>
        <dt>Selectors</dt><dd>{match.selectors.join(", ")}</dd><dt>Question</dt><dd>{requirements.question_text}</dd><dt>Response</dt><dd>{requirements.response}</dd><dt>Scope</dt><dd>{requirements.scope}</dd>
        <dt>Evaluators</dt><dd>{requirements.evaluators.map(entry => entry.model === null ? entry.runner : `${entry.runner} · ${entry.model}`).join(", ")}</dd>
        <dt>Evidence</dt><dd>{requirements.evidence.map((entry, index) => <p key={index}>{entry.capability}{entry.params !== null && ` ${JSON.stringify(entry.params)}`}</p>)}</dd></dl></article>;
    })}</section>;
}
