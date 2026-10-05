import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { claimIntents, finishClaim, type ClaimedIntent, type EffectPayload, type EffectStatus } from "./leases";
import type { EffectProvider, ExternalHandle, ProviderResult } from "./provider";
import { materializeSelectedIntents } from "./reconcile";

export interface DispatchOptions {
  readonly owner: string;
  readonly concurrency: number;
  readonly lease_ms: number;
  readonly provider_timeout_ms: number;
}
export interface DispatchOutcome { readonly intent_id: string; readonly persisted: boolean; readonly status: EffectStatus }

function bounded(operation: Promise<ProviderResult<unknown>>, timeout_ms: number): Promise<ProviderResult<unknown>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "uncertain", detail: `provider did not respond within ${timeout_ms}ms` }), timeout_ms);
    operation.then((result) => { clearTimeout(timer); resolve(result); }, (error) => {
      clearTimeout(timer);
      resolve({ kind: "uncertain", detail: String(error) });
    });
  });
}

function isExternalHandle(value: unknown): value is ExternalHandle {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "kbbl_session") return "session_id" in value && typeof value.session_id === "string";
  if (value.kind === "repository") return "path" in value && typeof value.path === "string";
  if (value.kind === "pull_request") return "owner" in value && typeof value.owner === "string"
    && "name" in value && typeof value.name === "string" && "number" in value && typeof value.number === "number";
  return false;
}

function isPositiveStop(value: unknown): value is { readonly stopped: true } {
  return !!value && typeof value === "object" && "stopped" in value && value.stopped === true;
}

function isTerminal(value: unknown): value is { readonly kind: "terminal" } {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "terminal";
}

export async function dispatchClaim(db: TransactionalSqlExecutor, provider: EffectProvider, claim: ClaimedIntent, timeout_ms: number): Promise<DispatchOutcome> {
  const { action, invocation, handle } = claim.payload;
  let operation: Promise<ProviderResult<unknown>>;
  try {
    operation = action === "start" ? provider.start(invocation)
      : action === "stop" ? provider.stop(invocation, handle)
      : provider.observe(invocation, handle);
  } catch (error) {
    operation = Promise.resolve({ kind: "uncertain", detail: String(error) });
  }
  const result = await bounded(operation, timeout_ms);
  let status: EffectStatus;
  let payload: EffectPayload = claim.payload;
  switch (result.kind) {
    case "acknowledged":
      if (action === "start") {
        status = isExternalHandle(result.value) ? "acknowledged" : "uncertain";
        payload = { ...payload, handle: isExternalHandle(result.value) ? result.value : null,
          ...(!isExternalHandle(result.value) ? { last_detail: "provider acknowledged start without a valid handle" } : {}) };
      } else if (action === "stop") status = isPositiveStop(result.value) ? "cleanup_confirmed" : "cleanup_pending";
      else status = isTerminal(result.value) ? "cleanup_confirmed" : "pending";
      break;
    case "permanently_rejected":
      status = action === "stop" ? "cleanup_pending" : "rejected";
      payload = { ...payload, last_detail: `${result.code}: ${result.detail}` };
      break;
    case "transiently_unavailable":
      status = action === "stop" ? "cleanup_pending" : "pending";
      payload = { ...payload, last_detail: result.detail };
      break;
    case "uncertain":
      status = action === "stop" ? "cleanup_pending" : "uncertain";
      payload = { ...payload, last_detail: result.detail };
  }
  return { intent_id: claim.id, persisted: await finishClaim(db, claim, status, payload), status };
}

/** A stalled provider consumes one slot until its bounded deadline, not a sweep. */
export async function dispatchSweep(db: TransactionalSqlExecutor, provider: EffectProvider, options: DispatchOptions): Promise<readonly DispatchOutcome[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.provider_timeout_ms < 1 || options.lease_ms <= options.provider_timeout_ms)
    throw new Error("invalid dispatch bounds");
  await materializeSelectedIntents(db);
  const claims = await claimIntents(db, options.owner, options.concurrency, options.lease_ms);
  return Promise.all(claims.map((claim) => dispatchClaim(db, provider, claim, options.provider_timeout_ms)));
}
