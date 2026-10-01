import type { StageInputSet } from "../decision/commands";
import type { ArtifactId, AttemptId, JsonValue } from "./primitives";
import type { BlockedReason, CoreStatus, NextActor } from "./records";
import type { StageOperatorRole } from "./workflow";

export type StateName = string & { readonly __brand: "StateName" };
export type GuardName = string & { readonly __brand: "GuardName" };
export type EffectName = string & { readonly __brand: "EffectName" };
export type ObserverName = string & { readonly __brand: "ObserverName" };
export type RefusalCode = string & { readonly __brand: "RefusalCode" };
export type GateId = string & { readonly __brand: "GateId" };
export type JsonObject = { readonly [key: string]: JsonValue };

type NonterminalStatus = Exclude<CoreStatus, "complete" | "failed" | "cancelled">;
export type StateDeclaration =
  | { readonly status: "blocked"; readonly blocked_reason: BlockedReason; readonly next_actor: NextActor; readonly session_role: StageOperatorRole | null }
  | { readonly status: Exclude<NonterminalStatus, "blocked">; readonly blocked_reason: null; readonly next_actor: NextActor; readonly session_role: StageOperatorRole | null }
  | { readonly status: "complete" | "failed" | "cancelled"; readonly blocked_reason: null; readonly next_actor: null; readonly session_role: StageOperatorRole | null };

export interface MachineDefinition {
  readonly initial: StateName;
  readonly states: Readonly<Record<StateName, StateDeclaration>>;
  readonly transitions: readonly Transition[];
}

export type EventMatch =
  | { readonly event: "started" }
  | { readonly event: "artifact_published"; readonly output: string }
  | { readonly event: "gate_decided"; readonly gate: string; readonly action: string }
  | { readonly event: "session_ended" }
  | { readonly event: "operator_retry" }
  | { readonly event: "operator_abandon" }
  | { readonly event: "cancel" }
  | { readonly event: "external_observed"; readonly source: ObserverName };
export type FromMatch = StateName | { readonly any_nonterminal: true };
export interface GuardRef { readonly name: GuardName; readonly negate: boolean; readonly args: JsonObject }
export interface EffectRef { readonly name: EffectName; readonly args: JsonObject }
export type Transition =
  | { readonly from: FromMatch; readonly on: EventMatch; readonly guard: GuardRef | null; readonly to: StateName; readonly effects: readonly EffectRef[] }
  | { readonly from: FromMatch; readonly on: EventMatch; readonly guard: GuardRef | null; readonly refuse: RefusalCode };

export type SessionEndOutcome =
  | { readonly kind: "exited"; readonly exit_code: number | null }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled" };
export type StageEvent =
  | { readonly kind: "started" }
  | { readonly kind: "artifact_published"; readonly attempt_id: AttemptId; readonly output: string; readonly collection_key: string | null; readonly artifact_id: ArtifactId; readonly enrichment: JsonValue | null }
  | { readonly kind: "gate_decided"; readonly gate_id: GateId; readonly gate: string; readonly action: string; readonly actor: string; readonly feedback: string | null }
  | { readonly kind: "session_ended"; readonly attempt_id: AttemptId; readonly outcome: SessionEndOutcome }
  | { readonly kind: "operator_retry"; readonly idempotency_key: string; readonly actor: string }
  | { readonly kind: "operator_abandon"; readonly actor: string; readonly detail: string }
  | { readonly kind: "cancel"; readonly actor: string }
  | { readonly kind: "external_observed"; readonly source: ObserverName; readonly observation: JsonValue };
export interface RoundOutput { readonly output: string; readonly collection_key: string | null; readonly artifact_id: ArtifactId; readonly body: JsonValue }
export interface GuardContext { readonly event: StageEvent; readonly stage_data: JsonValue; readonly round_outputs: readonly RoundOutput[]; readonly stage_inputs: StageInputSet; readonly registry: MachineRegistry }
export type GuardPredicate = (context: GuardContext, args: JsonObject) => boolean | { readonly holds: boolean; readonly detail: string | null };
export interface MachineRegistry {
  has_guard(stage_type: string, name: GuardName): boolean;
  has_effect(stage_type: string, name: EffectName): boolean;
  has_observer(stage_type: string, name: ObserverName): boolean;
  guard(stage_type: string, name: GuardName): GuardPredicate | undefined;
}
export interface CompiledMachine extends MachineDefinition {
  readonly stage_type: string;
}
export type TransitionResult =
  | { readonly kind: "applied"; readonly from: StateName; readonly to: StateName; readonly effects: readonly EffectRef[]; readonly row_index: number }
  | { readonly kind: "refused"; readonly from: StateName; readonly code: RefusalCode; readonly row_index: number | null; readonly detail?: string };
