import { readAllInboxPages } from "./lib/operator-inbox";
import { OakridgeHttpError, selectFailureDetail } from "./lib/client-errors";
import { selectFallbackRefreshMs } from "./lib/oakridge-config";
import type { OakridgeConfig } from "./types";
import type { OperatorProjectDraft, OperatorProjectList, OperatorProjectView, OperatorStartPinnedRunRequest, OperatorStartedRun, OperatorRunView, OperatorDefinitionSummary, OperatorScopeHistory, OperatorPinnedDefinition, OperatorScopeView, OperatorCommandReceipt, OperatorArtifactRevisionRecord, OperatorSessionLocation, OperatorCheckedValue, OperatorCollaborationThreadView, OperatorCollaborationThreadRow, OperatorCollaborationMessageRow, OperatorReviewItemRow } from "./operator-contracts";
import type { WorkflowAuthoring } from "../../../../workflow-config/src/authoring";
import type { OperatorCommandSubmission } from "./lib/operator-drafts";

export { selectFailureDetail } from "./lib/client-errors";
const API = "/oakridge/api";

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    throw new OakridgeHttpError(response.status, selectFailureDetail(failure, `${method} ${path}: ${response.status}`));
  }
  return response.json() as Promise<T>;
}
const get = <T,>(path: string): Promise<T> => request<T>("GET", path);
const post = <T,>(path: string, body: unknown): Promise<T> => request<T>("POST", path, body);
const put = <T,>(path: string, body: unknown): Promise<T> => request<T>("PUT", path, body);
interface CursorPage<Item> { readonly items: readonly Item[]; readonly next_cursor: string | null }
async function readAllPages<Item>(path: string): Promise<Item[]> {
  const items: Item[] = [];
  let next_cursor: string | null = null;
  do {
    const page: CursorPage<Item> = await get(next_cursor === null ? path : `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(next_cursor)}`);
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
export const fetchOperatorRuns = (is_archived = false): Promise<OperatorRunView[]> => readAllPages(is_archived ? "/api/runs?archived=true" : "/api/runs");
export const fetchOperatorRun = (runId: string): Promise<OperatorRunView> => get(`/api/runs/${encodeURIComponent(runId)}`);
export const fetchOperatorDefinition = (runId: string): Promise<OperatorPinnedDefinition> => get(`/api/runs/${encodeURIComponent(runId)}/definition`);
export const fetchOperatorScope = (runId: string, scopeId: string): Promise<OperatorScopeView> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}`);
export const fetchOperatorScopeHistory = (runId: string, scopeId: string): Promise<OperatorScopeHistory> => get(`/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}/history`);

/** Legacy global links have no lookup endpoint in v2. Inspect the read projections. */
async function findInProjectedScopes<T>(select: (scope: OperatorScopeView) => T | null): Promise<T | null> {
  for (const isArchived of [false, true]) {
    const runs = await fetchOperatorRuns(isArchived);
    for (const run of runs) for (const summary of run.scopes) {
      const found = select(await fetchOperatorScope(run.run_id, summary.scope_id));
      if (found !== null) return found;
    }
  }
  return null;
}

export const fetchOperatorArtifactRevision = (revisionId: string): Promise<OperatorArtifactRevisionRecord | null> =>
  findInProjectedScopes((scope) => scope.outputs.find((slot) => slot.current_revision?.id === revisionId)?.current_revision ?? null);

function containsCheckedString(value: OperatorCheckedValue | null, wanted: string): boolean {
  if (value === null) return false;
  const data = value.data;
  if (data.kind === "string") return data.value === wanted;
  if (data.kind === "reference") return data.id === wanted;
  if (data.kind === "record") return data.fields.some((field) => containsCheckedString(field.value ?? null, wanted))
    || data.dictionary.some((entry) => containsCheckedString(entry.value, wanted));
  if (data.kind === "list") return data.items.some((item) => containsCheckedString(item, wanted));
  if (data.kind === "optional") return containsCheckedString(data.value ?? null, wanted);
  if (data.kind === "variant") return containsCheckedString(data.value, wanted);
  return false;
}

export const fetchOperatorSessionLocation = (sessionId: string): Promise<OperatorSessionLocation | null> =>
  findInProjectedScopes((scope) => {
    const execution = scope.executions.find((item) => containsCheckedString(item.result, sessionId));
    return execution ? { run_id: scope.run_id, scope_id: scope.scope_id, execution_id: execution.id } : null;
  });

const revisionThreadsPath = (runId: string, scopeId: string, revisionId: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}/revisions/${encodeURIComponent(revisionId)}/threads`;
const scopeThreadPath = (runId: string, scopeId: string, threadId: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/scopes/${encodeURIComponent(scopeId)}/threads/${encodeURIComponent(threadId)}`;

export const fetchOperatorThreads = (runId: string, scopeId: string, revisionId: string): Promise<readonly OperatorCollaborationThreadView[]> =>
  get(revisionThreadsPath(runId, scopeId, revisionId));
export const createOperatorThread = (input: { readonly run_id: string; readonly scope_id: string; readonly revision_id: string; readonly request_key: string; readonly title: string; readonly anchor: string | null }): Promise<OperatorCollaborationThreadRow> =>
  post(revisionThreadsPath(input.run_id, input.scope_id, input.revision_id), { request_key: input.request_key, title: input.title, anchor: input.anchor });
export const addOperatorMessage = (input: { readonly run_id: string; readonly scope_id: string; readonly thread_id: string; readonly request_key: string; readonly text: string; readonly author: string; readonly ping: boolean }): Promise<{ readonly message: OperatorCollaborationMessageRow }> =>
  post(`${scopeThreadPath(input.run_id, input.scope_id, input.thread_id)}/messages`, { request_key: input.request_key, text: input.text, author: input.author, ping: input.ping });
export const addOperatorReviewItem = (input: { readonly run_id: string; readonly scope_id: string; readonly thread_id: string; readonly request_key: string; readonly title: string; readonly detail: string; readonly status: string }): Promise<OperatorReviewItemRow> =>
  post(`${scopeThreadPath(input.run_id, input.scope_id, input.thread_id)}/review-items`, { request_key: input.request_key, title: input.title, detail: input.detail, status: input.status });
export const fetchOperatorDefinitions = (is_archived = false): Promise<OperatorDefinitionSummary[]> => readAllPages(is_archived ? "/api/definitions?archived=true" : "/api/definitions");
export const fetchOperatorDefinitionDetail = (bundleId: string): Promise<unknown> => get(`/api/definitions/${encodeURIComponent(bundleId)}`);
export const setOperatorRunArchived = (runId: string, is_archived: boolean): Promise<unknown> => is_archived
  ? post(`/api/runs/${encodeURIComponent(runId)}/archive`, {}) : post(`/api/runs/${encodeURIComponent(runId)}/unarchive`, {});
export const setOperatorDefinitionArchived = (bundleId: string, is_archived: boolean): Promise<unknown> => is_archived
  ? post(`/api/definitions/${encodeURIComponent(bundleId)}/archive`, {}) : post(`/api/definitions/${encodeURIComponent(bundleId)}/unarchive`, {});
export const fetchOperatorProjects = async (): Promise<readonly OperatorProjectView[]> => (await get<OperatorProjectList>("/api/projects")).items;
export const createOperatorProject = (draft: OperatorProjectDraft): Promise<OperatorProjectView> => post("/api/projects", draft);
export const updateOperatorProject = (projectId: string, draft: OperatorProjectDraft): Promise<OperatorProjectView> => put(`/api/projects/${encodeURIComponent(projectId)}`, draft);
/** Compilation is a separate authority check before the UI enables pinning. */
export const compileOperatorDefinition = (authoring: WorkflowAuthoring): Promise<unknown> => post("/api/definitions/compile", { authoring });
export const pinOperatorDefinition = (authoring: WorkflowAuthoring): Promise<OperatorDefinitionSummary> => post("/api/definitions", { authoring });
export const launchOperatorRun = (request: OperatorStartPinnedRunRequest): Promise<OperatorStartedRun> => post("/runs", request);
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
