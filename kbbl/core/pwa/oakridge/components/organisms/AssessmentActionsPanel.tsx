import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { AssessmentAdjudication } from "../../hooks/useAssessmentAdjudication";
import { selectActionDraft, selectActionSourceLabel, selectAdjudicationSources, selectAudienceRows, selectBuilderPreview, selectPendingDisposition } from "../../lib/assessment-adjudication";
import type { CurrentAssessment } from "../../lib/current-assessment";
import { AdjudicationAction } from "../molecules/AdjudicationAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { AddAdjudicationAction } from "./AddAdjudicationAction";

interface Props { assessment: CurrentAssessment; adjudication: AssessmentAdjudication }

const AUDIENCE_TITLE = { builder: "Builder", operator: "Operator" } as const;

/** The assessor's actions with the operator's Keep / Edit / Drop, recorded dispositions inline once decided. */
export function AssessmentActionsPanel({ assessment, adjudication }: Props) {
  const recorded = adjudication.recordedDecision?.adjudication ?? null;
  const rowsInput = { assessment, added_actions: recorded?.added_actions ?? adjudication.state.added_actions, recorded };
  const disabled = !adjudication.isOpen || adjudication.isPending;
  const preview = selectBuilderPreview(adjudication.state);
  return <ArtifactSection title="Next actions" testId="or-assessment-handoff">
    {(["builder", "operator"] as const).map(audience => ({ audience, rows: selectAudienceRows(rowsInput, audience) })).map(({ audience, rows }) =>
      <section key={audience} aria-label={`${audience} actions`} className="flex flex-col gap-2">
        <h3>{AUDIENCE_TITLE[audience]} ({rows.count})</h3>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.proposed.map(({ action, recorded: entry }) => <AdjudicationAction key={action.id} action={action} disabled={disabled} recorded={entry}
            pending={selectPendingDisposition(adjudication.state, action.id)} draft={selectActionDraft(adjudication.state, action)}
            onChange={choice => adjudication.choose(action.id, choice)} />)}
          {rows.added.map(entry => <li key={entry.action_id} className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
            <p>{entry.final_text}</p>
            <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-muted)]">{selectActionSourceLabel(entry.source)}</span><Chip tone="info">Added by operator</Chip>
              {!adjudication.isRecorded && <Button size="xsmall" variant="secondary" className="ml-auto" disabled={disabled} onClick={() => adjudication.remove(entry.action_id)}>Remove</Button>}</div>
          </li>)}
          {rows.count === 0 && <li className="text-sm text-[var(--text-muted)]">None.</li>}
        </ul>
      </section>)}
    {!adjudication.isRecorded && <AddAdjudicationAction sources={selectAdjudicationSources(assessment)} disabled={disabled} onAdd={adjudication.add} />}
    {!adjudication.isRecorded && <details>
      <summary className="cursor-pointer text-sm">What the builder will receive</summary>
      <pre className="whitespace-pre-wrap rounded-md border border-[var(--border-decorative)] p-3" data-testid="or-assessment-handoff-preview">{preview || "Nothing: no builder action is kept."}</pre>
    </details>}
  </ArtifactSection>;
}
