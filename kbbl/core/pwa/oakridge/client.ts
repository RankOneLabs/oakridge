import { readAllInboxPages } from "./lib/operator-inbox";
import { OakridgeHttpError, selectFailureDetail } from "./lib/client-errors";
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

export async function fetchOakridgeConfig(): Promise<OakridgeConfig> {
  const response = await fetch("/oakridge/config");
  return response.ok ? response.json() as Promise<OakridgeConfig> : { available: false };
}
export const fetchOperatorInbox = () => readAllInboxPages(get);
export const fetchOperatorRuns = (): Promise<OperatorRunView[]> => get("/api/runs");
export const fetchOperatorRun = (runId: string): Promise<OperatorRunView> => get(`/api/runs/${encodeURIComponent(runId)}`);
export const fetchOperatorDefinition = (runId: string): Promise<OperatorPinnedDefinition> => get(`/api/runs/${encodeURIComponent(runId)}/definition`);
export const fetchOperatorScope = (runId: string, scopeId: string): Promise<OperatorScopeProjection> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}`);
export const fetchOperatorScopeHistory = (runId: string, scopeId: string): Promise<OperatorScopeHistory> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}/history`);
export const fetchOperatorDefinitions = (): Promise<OperatorDefinitionSummary[]> => get("/api/definitions");
export const pinOperatorDefinition = (source: WorkflowDefinitionDescriptor): Promise<OperatorDefinitionSummary> => post("/api/definitions", source);
export const launchOperatorRun = (request: OperatorLaunchRequest): Promise<OperatorLaunchedRun> => post("/runs", request);
const inFlightCommands = new Map<string, Promise<OperatorCommandReceipt>>();
export function submitOperatorCommand(input: OperatorCommandSubmission): Promise<OperatorCommandReceipt> {
  const active = inFlightCommands.get(input.request_id);
  if (active) return active;
  const delivery = post<OperatorCommandReceipt>(`/api/runs/${encodeURIComponent(input.run_id)}/scopes/${encodeURIComponent(input.scope_id)}/commands`, {
    scope_id: input.scope_id, command_key: input.command_key, expected_scope_version: input.owner_version,
    targets: input.targets, payload: input.payload, request_id: input.request_id,
  });
  inFlightCommands.set(input.request_id, delivery);
  void delivery.finally(() => { if (inFlightCommands.get(input.request_id) === delivery) inFlightCommands.delete(input.request_id); }).catch(() => undefined);
  return delivery;
}
