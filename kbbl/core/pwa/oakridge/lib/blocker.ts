import type { OperatorBlockerAuthor, OperatorBlockerHistory } from "../operator-contracts/projections/history-view";
import type { OperatorWriter } from "../operator-contracts/core-client/core-types";
import type { ParkedGate } from "../artifact-types";
/** Who published a blocker revision: the worker attempt, or none for an operator edit. */
export function selectBlockerAuthor(author: OperatorBlockerAuthor | null): string {
  if (!author) return "Author not recorded";
  const session = author.session_id ? `, session ${author.session_id}` : "";
  return `${author.worker} (attempt ${author.attempt_seq}${session})`;
}
export function selectBlockerActor(actor: OperatorWriter | null): string {
  if (!actor) return "Actor not recorded";
  if (actor.kind === "operator") return `Operator ${actor.subject}`;
  if (actor.kind === "session") return `Session ${actor.session} (${actor.attempt})`;
  return actor.kind === "executor" ? `Executor ${actor.attempt}` : "Engine";
}
export const selectBlockerHistory = (blocker: OperatorBlockerHistory) => [...blocker.history].sort((a, b) =>
  (a.kind === "revision" ? a.revision.created_at : a.decision.created_at).localeCompare(b.kind === "revision" ? b.revision.created_at : b.decision.created_at));

/** A gate parked on an open blocker: the engine's implicit blocker_review, with the blocker it answers. */
export type OpenBlockerGate = ParkedGate & { readonly blocker: OperatorBlockerHistory };
export const isOpenBlockerGate = (gate: ParkedGate): gate is OpenBlockerGate =>
  gate.gate_step === "blocker_review" && gate.blocker?.is_open === true;

/**
 * Open blockers the operator settles with one answer: raised in the same run and offering the
 * same suggested choices. The engine still parks each unit on its own blocker, so one answer is
 * sent to every gate in the group.
 */
export interface BlockerGroup {
  readonly run_id: string;
  readonly suggested_choices: readonly string[];
  /** One gate per parked unit, oldest blocker first. */
  readonly gates: readonly OpenBlockerGate[];
}

/** A blocker with no suggested choices has nothing to match on, so it stays on its own. */
const blockerGroupKey = (gate: OpenBlockerGate): string => {
  const choices = gate.blocker.latest.suggested_choices ?? [];
  return choices.length === 0 ? JSON.stringify(["gate", gate.id]) : JSON.stringify(["choices", gate.run_id, choices]);
};

export function selectBlockerGroups(gates: readonly ParkedGate[]): readonly BlockerGroup[] {
  const open = gates.filter(isOpenBlockerGate).sort((a, b) => a.blocker.latest.created_at.localeCompare(b.blocker.latest.created_at));
  const groups = new Map<string, OpenBlockerGate[]>();
  for (const gate of open) groups.set(blockerGroupKey(gate), [...(groups.get(blockerGroupKey(gate)) ?? []), gate]);
  return [...groups.values()].map((members) => ({ run_id: members[0].run_id, suggested_choices: members[0].blocker.latest.suggested_choices ?? [], gates: members }));
}

/** The units a grouped blocker parks, by the label each gate carries. */
export const selectBlockerGroupUnits = (group: BlockerGroup): readonly string[] => group.gates.map((gate) => gate.unit_id);

/** The decisions every gate in the group offers, from the oldest gate: the engine gives each blocker the same three. */
export const selectBlockerGroupDecisions = (group: BlockerGroup) =>
  group.gates[0].decision_definitions?.filter((entry) => entry.submit.kind === "review" && entry.submit.review === "blocker_review") ?? [];

/** Gates still waiting for this answer: every gate not yet confirmed sent. */
export const selectUnsentBlockerGates = (group: BlockerGroup, sent_gate_ids: ReadonlySet<string>): readonly OpenBlockerGate[] =>
  group.gates.filter((gate) => !sent_gate_ids.has(gate.id));
