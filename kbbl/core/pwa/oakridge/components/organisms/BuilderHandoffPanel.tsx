import { useEffect, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { ViewerProps } from "../../artifactRegistry";
import type { Assessment } from "../../lib/assessment";
import { composeHandoffText, NO_REVIEW_REASON, selectHandoffItems, selectHandoffSendTarget, withItemAdded, withItemRemoved, type HandoffItem } from "../../lib/assessment-handoff";
import type { EditOutcome } from "../../lib/edit-outcome";
import type { ParkedGate } from "../../types";
import { AddNextAction } from "../molecules/AddNextAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { EditableBriefText } from "../molecules/EditableBriefText";
import { SendToBuilder } from "./SendToBuilder";

interface Props {
  assessment: Assessment;
  /** The unnormalised revision body preserves fields outside the parser's view. */
  body: Assessment;
  /** The open assessment review; null when the revision on screen has none. */
  gate: ParkedGate | null;
  edit: NonNullable<ViewerProps["edit"]>;
}

export function BuilderHandoffPanel({ assessment, body, gate, edit }: Props) {
  const [items, setItems] = useState<HandoffItem[]>(() => selectHandoffItems(assessment));
  useEffect(() => {
    setItems((previous) => selectHandoffItems(assessment).map((item) => ({
      ...item, is_included: previous[item.index]?.is_included ?? true,
    })));
  }, [assessment]);
  const [sentGateId, setSentGateId] = useState<string | null>(null);
  const target = selectHandoffSendTarget(gate, sentGateId);
  const preview = composeHandoffText(items);

  function submit(next: Assessment): Promise<EditOutcome> {
    if (!edit.onSubmitBody) return Promise.resolve({ ok: false, error: "This assessment cannot be edited." });
    return edit.onSubmitBody(body, next);
  }

  return (
    <ArtifactSection title={`Recommended next actions (${assessment.recommended_next_actions.length})`} testId="or-assessment-next-actions">
      <div className="flex flex-col gap-3" data-testid="or-assessment-handoff">
        <p className="m-0 text-sm text-[var(--text-secondary)]">Add, edit or remove an action to publish a new assessment revision. Untick it to exclude it from this send only.</p>
        {items.length > 0 ? <ol className="m-0 flex list-decimal flex-col gap-2 pl-6">
          {items.map((item) => (
            <li key={item.index} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="flex items-start gap-2">
                <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
                  <input type="checkbox" aria-label={`Include action ${item.index + 1}`} checked={item.is_included}
                    onChange={(event) => setItems((current) => current.map((candidate) => candidate.index === item.index
                      ? { ...candidate, is_included: event.target.checked } : candidate))} />
                  Include
                </label>
                <div className="min-w-0 flex-1">
                  <EditableBriefText anchor={`/recommended_next_actions/${item.index}`} value={item.text} edit={edit} />
                </div>
                <Button variant="danger" size="xsmall" disabled={edit.isPending} onClick={() => void submit(withItemRemoved(body, item.index))}
                  aria-label={`Remove action ${item.index + 1}`}>Remove</Button>
              </div>
            </li>
          ))}
        </ol> : <FeedbackMessage>No recommended next actions remain.</FeedbackMessage>}
        <AddNextAction isPending={edit.isPending} onAdd={(text) => submit(withItemAdded(body, text))} />

        <div className="flex items-center gap-2"><strong className="text-sm">Builder prompt preview</strong><Chip tone="neutral">{items.filter((item) => item.is_included).length} included</Chip></div>
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]" data-testid="or-assessment-handoff-preview">{preview || "No actions included."}</pre>
        <p className="m-0 text-xs text-[var(--text-muted)]">Sending records a review decision. The builder revises, and the assessor reassesses the new build.</p>
        {target.kind === "review" && <SendToBuilder key={target.gate.id} gate={target.gate} preview={preview}
          isEditPending={edit.isPending} onSent={() => setSentGateId(target.gate.id)} />}
        {target.kind === "sent" && <div className="flex items-center gap-2"><Chip tone="success">Sent</Chip><span className="text-sm text-[var(--text-secondary)]">Build changes requested. The builder will revise its work.</span></div>}
        {target.kind === "no_review" && <>
          <FeedbackMessage>{NO_REVIEW_REASON}</FeedbackMessage>
          <Button variant="primary" disabled>Send to Builder</Button>
        </>}
      </div>
    </ArtifactSection>
  );
}
