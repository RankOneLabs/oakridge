import { TextArea } from "../../../components/atoms/TextArea";
import { Select } from "../../../components/atoms/Select";
import { Checkbox } from "../../../components/atoms/Checkbox";
import { HandoffProvenance } from "./HandoffProvenance";
import { selectHandoffUnitId } from "../../lib/handoff-provenance";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { ViewerProps } from "../../artifactRegistry";
import type { Assessment } from "../../lib/assessment";
import { composeHandoffText, hasHandoffItem, NO_REVIEW_REASON, selectHandoffItems, selectHandoffRound, withItemAdded, withItemRemoved, withItemTextChanged, type HandoffItem } from "../../lib/assessment-handoff";
import { useRunSentFeedback } from "../../hooks/useRunSentFeedback";
import type { EditOutcome } from "../../lib/edit-outcome";
import type { ParkedGate } from "../../artifact-types";
import { AddNextAction } from "./AddNextAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { EditableBriefText } from "./EditableBriefText";
import { SendToBuilder } from "./SendToBuilder";

interface Props {
  runId: string;
  unitLabel: string;
  revisionId: string;
  assessment: Assessment;
  /** The unnormalised revision body preserves fields outside the parser's view. */
  body: Assessment;
  /** The open assessment review; null when the revision on screen has none. */
  gate: ParkedGate | null;
  edit: NonNullable<ViewerProps["edit"]>;
}

export function BuilderHandoffPanel({ runId, unitLabel, revisionId, assessment, body, gate, edit }: Props) {
  const client = useQueryClient();
  const sentFeedback = useRunSentFeedback(runId);
  const [items, setItems] = useState<HandoffItem[]>(() => selectHandoffItems(assessment));
  const [removeErrors, setRemoveErrors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setItems((previous) => selectHandoffItems(assessment).map((item) => ({
      ...item, is_included: previous.find((candidate) => candidate.id === item.id)?.is_included ?? true,
    })));
  }, [assessment]);
  const target = selectHandoffRound(revisionId, unitLabel, gate, sentFeedback.data ?? []);
  const preview = composeHandoffText(items);

  async function submit(next: unknown): Promise<EditOutcome> {
    if (!edit.onSubmitBody) return Promise.resolve({ ok: false, error: "This assessment cannot be edited." });
    const outcome = await edit.onSubmitBody(body, next);
    if (outcome.ok) {
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "gates"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "artifact"] });
    }
    return outcome;
  }

  async function remove(id: string): Promise<void> {
    if (!hasHandoffItem(body, id)) {
      setRemoveErrors((previous) => new Map(previous).set(id, "Action is absent from the current assessment. Refresh and review it again."));
      return;
    }
    const removal = withItemRemoved(body, id);
    const outcome = removal.ok ? await submit(removal.value) : { ok: false as const, error: removal.error };
    setRemoveErrors((previous) => { const next = new Map(previous); if (outcome.ok) next.delete(id); else next.set(id, outcome.error); return next; });
  }

  return (
    <ArtifactSection title={`Recommended next actions (${assessment.recommended_next_actions.length})`} testId="or-assessment-next-actions">
      <HandoffProvenance runId={runId} unitId={selectHandoffUnitId(revisionId)} revisionId={revisionId} />
      <div className="flex flex-col gap-3" data-testid="or-assessment-handoff">
        <p className="m-0 text-sm text-[var(--text-secondary)]">Add, edit or remove an action to publish a new assessment revision. Untick it to exclude it from this send only.</p>
        {items.length > 0 ? <ol className="m-0 flex list-decimal flex-col gap-2 pl-6">
          {items.map((item, index) => (
            <li key={item.id} className="rounded-md border border-[var(--border-decorative)] bg-[var(--bg-surface)] p-2">
              <div className="flex items-start gap-2">
                <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
                  <Checkbox type="checkbox" aria-label={`Include action ${index + 1}`} checked={item.is_included}
                    onChange={(event) => setItems((current) => current.map((candidate) => candidate.id === item.id
                      ? { ...candidate, is_included: event.target.checked } : candidate))} />
                  Include
                </label>
                <div className="min-w-0 flex-1">
                  <EditableBriefText anchor={`/recommended_next_actions/${item.id}/text`} value={item.text}
                    edit={{ ...edit, onEdit: (_anchor, _previous, next) => hasHandoffItem(body, item.id)
                      ? submit(withItemTextChanged(body, item.id, String(next)))
                      : Promise.resolve({ ok: false, error: "Action is absent from the current assessment. Refresh and review it again." }) }} isMultiline />
                </div>
                <Button variant="danger" size="xsmall" disabled={edit.isPending} onClick={() => void remove(item.id)}
                  aria-label={`Remove action ${index + 1}`}>Remove</Button>
              </div>
              {removeErrors.has(item.id) && <FeedbackMessage tone="danger">Not removed: {removeErrors.get(item.id)}</FeedbackMessage>}
            </li>
          ))}
        </ol> : <FeedbackMessage>No recommended next actions remain.</FeedbackMessage>}
        <AddNextAction isPending={edit.isPending} onAdd={(text) => submit(withItemAdded(body, text))} />

        <div className="flex items-center gap-2"><strong className="text-sm">Builder prompt preview</strong><Chip tone="neutral">{items.filter((item) => item.is_included).length} included</Chip></div>
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-[var(--border-decorative)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]" data-testid="or-assessment-handoff-preview">{preview || "No actions included."}</pre>
        <p className="m-0 text-xs text-[var(--text-muted)]">Sending records a review decision. The builder revises, and the assessor reassesses the new build.</p>
        {target.kind === "review" && <SendToBuilder key={target.gate.id} gate={target.gate} preview={preview}
          isEditPending={edit.isPending} onSent={() => void sentFeedback.refetch()} />}
        {target.kind === "sent" && <div className="flex items-center gap-2"><Chip tone="success">Sent</Chip><span className="text-sm text-[var(--text-secondary)]">Build changes requested. The builder will revise its work.</span></div>}
        {target.kind === "no_review" && <>
          <FeedbackMessage>{NO_REVIEW_REASON}</FeedbackMessage>
          <Button variant="primary" disabled>Send to Builder</Button>
        </>}
      </div>
    </ArtifactSection>
  );
}

