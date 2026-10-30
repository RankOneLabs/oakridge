import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { randomUuid } from "../../../lib/random-uuid";
import type { ViewerProps } from "../../artifactRegistry";
import { useResumeGate } from "../../hooks/useResumeGate";
import type { Assessment } from "../../lib/assessment";
import { composeHandoffText, selectHandoffItems, withItemAdded, withItemRemoved, type HandoffItem } from "../../lib/assessment-handoff";
import type { ParkedGate } from "../../types";
import { AddNextAction } from "../molecules/AddNextAction";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { EditableBriefText } from "../molecules/EditableBriefText";

/** The assessment review decision that sends the build back with feedback. */
const REQUEST_BUILD_CHANGES = "request_build_changes";

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

  const decision = useResumeGate(gate?.id ?? "", gate?.run_id ?? null);
  // One idempotency key per composed request, preserved across retries of it.
  const request = useRef<{ readonly text: string; readonly key: string } | null>(null);
  const preview = composeHandoffText(items);
  const reason = preview.length === 0 ? "Include at least one next action to send."
    : !gate?.artifact_revision_id ? "This revision has no open assessment review to record the request on."
    : !gate.actionable ? "The run has moved on, so this review can no longer take a decision."
    : null;

  function remove(index: number): void {
    if (edit.isPending) return;
    edit.onSubmitBody?.(body, withItemRemoved(body, index));
  }

  function add(text: string): void {
    if (edit.isPending) return;
    edit.onSubmitBody?.(body, withItemAdded(body, text));
  }

  function send(): void {
    if (!gate?.artifact_revision_id || reason || decision.isPending) return;
    if (request.current?.text !== preview) request.current = { text: preview, key: randomUuid() };
    decision.mutate({
      idempotency_key: request.current.key,
      artifact_revision_id: gate.artifact_revision_id,
      gate_step: gate.gate_step ?? gate.gate_type,
      action: REQUEST_BUILD_CHANGES,
      operator_comment: "Send to builder",
      feedback: preview,
    });
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
                <Button variant="danger" size="xsmall" disabled={edit.isPending} onClick={() => remove(item.index)}
                  aria-label={`Remove action ${item.index + 1}`}>Remove</Button>
              </div>
            </li>
          ))}
        </ol> : <FeedbackMessage>No recommended next actions remain.</FeedbackMessage>}
        <AddNextAction isPending={edit.isPending} onAdd={add} />

        <div className="flex items-center gap-2"><strong className="text-sm">Builder prompt preview</strong><Chip tone="neutral">{items.filter((item) => item.is_included).length} included</Chip></div>
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]" data-testid="or-assessment-handoff-preview">{preview || "No actions included."}</pre>
        <p className="m-0 text-xs text-[var(--text-muted)]">Sending records a review decision. The builder revises, and the assessor reassesses the new build.</p>
        {reason && !decision.isSuccess && <FeedbackMessage>{reason}</FeedbackMessage>}
        {decision.isError && <FeedbackMessage tone="danger">{decision.error instanceof Error ? decision.error.message : String(decision.error)}</FeedbackMessage>}
        {decision.isSuccess
          ? <div className="flex items-center gap-2"><Chip tone="success">Sent</Chip><span className="text-sm text-[var(--text-secondary)]">Build changes requested. The builder will revise its work.</span></div>
          : <Button variant="primary" disabled={Boolean(reason) || edit.isPending || decision.isPending}
            onClick={send}>{decision.isPending ? "Sending…" : "Send to Builder"}</Button>}
      </div>
    </ArtifactSection>
  );
}
