import { useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { TextArea } from "../../../components/atoms/TextArea";
import { selectGateDecision } from "../../adapters/core";
import { randomUuid } from "../../../lib/random-uuid";
import { selectBlockerGroupDecisions, selectBlockerGroupUnits, selectUnsentBlockerGates, type BlockerGroup } from "../../lib/blocker";
import { useResumeGates, type GateResumeOutcome, type GateResumeTarget } from "../../hooks/useResumeGates";

interface Props { readonly group: BlockerGroup }

/**
 * Open blockers that ask the same question, answered once. The engine parks each unit on its
 * own blocker, so the answer goes to every unit's gate; a unit that refuses it can be retried alone.
 */
export function BlockerGroupPanel({ group }: Props) {
  const mutation = useResumeGates(group.run_id);
  const [answer, setAnswer] = useState("");
  const [choice, setChoice] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, GateResumeOutcome>>(new Map());
  const requestKeys = useRef(new Map<string, string>());
  const [oldest, ...others] = group.gates;
  const units = selectBlockerGroupUnits(group);
  const decisions = selectBlockerGroupDecisions(group);
  const sentGateIds = new Set([...outcomes.values()].filter((outcome) => outcome.ok).map((outcome) => outcome.gate_id));
  const unsent = selectUnsentBlockerGates(group, sentGateIds);

  function submit() {
    if (!action || !answer.trim()) return;
    const offered = unsent.flatMap((gate) => {
      const decision = selectGateDecision(gate, action);
      return gate.artifact_revision_id && decision && decision.is_available !== false ? [{ gate, artifact_revision_id: gate.artifact_revision_id }] : [];
    });
    const refused: GateResumeOutcome[] = unsent.filter((gate) => !offered.some((entry) => entry.gate.id === gate.id))
      .map((gate) => ({ gate_id: gate.id, ok: false, error: "this unit does not offer that decision" }));
    const targets: GateResumeTarget[] = offered.map(({ gate, artifact_revision_id }) => {
      const identity = JSON.stringify([gate.id, artifact_revision_id, action, answer]);
      const key = requestKeys.current.get(identity) ?? randomUuid();
      requestKeys.current.set(identity, key);
      return { gate_id: gate.id, request: { idempotency_key: key, artifact_revision_id, action, feedback: answer } };
    });
    const record = (results: readonly GateResumeOutcome[]) =>
      setOutcomes(new Map([...outcomes, ...[...refused, ...results].map((outcome) => [outcome.gate_id, outcome] as const)]));
    if (targets.length === 0) return record([]);
    mutation.mutate(targets, { onSuccess: record });
  }

  return <section className="space-y-3 rounded border-2 border-[var(--border-muted)] p-4" data-testid="or-blocker-group-panel">
    <h3>Open blocker{units.length > 1 ? ` · ${units.length} units` : ""}</h3>
    {units.length > 1 && <p data-testid="or-blocker-group-units">One answer goes to each of: {units.join(", ")}.</p>}
    <p className="whitespace-pre-wrap">{oldest.blocker.latest.text}</p>
    {others.map((gate) => <details key={gate.id}><summary>{gate.unit_id}'s blocker</summary><p className="whitespace-pre-wrap">{gate.blocker.latest.text}</p></details>)}
    {group.suggested_choices.length > 0 && <>
      <h4>Suggested choices (optional)</h4>
      <ul>{group.suggested_choices.map((suggestion, index) => <li key={index}><Button variant="secondary" size="small" disabled={mutation.isPending} aria-pressed={choice === suggestion}
        onClick={() => { setChoice(suggestion); setAnswer(suggestion); }}>{suggestion}</Button></li>)}</ul>
    </>}
    {unsent.length === 0 ? <p role="status">Answer sent to {units.length === 1 ? "the unit" : `all ${units.length} units`}.</p> : <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset disabled={mutation.isPending}><legend>Respond to blocker</legend>
        {decisions.map((definition) => <div key={definition.key} className="mr-3 inline-block">
          <Button type="button" variant="secondary" aria-pressed={definition.submit.kind === "review" && action === definition.submit.decision} disabled={definition.is_available === false}
            onClick={() => { if (definition.submit.kind === "review") setAction(definition.submit.decision); }}>{definition.label}</Button>
          {definition.disabled_reason && <span role="status"> — {definition.disabled_reason}</span>}
        </div>)}
        <label htmlFor={`blocker-group-answer-${oldest.id}`}>Your answer (free text)</label>
        <TextArea id={`blocker-group-answer-${oldest.id}`} rows={4} value={answer} onChange={(event) => setAnswer(event.target.value)} />
        <Button type="submit" disabled={!action || !answer.trim()}>{mutation.isPending ? "Sending…" : unsent.length === 1 ? "Send answer" : `Send answer to ${unsent.length} units`}</Button>
      </fieldset>
    </form>}
    {outcomes.size > 0 && <ul data-testid="or-blocker-group-outcomes">{group.gates.map((gate) => {
      const outcome = outcomes.get(gate.id);
      return outcome && <li key={gate.id} role={outcome.ok ? "status" : "alert"}>{gate.unit_id}: {outcome.ok ? "answer sent" : `not sent — ${outcome.error}`}</li>;
    })}</ul>}
  </section>;
}
