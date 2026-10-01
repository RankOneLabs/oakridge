import type { CompiledMachine, EventMatch, FromMatch, GuardContext, RefusalCode, StageEvent, StateName, TransitionResult } from "../domain/stage-machine";
import { readOwn } from "../domain/records";

const isTerminal = (status: string): boolean => status === "complete" || status === "failed" || status === "cancelled";
const matchesFrom = (machine: CompiledMachine, from: FromMatch, state: StateName): boolean =>
  typeof from === "string" ? from === state : !isTerminal(readOwn(machine.states, state)?.status ?? "failed");
const matchesEvent = (match: EventMatch, event: StageEvent): boolean => {
  if (match.event !== event.kind) return false;
  if (match.event === "artifact_published") return event.kind === "artifact_published" && match.output === event.output;
  if (match.event === "gate_decided") return event.kind === "gate_decided" && match.gate === event.gate && match.action === event.action;
  if (match.event === "external_observed") return event.kind === "external_observed" && match.source === event.source;
  return true;
};

export const transition = (machine: CompiledMachine, state: StateName, event: StageEvent, context: GuardContext): TransitionResult => {
  for (const [row_index, row] of machine.transitions.entries()) {
    if (!matchesFrom(machine, row.from, state) || !matchesEvent(row.on, event)) continue;
    if (row.guard) {
      const predicate = context.registry.guard(machine.stage_type, row.guard.name);
      if (!predicate) continue;
      const holds = predicate({ ...context, event }, row.guard.args);
      if (row.guard.negate ? holds : !holds) continue;
    }
    return "to" in row
      ? { kind: "applied", from: state, to: row.to, effects: row.effects, row_index }
      : { kind: "refused", from: state, code: row.refuse, row_index };
  }
  return { kind: "refused", from: state, code: "no_transition" as RefusalCode, row_index: null };
};
