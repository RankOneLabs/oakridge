import type { ExecutorAdapter } from "../domain/execution";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import type { TransitionEffectDescriptor } from "../domain/run-record";
import type { EffectName, GuardName, GuardPredicate, MachineRegistry, ObserverName } from "../domain/stage-machine";

export class StageMachineRegistry implements MachineRegistry {
  private readonly guards = new Map<string, GuardPredicate>();
  private readonly effects = new Set<string>();
  private readonly observers = new Set<string>();

  private key(stage_type: string, name: string): string { return `${stage_type}:${name}`; }
  register_guard(stage_type: string, name: GuardName, predicate: GuardPredicate): void { this.guards.set(this.key(stage_type, name), predicate); }
  register_effect(stage_type: string, name: EffectName): void { this.effects.add(this.key(stage_type, name)); }
  register_observer(stage_type: string, name: ObserverName): void { this.observers.add(this.key(stage_type, name)); }
  has_guard(stage_type: string, name: GuardName): boolean { return this.guards.has(this.key(stage_type, name)) || name === "round_has" || name === "round_has_all"; }
  has_effect(stage_type: string, name: EffectName): boolean { return this.effects.has(this.key(stage_type, name))
    || ["launch_session", "end_session", "record_output", "open_gate", "accept_outputs", "new_round"].includes(name); }
  has_observer(stage_type: string, name: ObserverName): boolean { return this.observers.has(this.key(stage_type, name)); }
  guard(stage_type: string, name: GuardName): GuardPredicate | undefined {
    if (name === "round_has") return (context, args) =>
      typeof args.output === "string" && context.round_outputs.some((output) => output.output === args.output);
    if (name === "round_has_all") return (context, args) =>
      Array.isArray(args.outputs) && args.outputs.every((requested) =>
        typeof requested === "string" && context.round_outputs.some((output) => output.output === requested));
    return this.guards.get(this.key(stage_type, name));
  }
}

const adapters = new Map<string, ExecutorAdapter>();

export const findExecutorAdapter = (executor_type: string): ExecutorAdapter | undefined => adapters.get(executor_type);

export const registerExecutorAdapter = (adapter: ExecutorAdapter): void => {
  if (adapters.has(adapter.executor_type)) throw new Error(`executor adapter '${adapter.executor_type}' is already registered`);
  adapters.set(adapter.executor_type, adapter);
};

export interface AdapterDecisionContext {
  readonly event_name: string;
  readonly actor: string;
}

export interface AdapterDecisionHandler<Payload> {
  readonly name: string;
  decode(value: JsonValue): Result<Payload, string>;
  guard(context: AdapterDecisionContext, payload: Payload): Result<void, string>;
  effect(context: AdapterDecisionContext, payload: Payload): TransitionEffectDescriptor;
}

interface StoredDecisionHandler {
  readonly decode: (value: JsonValue) => Result<unknown, string>;
  readonly guard: (context: AdapterDecisionContext, payload: unknown) => Result<void, string>;
  readonly effect: (context: AdapterDecisionContext, payload: unknown) => TransitionEffectDescriptor;
}

export type AdapterDispatchError =
  | { readonly kind: "unregistered_event"; readonly name: string }
  | { readonly kind: "invalid_payload"; readonly name: string; readonly detail: string }
  | { readonly kind: "guard_refused"; readonly name: string; readonly detail: string }
  | { readonly kind: "effect_name_mismatch"; readonly name: string; readonly effect_name: string };

export interface DispatchedAdapterDecision {
  readonly payload: unknown;
  readonly effect: TransitionEffectDescriptor;
}

/**
 * Runtime-owned registry for names whose meaning belongs to an adapter.
 * Registration is explicit so tests and runtime composition do not share
 * mutable module state.
 */
export class AdapterRegistry {
  private readonly roles = new Set<string>();
  private readonly decision_handlers = new Map<string, StoredDecisionHandler>();

  register_role(name: string): void {
    if (name.trim().length === 0) throw new Error("adapter role name must be non-empty");
    if (this.roles.has(name)) throw new Error(`adapter role '${name}' is already registered`);
    this.roles.add(name);
  }

  has_role(name: string): boolean { return this.roles.has(name); }

  register_decision<Payload>(handler: AdapterDecisionHandler<Payload>): void {
    if (handler.name.trim().length === 0) throw new Error("adapter event name must be non-empty");
    if (this.decision_handlers.has(handler.name)) throw new Error(`adapter event '${handler.name}' is already registered`);
    this.decision_handlers.set(handler.name, {
      decode: handler.decode,
      guard: (context, payload) => handler.guard(context, payload as Payload),
      effect: (context, payload) => handler.effect(context, payload as Payload),
    });
  }

  has_decision(name: string): boolean { return this.decision_handlers.has(name); }

  dispatch(name: string, value: JsonValue, actor: string): Result<DispatchedAdapterDecision, AdapterDispatchError> {
    const handler = this.decision_handlers.get(name);
    if (!handler) return err({ kind: "unregistered_event", name });
    const decoded = handler.decode(value);
    if (!decoded.ok) return err({ kind: "invalid_payload", name, detail: decoded.error });
    const context = { event_name: name, actor };
    const guarded = handler.guard(context, decoded.value);
    if (!guarded.ok) return err({ kind: "guard_refused", name, detail: guarded.error });
    const effect = handler.effect(context, decoded.value);
    if (effect.kind !== name) return err({ kind: "effect_name_mismatch", name, effect_name: effect.kind });
    return ok({ payload: decoded.value, effect });
  }
}
