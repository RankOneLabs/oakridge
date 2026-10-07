import { readAllInboxPages } from "./lib/operator-inbox";
import { OakridgeHttpError, selectFailureDetail } from "./lib/client-errors";
import { selectFallbackRefreshMs } from "./lib/oakridge-config";
import type { OakridgeConfig } from "./types";
import type { OperatorLaunchRequest, OperatorLaunchedRun, OperatorRunView, OperatorDefinitionSummary, OperatorScopeHistory, OperatorPinnedDefinition, OperatorScopeProjection, OperatorCommandSubmission, OperatorCommandReceipt } from "./operator-contracts";
import type { WorkflowDefinitionDescriptor } from "./workflow-definition-types";

export { selectFailureDetail } from "./lib/client-errors";
const API = "/oakridge/api";

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    throw new OakridgeHttpError(response.status, selectFailureDetail(failure, `${method} ${path}: ${response.status}`));
  }
  return response.json() as Promise<T>;
}
const get = <T,>(path: string): Promise<T> => request<T>("GET", path);
const post = <T,>(path: string, body: unknown): Promise<T> => request<T>("POST", path, body);
interface CursorPage<Item> { readonly items: readonly Item[]; readonly next_cursor: string | null }
async function readAllPages<Item>(path: string): Promise<Item[]> {
  const items: Item[] = [];
  let next_cursor: string | null = null;
  do {
    const page: CursorPage<Item> = await get(next_cursor === null ? path : `${path}?cursor=${encodeURIComponent(next_cursor)}`);
    items.push(...page.items);
    next_cursor = page.next_cursor;
  } while (next_cursor !== null);
  return items;
}

export async function fetchOakridgeConfig(): Promise<OakridgeConfig> {
  const response = await fetch("/oakridge/config");
  const served: OakridgeConfig = response.ok ? await response.json() as OakridgeConfig : { available: false };
  return { ...served, fallback_refresh_ms: selectFallbackRefreshMs({
    served: served.fallback_refresh_ms, configured: import.meta.env.VITE_OAKRIDGE_FALLBACK_REFRESH_MS }) };
}
export const fetchOperatorInbox = () => readAllInboxPages(get);
export const fetchOperatorRuns = (): Promise<OperatorRunView[]> => readAllPages("/api/runs");
export const fetchOperatorRun = (runId: string): Promise<OperatorRunView> => get(`/api/runs/${encodeURIComponent(runId)}`);
export const fetchOperatorDefinition = (runId: string): Promise<OperatorPinnedDefinition> => get(`/api/runs/${encodeURIComponent(runId)}/definition`);
export const fetchOperatorScope = (runId: string, scopeId: string): Promise<OperatorScopeProjection> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}`);
export const fetchOperatorScopeHistory = (runId: string, scopeId: string): Promise<OperatorScopeHistory> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}/history`);
export const fetchOperatorDefinitions = (): Promise<OperatorDefinitionSummary[]> => readAllPages("/api/definitions");
export const pinOperatorDefinition = (source: WorkflowDefinitionDescriptor): Promise<OperatorDefinitionSummary> => post("/api/definitions", source);
export const launchOperatorRun = (request: OperatorLaunchRequest): Promise<OperatorLaunchedRun> => post("/runs", request);
const inFlightCommands = new Map<string, Promise<OperatorCommandReceipt>>();
/**
 * The authority scopes command idempotency by (run_id, scope_id, request_id).
 * This dedup shares that identity rather than a prefix of it, so an id reused
 * across scopes cannot hand one scope's receipt to another scope's caller.
 */
const commandIdentity = (input: OperatorCommandSubmission): string =>
  JSON.stringify([input.run_id, input.scope_id, input.request_id]);
export function submitOperatorCommand(input: OperatorCommandSubmission): Promise<OperatorCommandReceipt> {
  const identity = commandIdentity(input);
  const active = inFlightCommands.get(identity);
  if (active) return active;
  const delivery = post<OperatorCommandReceipt>(`/api/runs/${encodeURIComponent(input.run_id)}/scopes/${encodeURIComponent(input.scope_id)}/commands`, {
    scope_id: input.scope_id, command_key: input.command_key, expected_scope_version: input.owner_version,
    targets: input.targets, payload: input.payload, request_id: input.request_id,
  });
  inFlightCommands.set(identity, delivery);
  void delivery.finally(() => { if (inFlightCommands.get(identity) === delivery) inFlightCommands.delete(identity); }).catch(() => undefined);
  return delivery;
}
