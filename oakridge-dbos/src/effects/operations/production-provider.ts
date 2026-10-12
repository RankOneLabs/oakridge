import { PROVIDER_CATALOG, PROVIDER_ERROR_CODES, INPUT_CONTRACTS } from "../provider-catalog";
import type { Event as CoreEvent } from "../../core-client/core-types";
import type { CoreClient } from "../../core-client/client";
import type { ExecutionId, JsonValue } from "../../domain/primitives";
import type { SqlExecutor } from "../../storage/sql-executor";
import { KbblExecutorAdapter } from "../../adapters/kbbl";
import { BunGitCommandRunner } from "../../runtime/git-command-runner";
import { GithubPullRequestReader, type PullRequestReader } from "../../runtime/github-pull-requests";
import { RepositoryPreparationOperation } from "./repository-preparation";
import { PullRequestObservationOperation } from "./pull-request-observation";
import type { EffectProvider, ExternalHandle, ProviderResult, StableInvocation, TerminalObservation, ProviderCallOptions } from "../provider";
import type { Result } from "../../storage/commit";

export interface ProductionProviderOptions {
  readonly git?: import("../../domain/repository-provisioning").GitCommandRunner;
  readonly db: SqlExecutor;
  readonly core: CoreClient;
  readonly kbbl_base_url: string;
  readonly pull_requests?: PullRequestReader;
}

interface ActiveFiniteCall { readonly controller: AbortController; readonly finished: Promise<void> }
function pinnedInput(invocation: StableInvocation): Result<JsonValue> {
  try { return { ok: true, value: JSON.parse(invocation.bytes) as JsonValue }; }
  catch (error) { return { ok: false, error: { operation: "decode_provider_request", entity_id: invocation.id, detail: String(error) } }; }
}
const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } => !!value && typeof value === "object" && !Array.isArray(value);
const rejected = (detail: string): ProviderResult<never> => ({ kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.invalid_invocation, detail });

/** The attempt an invocation belongs to; v2 keys worker events on the action id. */
const actionOf = (invocation: StableInvocation): string => invocation.execution_id;

/**
 * v1 projected a provider failure into a declared recovery fact. v2 has no
 * facts: a worker that ends, however it ends, is one `worker_ended` event, and
 * the evaluator decides what that means for the unit.
 */
export type WorkerResult = { readonly kind: "succeeded" } | { readonly kind: "failed"; readonly code: string; readonly detail: string };
export function workerEnded(invocation: StableInvocation, result: WorkerResult): CoreEvent {
  return { kind: "worker_ended", action: actionOf(invocation), result };
}

export function visibleProviderCode(operation_key: string, version: number, code: string, detail: string): Extract<ProviderResult<never>, { readonly kind: "permanently_rejected" }> {
  const operation = PROVIDER_CATALOG.operations.find((item) => item.key === operation_key && item.version === version);
  return operation?.emitted_codes.some((emitted) => emitted === code)
    ? { kind: "permanently_rejected", code, detail }
    : { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.undeclared_provider_code, detail: `provider returned undeclared code ${code}: ${detail}` };
}

interface SessionFailureInput {
  readonly db: SqlExecutor;
  readonly core: CoreClient;
  readonly invocation: StableInvocation;
  readonly detail: string;
}
interface ConfiguredFailureInput extends SessionFailureInput { readonly code: string }

/** Every synthesized failure carries the same `worker_ended` evidence a provider rejection does. */
export function recoverConfiguredFailure({ invocation, code, detail }: ConfiguredFailureInput): ProviderResult<never> {
  return { kind: "permanently_rejected", code, detail,
    evidence: workerEnded(invocation, { kind: "failed", code, detail }) };
}
export function recoverStartFailure(input: ConfiguredFailureInput): ProviderResult<never> {
  return recoverConfiguredFailure(input);
}
/** Host-side observation failures end the worker exactly as a failed session does. */
export function recoverSessionFailure(input: SessionFailureInput): ProviderResult<never> {
  return recoverConfiguredFailure({ ...input, code: PROVIDER_ERROR_CODES.session_failed });
}

