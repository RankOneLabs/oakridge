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
import type { ParkedGate } from "../../types";
import { AddNextAction } from "../molecules/AddNextAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { EditableBriefText } from "../molecules/EditableBriefText";
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
      <div className="flex flex-col gap-3" data-testid="or-assessment-handoff">
        <p className="m-0 text-sm text-[var(--text-secondary)]">Add, edit or remove an action to publish a new assessment revision. Untick it to exclude it from this send only.</p>
        {items.length > 0 ? <ol className="m-0 flex list-decimal flex-col gap-2 pl-6">
          {items.map((item, index) => (
            <li key={item.id} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="flex items-start gap-2">
                <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
                  <input type="checkbox" aria-label={`Include action ${index + 1}`} checked={item.is_included}
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
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]" data-testid="or-assessment-handoff-preview">{preview || "No actions included."}</pre>
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
