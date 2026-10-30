import { useEffect, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { Sid } from "../../../lib/ids";
import { useStore } from "../../../state/store";
import type { ViewerProps } from "../../artifactRegistry";
import { useRunSessions } from "../../hooks/useRunSessions";
import { useSendToBuilder } from "../../hooks/useSendToBuilder";
import type { Assessment } from "../../lib/assessment";
import { composeHandoffText, selectHandoffItems, withItemRemoved, type HandoffItem } from "../../lib/assessment-handoff";
import { selectCohortBuilderSession } from "../../lib/run-sessions";
import { ArtifactSection } from "../molecules/ArtifactSection";
import { EditableBriefText } from "../molecules/EditableBriefText";

interface Props {
  assessment: Assessment;
  /** The unnormalised revision body preserves fields outside the parser's view. */
  body: Assessment;
  runId: string;
  cohortLabel: string;
  edit: NonNullable<ViewerProps["edit"]>;
}

export function BuilderHandoffPanel({ assessment, body, runId, cohortLabel, edit }: Props) {
  const [items, setItems] = useState<HandoffItem[]>(() => selectHandoffItems(assessment));
  useEffect(() => {
    setItems((previous) => selectHandoffItems(assessment).map((item) => ({
      ...item, is_included: previous[item.index]?.is_included ?? true,
    })));
  }, [assessment]);

  const sessions = useRunSessions(runId);
  const builder = selectCohortBuilderSession(sessions.data ?? [], cohortLabel);
  const status = useStore((state) => builder ? state.sessions.get(builder.session_id as Sid)?.status ?? null : null);
  const hasSessionInventory = useStore((state) => state.hasInboxSnapshot && state.hasSessionSeed);
  const handoff = useSendToBuilder(builder?.session_id ?? null);
  const preview = composeHandoffText(items);
  const reason = preview.length === 0 ? "Include at least one next action to send."
    : !builder ? "No builder session exists for this cohort."
    : status === "provisioning" ? "The builder session is still starting."
    : status === "ended" || status === "fenced" || status === "failed"
      ? "Session input is refused for an ended, failed or fenced session. Use Resume to start a new session."
      : status === null ? hasSessionInventory
        ? "Builder session is missing from the session inventory. Check whether it was removed; use Resume if an ended, failed or fenced session is still available."
        : "Waiting for the builder session inventory."
      : null;

  function remove(index: number): void {
    if (edit.isPending) return;
    edit.onSubmitBody?.(body, withItemRemoved(body, index));
  }

  return (
    <ArtifactSection title={`Recommended next actions (${assessment.recommended_next_actions.length})`} testId="or-assessment-next-actions">
      <div className="flex flex-col gap-3" data-testid="or-assessment-handoff">
        <p className="m-0 text-sm text-[var(--text-secondary)]">Edit or remove an action to publish a new assessment revision. Untick it to exclude it from this send only.</p>
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
                  <EditableBriefText anchor={`/recommended_next_actions/${item.index}`} value={item.text} edit={edit} isMultiline />
                </div>
                <Button variant="danger" size="xsmall" disabled={edit.isPending} onClick={() => remove(item.index)}
                  aria-label={`Remove action ${item.index + 1}`}>Remove</Button>
              </div>
            </li>
          ))}
        </ol> : <FeedbackMessage>No recommended next actions remain.</FeedbackMessage>}

        <div className="flex items-center gap-2"><strong className="text-sm">Builder prompt preview</strong><Chip tone="neutral">{items.filter((item) => item.is_included).length} included</Chip></div>
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]" data-testid="or-assessment-handoff-preview">{preview || "No actions included."}</pre>
        <p className="m-0 text-xs text-[var(--text-muted)]">This handoff is not a review decision. A builder prompted while no attempt is running can edit, commit and push, but cannot publish a new build_result or pr.</p>
        {reason && <FeedbackMessage>{reason}</FeedbackMessage>}
        {handoff.state.kind === "rejected" && <FeedbackMessage tone="danger">{handoff.state.message}</FeedbackMessage>}
        {handoff.state.kind === "unknown" && <FeedbackMessage tone="danger">{handoff.state.message}</FeedbackMessage>}
        {handoff.state.kind === "sent" ? (
          <div className="flex items-center gap-2"><Chip tone="success">Sent</Chip><Button size="xsmall" onClick={handoff.rearm}>Prepare another handoff</Button></div>
        ) : <Button variant="primary" disabled={Boolean(reason) || edit.isPending || handoff.state.kind === "sending"}
          onClick={() => void handoff.send(preview)}>{handoff.state.kind === "sending" ? "Sending…" : "Send to Builder"}</Button>}
      </div>
    </ArtifactSection>
  );
}
