import { BLOCKER_REVIEW } from "../../operator-contracts/blocker";
import { useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { TextArea } from "../../../components/atoms/TextArea";
import type { ParkedGate } from "../../artifact-types";
import type { OperatorBlockerHistory } from "../../operator-contracts/projections/history-view";
import { useResumeGate } from "../../hooks/useResumeGate";
import { selectGateDecision } from "../../adapters/core";
import { randomUuid } from "../../../lib/random-uuid";
import { selectBlockerActor, selectBlockerAuthor, selectBlockerHistory } from "../../lib/blocker";
interface Props { readonly gate: ParkedGate; readonly blocker: OperatorBlockerHistory }
/** Uses the same gate mutation as every other review; refused answers remain drafts. */
export function BlockerPanel({ gate, blocker }: Props) {
  const mutation = useResumeGate(gate.id, gate.run_id);
  const [answer, setAnswer] = useState("");
  const [choice, setChoice] = useState("");
  const requestKeys = useRef(new Map<string, string>());
  const [action, setAction] = useState<string | null>(null);
  const [isSent, setIsSent] = useState(false);
  const decision = selectGateDecision(gate, action);
  const definitions = gate.decision_definitions?.filter((entry) => entry.submit.kind === "review" && entry.submit.review === BLOCKER_REVIEW) ?? [];
  function submit() {
    if (!action || !answer.trim() || !gate.artifact_revision_id || !decision || decision.is_available === false) return;
    const identity = JSON.stringify([gate.artifact_revision_id, action, answer]);
    const key = requestKeys.current.get(identity) ?? randomUuid();
    requestKeys.current.set(identity, key);
    mutation.mutate({ idempotency_key: key, artifact_revision_id: gate.artifact_revision_id, action, feedback: answer }, {
      onSuccess: () => { setIsSent(true); setAnswer(""); setChoice(""); },
    });
  }
  return <section className="space-y-3 rounded border-2 border-[var(--border-muted)] p-4" data-testid="or-blocker-panel">
    <h3>Open blocker</h3><p className="whitespace-pre-wrap">{blocker.latest.text}</p>
    <h4>Suggested choices (optional)</h4><ul>{blocker.latest.suggested_choices?.map((suggestion, index) => <li key={index}><Button variant="secondary" size="small" disabled={mutation.isPending} aria-pressed={choice === suggestion} onClick={() => { setChoice(suggestion); setAnswer(suggestion); }}>{suggestion}</Button></li>)}</ul>
    <h4>Revision and decision history</h4><ol>{selectBlockerHistory(blocker).map((entry) => entry.kind === "revision"
      ? <li key={`revision:${entry.revision.revision_id}`}><p>Revision {entry.revision.revision_id} · {selectBlockerAuthor(entry.revision.author)} · <time>{entry.revision.created_at}</time></p><p>{entry.revision.text}</p><ul>{entry.revision.suggested_choices?.map((text, i) => <li key={i}>{text}</li>)}</ul></li>
      : <li key={`decision:${entry.decision.id}`}><p>{selectBlockerActor(entry.decision.actor)} · <time>{entry.decision.created_at}</time> · {entry.decision.decision} · {entry.decision.target_revision_id}</p><p>{entry.decision.answer}</p></li>)}</ol>
    {isSent ? <p role="status">Answer sent.</p> : <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset disabled={mutation.isPending || !gate.actionable}><legend>Respond to blocker</legend>
        {definitions.map((definition) => <div key={definition.key} className="mr-3 inline-block">
          <Button type="button" variant="secondary" aria-pressed={definition.submit.kind === "review" && action === definition.submit.decision} disabled={definition.is_available === false}
            onClick={() => { if (definition.submit.kind === "review") setAction(definition.submit.decision); }}>{definition.label}</Button>
          {definition.disabled_reason && <span role="status"> — {definition.disabled_reason}</span>}
        </div>)}
        <label htmlFor={`blocker-answer-${gate.id}`}>Your answer (free text)</label><TextArea id={`blocker-answer-${gate.id}`} rows={4} value={answer} onChange={(event) => setAnswer(event.target.value)} />
        <Button type="submit" disabled={!action || !answer.trim() || decision?.is_available === false}>{mutation.isPending ? "Sending…" : "Send answer"}</Button>
      </fieldset>
      {mutation.isError && <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "Could not send answer."}</p>}
    </form>}
  </section>;
}