export function createEffectProvider(options: ProductionProviderOptions): EffectProvider {
  const active_finite_calls = new Map<string, Set<ActiveFiniteCall>>();
  const repository = new RepositoryPreparationOperation(options.git ?? new BunGitCommandRunner());
  const discovery = new PullRequestObservationOperation(options.pull_requests ?? new GithubPullRequestReader({ token: process.env.OAKRIDGE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "" }));
  function kbbl(call: ProviderCallOptions): KbblExecutorAdapter {
    return new KbblExecutorAdapter({ base_url: options.kbbl_base_url, executor_function_identity: "selected-v2",
      fetch: (input, init) => fetch(input, { ...init, signal: call.signal }) });
  }
  async function trackFinite(invocation: StableInvocation, call: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>> {
    const controller = new AbortController();
    const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const active = { controller, finished };
    const calls = active_finite_calls.get(invocation.id) ?? new Set<ActiveFiniteCall>();
    active_finite_calls.set(invocation.id, calls);
    calls.add(active);
    try { return await startInvocation(invocation, { signal }); }
    finally { calls.delete(active); if (!calls.size) active_finite_calls.delete(invocation.id); finish(); }
  }
  /** A finished code operation reports its result and the event that ends its worker. */
  function completed(invocation: StableInvocation, result: unknown): ProviderResult<ExternalHandle> {
    return { kind: "acknowledged", value: { kind: "completed", result,
      evidence: workerEnded(invocation, { kind: "succeeded" }) } };
  }
  async function startInvocation(invocation: StableInvocation, call: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>> {
    if (call.signal?.aborted) return { kind: "uncertain", detail: "provider operation aborted before IO" };
    if (!invocation.request || invocation.request.version !== 1) return rejected("selected provider request is missing or unsupported");
    if (invocation.request.kind === INPUT_CONTRACTS.session) {
      const result = await kbbl(call).start_pinned({ session_key: invocation.request.session_key, body: invocation.bytes });
      return result.kind === "acknowledged" && result.value.kind === INPUT_CONTRACTS.session ? { kind: "acknowledged", value: result.value }
        : result.kind === "acknowledged" ? rejected("kbbl returned no session") : result;
    }
    const input = pinnedInput(invocation);
    if (!input.ok) return rejected(input.error.detail);
    if (invocation.request.kind === INPUT_CONTRACTS.repository) {
      if (!isRecord(input.value) || typeof input.value.repository_path !== "string" || !(input.value.expected_head === null || input.value.expected_head === undefined || typeof input.value.expected_head === "string")) return rejected("invalid RepositoryPreparationInput");
      const result = await repository.execute({ repository_path: input.value.repository_path, expected_head: input.value.expected_head ?? null }, call);
      return result.kind === "acknowledged" ? completed(invocation, result.value)
        : result.kind === "permanently_rejected"
          ? recoverConfiguredFailure({ db: options.db, core: options.core, invocation, code: result.code, detail: result.detail })
          : result;
    }
    if (invocation.request.kind === INPUT_CONTRACTS.pull_request) {
      const query = isRecord(input.value) ? input.value.query : null;
      if (!query || !isRecord(query) || typeof query.owner !== "string" || typeof query.name !== "string" || typeof query.head_owner !== "string" || typeof query.head_branch !== "string" || typeof query.base_branch !== "string") return rejected("invalid PullRequestObservationInput");
      const result = await discovery.execute({ query: { owner: query.owner, name: query.name, head_owner: query.head_owner, head_branch: query.head_branch, base_branch: query.base_branch } }, call);
      return result.kind === "acknowledged" ? completed(invocation, result.value)
        : result.kind === "permanently_rejected"
          ? recoverConfiguredFailure({ db: options.db, core: options.core, invocation, code: result.code, detail: result.detail })
          : result;
    }
    if (invocation.request.kind === INPUT_CONTRACTS.stub) return rejected("unsupported operation");
    const unhandled: never = invocation.request;
    return unhandled;
  }
  return {
    start: (invocation, call = {}) => invocation.request?.kind === INPUT_CONTRACTS.repository || invocation.request?.kind === INPUT_CONTRACTS.pull_request
      ? trackFinite(invocation, call) : startInvocation(invocation, call),
    async stop(invocation, handle, call = {}) {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { stopped: true } };
      if (invocation.request?.kind === INPUT_CONTRACTS.repository || invocation.request?.kind === INPUT_CONTRACTS.pull_request) {
        // Finite reads create no durable remote execution. Abort owned transports and
        // wait for IO completion before acknowledging that this provider owns none.
        const active = [...(active_finite_calls.get(invocation.id) ?? [])];
        for (const operation of active) operation.controller.abort(new Error("selected finite operation revoked"));
        await Promise.all(active.map((operation) => operation.finished));
        if (call.signal?.aborted) return { kind: "uncertain", detail: "cleanup deadline exceeded before finite IO completed" };
        return { kind: "acknowledged", value: { stopped: true } };
      }
      if (invocation.request?.kind !== INPUT_CONTRACTS.session) return { kind: "uncertain", detail: "unsupported long-lived provider cleanup" };
      return kbbl(call).stop_pinned({ request: { session_key: invocation.request.session_key, body: invocation.bytes },
        execution_id: invocation.execution_id as ExecutionId, reference: handle?.kind === INPUT_CONTRACTS.session ? handle : null });
    },
    async observe(invocation, handle, call = {}): Promise<ProviderResult<TerminalObservation>> {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { kind: "terminal", result: handle.result } };
      if (handle?.kind !== INPUT_CONTRACTS.session) return { kind: "uncertain", detail: "no external handle for terminal observation" };
      const result = await kbbl(call).observe_terminal(invocation.execution_id as ExecutionId, handle);
      if (result.kind === "executor_unavailable") return { kind: "transiently_unavailable", detail: result.detail };
      if (result.kind === "pending") return { kind: "acknowledged", value: { kind: "running" } };
      if (result.observation.kind !== "succeeded") {
        const code = result.observation.kind === "failed" ? result.observation.code
          : "code" in result.observation && typeof result.observation.code === "string" ? result.observation.code : "executor_cancelled";
        return recoverSessionFailure({ db: options.db, core: options.core, invocation,
          detail: `${code}: ${result.observation.detail ?? "session cancelled"}` });
      }
      // A session publishes its own revisions; its terminal result is the end of its worker.
      return { kind: "acknowledged", value: { kind: "terminal", result: null,
        evidence: workerEnded(invocation, { kind: "succeeded" }) } };
    },
  };
}
