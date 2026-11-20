import { Chip } from "../../../components/atoms/Chip";
import type { AssessmentAdjudication } from "../../hooks/useAssessmentAdjudication";
import { selectActionSourceLabel, selectAdjudicationSources, selectBuilderPreview, selectPendingDisposition } from "../../lib/assessment-adjudication";
import { selectAssessmentActions, type CurrentAssessment } from "../../lib/current-assessment";
import { AdjudicationAction } from "../molecules/AdjudicationAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { AddAdjudicationAction } from "./AddAdjudicationAction";

interface Props { assessment: CurrentAssessment; adjudication: AssessmentAdjudication }

const AUDIENCE_TITLE = { builder: "Builder", operator: "Operator" } as const;

/** The assessor's actions with the operator's Keep / Edit / Drop, recorded dispositions inline once decided. */
export function AssessmentActionsPanel({ assessment, adjudication }: Props) {
  const lists = selectAssessmentActions(assessment);
  const recorded = adjudication.recordedDecision?.adjudication ?? null;
  const added = recorded?.added_actions ?? adjudication.state.added_actions;
  const disabled = !adjudication.isOpen || adjudication.isPending;
  const preview = selectBuilderPreview(adjudication.state);
  return <ArtifactSection title="Next actions" testId="or-assessment-handoff">
    {(["builder", "operator"] as const).map(audience => <section key={audience} aria-label={`${audience} actions`} className="flex flex-col gap-2">
      <h3>{AUDIENCE_TITLE[audience]} ({lists[audience].length + added.filter(entry => entry.audience === audience).length})</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {lists[audience].map(action => <AdjudicationAction key={action.id} action={action} disabled={disabled}
          recorded={recorded?.entries.find(entry => entry.action_id === action.id) ?? null}
          pending={selectPendingDisposition(adjudication.state, action.id)}
          onChange={choice => adjudication.choose(action.id, choice)} />)}
        {added.filter(entry => entry.audience === audience).map(entry => <li key={entry.action_id} className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
          <p>{entry.final_text}</p>
          <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-muted)]">{selectActionSourceLabel(entry.source)}</span><Chip tone="info">Added by operator</Chip></div>
        </li>)}
        {lists[audience].length === 0 && added.every(entry => entry.audience !== audience) && <li className="text-sm text-[var(--text-muted)]">None.</li>}
      </ul>
    </section>)}
    {!adjudication.isRecorded && <AddAdjudicationAction sources={selectAdjudicationSources(assessment)} disabled={disabled} onAdd={adjudication.add} />}
    {!adjudication.isRecorded && <details>
      <summary className="cursor-pointer text-sm">What the builder will receive</summary>
      <pre className="whitespace-pre-wrap rounded-md border border-[var(--border-decorative)] p-3" data-testid="or-assessment-handoff-preview">{preview || "Nothing: no builder action is kept."}</pre>
    </details>}
  </ArtifactSection>;
}
