import { decodeCoreResponse, type CheckedValue, type Trigger } from "../core-client/generated-contracts";
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

function isCheckedValue(value: unknown): value is CheckedValue {
  return decodeCoreResponse({ version: 1, request_id: "effect-result", truncated: false, result: { status: "ok", value: { kind: "validated", value } } }) !== null;
}

function isExternalHandle(value: unknown): value is ExternalHandle {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "completed") return "result" in value && isCheckedValue(value.result);
  if (value.kind === "kbbl_session") return "session_id" in value && typeof value.session_id === "string";
  if (value.kind === "repository") return "path" in value && typeof value.path === "string";
  if (value.kind === "pull_request") return "owner" in value && typeof value.owner === "string"
    && "name" in value && typeof value.name === "string" && "number" in value && typeof value.number === "number";
  return false;
}

function isPositiveStop(value: unknown): value is { readonly stopped: true } {
  return !!value && typeof value === "object" && "stopped" in value && value.stopped === true;
}

function isTerminal(value: unknown): value is { readonly kind: "terminal"; readonly result: CheckedValue; readonly evidence?: Trigger } {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "terminal" && "result" in value && isCheckedValue(value.result);
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
        status = isExternalHandle(result.value) ? (result.value.kind === "completed" ? "cleanup_confirmed" : "acknowledged") : "uncertain";
        payload = { ...payload, handle: isExternalHandle(result.value) ? result.value : null,
          ...(!isExternalHandle(result.value) ? { last_detail: "provider acknowledged start without a valid handle" } : {}) };
      } else if (action === "stop") status = isPositiveStop(result.value) ? "cleanup_confirmed" : "cleanup_pending";
      else status = isTerminal(result.value) ? "cleanup_confirmed" : "pending";
      break;
    case "permanently_rejected":
      status = action === "stop" ? "cleanup_pending" : action === "start" && payload.has_uncertain_start ? "uncertain" : "rejected";
      payload = { ...payload, last_detail: `${result.code}: ${result.detail}`, ...(result.evidence ? { evidence: result.evidence } : {}) };
      break;
    case "transiently_unavailable":
      status = action === "stop" ? "cleanup_pending" : "pending";
      payload = { ...payload, last_detail: result.detail };
      break;
    case "uncertain":
      status = action === "stop" ? "cleanup_pending" : "uncertain";
      payload = { ...payload, last_detail: result.detail };
  }
  if (action === "start" && status === "uncertain") payload = { ...payload, has_uncertain_start: true };
  const persisted = await db.transaction(async (tx) => {
    if (action === "observe" && result.kind === "acknowledged" && isTerminal(result.value) && result.value.evidence) payload = { ...payload, evidence: result.value.evidence };
    if (payload.handle?.kind === "completed" && payload.handle.evidence) payload = { ...payload, evidence: payload.handle.evidence };
    const finished = await finishClaim(tx, claim, status, payload);
    if (!finished) return false;
    const terminal_result = action === "start" && payload.handle?.kind === "completed" ? payload.handle.result
      : action === "observe" && result.kind === "acknowledged" && isTerminal(result.value) ? result.value.result : null;
    if (terminal_result && claim.execution_id) {
      await tx.query("UPDATE authority.execution SET result=$1,status='terminal',version=version+1 WHERE id=$2", [JSON.stringify(terminal_result), claim.execution_id]);
      await tx.query("INSERT INTO authority.fact (id,scope_id,fact_key,payload) VALUES ($1,$2,$3,$4)", [crypto.randomUUID(), claim.scope_id, invocation.id, JSON.stringify(terminal_result)]);
      await tx.query("UPDATE authority.scope_instance SET version=version+1 WHERE id=$1", [claim.scope_id]);
    }
    if (action === "start" && status === "acknowledged") {
      await tx.query(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
        VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (scope_id,effect_key) DO NOTHING`,
        [crypto.randomUUID(), claim.scope_id, claim.execution_id, `${claim.effect_key}:observe`, JSON.stringify({ invocation, action: "observe", handle: payload.handle })]);
    }
    return true;
  });
  return { intent_id: claim.id, persisted, status };
}

/** A stalled provider consumes one slot until its bounded deadline, not a sweep. */
export async function dispatchSweep(db: TransactionalSqlExecutor, provider: EffectProvider, options: DispatchOptions): Promise<readonly DispatchOutcome[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || !Number.isSafeInteger(options.provider_timeout_ms) || options.provider_timeout_ms < 1 || !Number.isSafeInteger(options.lease_ms) || options.lease_ms <= options.provider_timeout_ms)
    throw new Error("invalid dispatch bounds");
  await materializeSelectedIntents(db);
  const claims = await claimIntents(db, options.owner, options.concurrency, options.lease_ms);
  return Promise.all(claims.map((claim) => dispatchClaim(db, provider, claim, options.provider_timeout_ms)));
}