import type { CurrentAssessment } from "../../lib/current-assessment";
import { selectAssessmentActions } from "../../lib/current-assessment";
import { addAction, initialAdjudication, selectAdjudicationPayload, selectAdjudicationSources, selectBuilderPreview, selectRecordedAssessmentDecision, selectSendability, setDisposition, type AdjudicationEffect } from "../../lib/assessment-handoff";
import { useResumeGate } from "../../hooks/useResumeGate";
import type { OperatorRevisionDecision } from "../../operator-contracts/projections/unit-view";
import { decisionAction } from "../../adapters/core";
import { randomUuid } from "../../../lib/random-uuid";
import { useRef } from "react";
import { AdjudicationAction } from "./AdjudicationAction";
import { AdjudicationHistory } from "../molecules/AdjudicationHistory";
import { selectHandoffRevisionId } from "../../lib/handoff-provenance";
interface CurrentProps { assessment: CurrentAssessment; revisionId: string; gate: ParkedGate | null; decisions: readonly OperatorRevisionDecision[] }
/** This form records a decision snapshot; the assessor's source words remain immutable. */
export function CurrentBuilderHandoffPanel(props: CurrentProps) {
  return <CurrentAdjudicationForm key={props.revisionId} {...props} />;
}
function CurrentAdjudicationForm({ assessment, revisionId, gate, decisions }: CurrentProps) {
  const [state, setState] = useState(() => initialAdjudication(assessment));
  const [audience, setAudience] = useState<"builder" | "operator">("builder");
  const sources = selectAdjudicationSources(assessment);
  const [source, setSource] = useState(sources[0]?.value ?? "");
  const [text, setText] = useState("");
  const [assessmentFeedback, setAssessmentFeedback] = useState("");
  const [hasRecorded, setHasRecorded] = useState(false);
  const keys = useRef(new Map<string, string>());
  const mutation = useResumeGate(gate?.id ?? "", gate?.run_id ?? null);
  const lists = selectAssessmentActions(assessment);
  const preview = selectBuilderPreview(state);
  const revision = selectHandoffRevisionId(revisionId) ?? revisionId;
  const recordedDecision = selectRecordedAssessmentDecision(decisions, revision);
  const recordedAdjudication = recordedDecision?.adjudication;
  const isRecorded = hasRecorded || recordedDecision !== null;
  const isOpen = gate?.actionable === true && selectHandoffRevisionId(gate.artifact_revision_id ?? undefined) === revision && !isRecorded;
  const disabled = !isOpen || mutation.isPending;
  function recorded(): void {
    setHasRecorded(true);
  }
  function submit(effect: AdjudicationEffect): void {
    if (!gate || disabled) return;
    const payload = selectAdjudicationPayload(state, effect);
    const definition = gate.decision_definitions?.find(definition => definition.submit.kind === "review" && definition.submit.decision === effect);
    if (!payload.ok || !definition || definition.is_available === false || !gate.artifact_revision_id) return;
    const identity = JSON.stringify({ effect, payload: payload.value });
    let key = keys.current.get(identity);
    if (!key) { key = randomUuid(); keys.current.set(identity, key); }
    mutation.mutate({ idempotency_key: key, artifact_revision_id: gate.artifact_revision_id, action: decisionAction(definition), feedback: preview, adjudication: payload.value }, { onSuccess: recorded });
  }
  return <ArtifactSection title="Action adjudication" testId="or-assessment-handoff">
    {!isOpen && <FeedbackMessage>{recordedDecision ? "The decision is recorded. Dispositions appear beside each action." : hasRecorded ? "Decision submitted. Waiting for recorded dispositions." : NO_REVIEW_REASON}</FeedbackMessage>}
    {(["builder", "operator"] as const).map(audience => <section key={audience} aria-label={`${audience} actions`}>
      <h3>{audience === "builder" ? "Builder" : "Operator"} actions ({lists[audience].length})</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">{lists[audience].map(action => <AdjudicationAction key={action.id} action={action}
        recorded={recordedAdjudication?.entries.find(entry => entry.action_id === action.id) ?? null}
        pending={state.dispositions.find(entry => entry.action_id === action.id) ?? { action_id: action.id, kind: "undecided" }} disabled={disabled}
        onChange={choice => setState(current => setDisposition(current, action.id, choice))} />)}{(recordedAdjudication?.added_actions ?? state.added_actions).filter(entry => entry.audience === audience).map(entry => <li key={entry.action_id}>
          <p><code>{entry.action_id}</code> <Chip tone="neutral">{recordedAdjudication ? "Recorded: added" : "Pending: added"}</Chip></p>
          <p>Added by operator: {entry.final_text}</p><p>Supporting {entry.source.kind}: {entry.source.id}</p>{entry.reason && <p>Reason: {entry.reason}</p>}
        </li>)}</ul>
    </section>)}
    {!isRecorded && <>
    <section aria-label="Add action" className="flex flex-col gap-2"><h3>Add action</h3>
      <label>Audience <Select aria-label="Added action audience" disabled={disabled} value={audience} onChange={event => setAudience(event.target.value as "builder" | "operator")}><option value="builder">Builder</option><option value="operator">Operator</option></Select></label>
      <label>Supporting item or finding <Select aria-label="Supporting item or finding" disabled={disabled} value={source} onChange={event => setSource(event.target.value)}>{sources.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
      <label>Action text <TextArea aria-label="Added action text" disabled={disabled} value={text} onChange={event => setText(event.target.value)} /></label>
      <Button size="small" disabled={disabled || !text.trim() || !source} onClick={() => { const option = sources.find(option => option.value === source); if (!option) return; setState(current => addAction(current, { audience, source: option.source, text })); setText(""); }}>Add</Button>
    </section>
    <strong>Builder preview</strong><pre className="whitespace-pre-wrap rounded-md border border-[var(--border-decorative)] p-3" data-testid="or-assessment-handoff-preview">{preview || "No builder actions selected."}</pre>
    <div className="flex flex-wrap gap-2">{(["accept", gate?.gate_step === "integration_review" ? "request_changes" : "request_build_changes"] as const).filter(effect => gate?.offered_decisions.includes(effect)).map(effect => {
      const sendability = selectSendability(state, effect);
      const definition = gate?.decision_definitions?.find(definition => definition.submit.kind === "review" && definition.submit.decision === effect);
      const reason = sendability.kind === "blocked" ? sendability.reason : definition?.is_available === false ? definition.disabled_reason ?? "Decision unavailable" : null;
      return <div key={effect}><Button disabled={disabled || reason !== null} title={reason ?? undefined} onClick={() => submit(effect)}>{effect === "accept" ? "Accept assessment" : effect === "request_changes" ? "Request integration changes" : "Request build changes"}</Button>{reason && <FeedbackMessage>{reason}</FeedbackMessage>}</div>;
    })}</div>
    {gate?.offered_decisions.includes("request_assessment_changes") && <section><label>Assessment feedback<TextArea aria-label="Assessment feedback" disabled={disabled} value={assessmentFeedback} onChange={event => setAssessmentFeedback(event.target.value)} /></label>
      <Button disabled={disabled || !assessmentFeedback.trim()} onClick={() => { if (gate.artifact_revision_id) mutation.mutate({ idempotency_key: randomUuid(), artifact_revision_id: gate.artifact_revision_id, action: "request_assessment_changes", feedback: assessmentFeedback }, { onSuccess: recorded }); }}>Request assessment changes</Button></section>}
    </>}
    {mutation.isError && <FeedbackMessage tone="danger">{mutation.error.message}</FeedbackMessage>}
    <AdjudicationHistory decisions={decisions} revisionId={revision} />
  </ArtifactSection>;
}
