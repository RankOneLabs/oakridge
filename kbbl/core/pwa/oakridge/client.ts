import { readAllInboxPages } from "./lib/operator-inbox";
import { OakridgeHttpError, selectFailureDetail } from "./lib/client-errors";
import { selectFallbackRefreshMs } from "./lib/oakridge-config";
import type { OakridgeConfig } from "./types";
import type { OperatorProjectDraft, OperatorProjectList, OperatorProjectView, OperatorLaunchRequest, OperatorIngressCommitted, OperatorRunView, OperatorDefinitionSummary, OperatorDefinitionDetail, OperatorUnitHistory, OperatorPinnedDefinition, OperatorUnitView, OperatorInboxPage, OperatorRunInboxBatch, OperatorCollaborationThreadView, OperatorCollaborationThreadRow, OperatorCollaborationMessageRow, OperatorCompiledWorkflow, OperatorDecideRequest, OperatorIngressRequest, OperatorPublishRequest } from "./operator-contracts";
import type { WorkflowDefinitionDescriptor } from "./workflow-definition-types";
import type { OperatorDecisionSubmission } from "./lib/operator-drafts";

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
export const fetchOperatorRunInbox = (runId: string): Promise<OperatorInboxPage> => get(`/api/runs/${encodeURIComponent(runId)}/inbox`);
/** Keep each URL bounded while reading attention for an entire run catalog. */
export async function fetchOperatorRunInboxes(runIds: readonly string[]): Promise<OperatorRunInboxBatch> {
  const pages: OperatorRunInboxBatch[] = [];
  for (let index = 0; index < runIds.length; index += 100)
    pages.push(await get(`/api/run-inboxes?ids=${encodeURIComponent(runIds.slice(index, index + 100).join(","))}`));
  return { items: pages.flatMap((page) => page.items) };
}
export const fetchOperatorRunUnits = (runId: string): Promise<readonly OperatorUnitView[]> => get(`/api/runs/${encodeURIComponent(runId)}/units`);
export const fetchOperatorDefinition = (runId: string): Promise<OperatorPinnedDefinition> => get(`/api/runs/${encodeURIComponent(runId)}/definition`);
export const fetchOperatorUnit = (runId: string, unitId: string): Promise<OperatorUnitView> => get(`/api/runs/${encodeURIComponent(runId)}/units/${encodeURIComponent(unitId)}`);
export const fetchOperatorUnitHistory = (runId: string, unitId: string): Promise<OperatorUnitHistory> => get(`/api/runs/${encodeURIComponent(runId)}/units/${encodeURIComponent(unitId)}/history`);

const revisionThreadsPath = (runId: string, unitId: string, revisionId: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/units/${encodeURIComponent(unitId)}/revisions/${encodeURIComponent(revisionId)}/threads`;
const unitThreadPath = (runId: string, unitId: string, threadId: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/units/${encodeURIComponent(unitId)}/threads/${encodeURIComponent(threadId)}`;

export const fetchOperatorThreads = (runId: string, unitId: string, revisionId: string): Promise<readonly OperatorCollaborationThreadView[]> =>
  get(revisionThreadsPath(runId, unitId, revisionId));
export const createOperatorThread = (input: { readonly run_id: string; readonly unit_id: string; readonly revision_id: string; readonly request_key: string; readonly title: string; readonly anchor: string | null }): Promise<OperatorCollaborationThreadRow> =>
  post(revisionThreadsPath(input.run_id, input.unit_id, input.revision_id), { request_key: input.request_key, title: input.title, anchor: input.anchor });
/** The backend records the message's author from the credential that posts it. */
export const addOperatorMessage = (input: { readonly run_id: string; readonly unit_id: string; readonly thread_id: string; readonly request_key: string; readonly text: string }): Promise<{ readonly message: OperatorCollaborationMessageRow }> =>
  post(`${unitThreadPath(input.run_id, input.unit_id, input.thread_id)}/messages`, { request_key: input.request_key, text: input.text });
export const fetchOperatorDefinitions = (is_archived = false): Promise<OperatorDefinitionSummary[]> => readAllPages(is_archived ? "/api/definitions?archived=true" : "/api/definitions");
export const fetchOperatorDefinitionDetail = (bundleId: string): Promise<OperatorDefinitionDetail> => get(`/api/definitions/${encodeURIComponent(bundleId)}`);
export const setOperatorRunArchived = (runId: string, is_archived: boolean): Promise<unknown> => is_archived
  ? post(`/api/runs/${encodeURIComponent(runId)}/archive`, {}) : post(`/api/runs/${encodeURIComponent(runId)}/unarchive`, {});
export const setOperatorDefinitionArchived = (bundleId: string, is_archived: boolean): Promise<unknown> => is_archived
  ? post(`/api/definitions/${encodeURIComponent(bundleId)}/archive`, {}) : post(`/api/definitions/${encodeURIComponent(bundleId)}/unarchive`, {});
export const fetchOperatorProjects = async (): Promise<readonly OperatorProjectView[]> => (await get<OperatorProjectList>("/api/projects")).items;
export const createOperatorProject = (draft: OperatorProjectDraft): Promise<OperatorProjectView> => post("/api/projects", draft);
export const updateOperatorProject = (projectId: string, draft: OperatorProjectDraft): Promise<OperatorProjectView> => put(`/api/projects/${encodeURIComponent(projectId)}`, draft);
/** Compiling is the authority's check before the editor offers to pin. */
export const compileOperatorDefinition = (workflow: WorkflowDefinitionDescriptor): Promise<OperatorCompiledWorkflow> => post("/api/definitions/compile", workflow);
export const pinOperatorDefinition = (workflow: WorkflowDefinitionDescriptor): Promise<OperatorDefinitionSummary> => post("/api/definitions", workflow);
export const launchOperatorRun = (request: OperatorLaunchRequest): Promise<OperatorIngressCommitted> => post("/api/runs", request);

const runPath = (runId: string): string => `/api/runs/${encodeURIComponent(runId)}`;
const unitPath = (runId: string, unitId: string): string => `${runPath(runId)}/units/${encodeURIComponent(unitId)}`;

/** An operator's edit of an agent's artifact: a new revision after the one the operator edited. */
export interface OperatorArtifactEdit extends OperatorPublishRequest { readonly run_id: string; readonly unit_id: string; readonly artifact_key: string }
export const publishOperatorEdit = ({ run_id, unit_id, artifact_key, ...request }: OperatorArtifactEdit): Promise<OperatorIngressCommitted> =>
  put(`${unitPath(run_id, unit_id)}/artifacts/${encodeURIComponent(artifact_key)}`, request);

/** Each decision goes to the route its `submit` names. */
function deliverDecision(input: OperatorDecisionSubmission): Promise<OperatorIngressCommitted> {
  const { submit } = input;
  if (submit.kind === "review") {
    const request: OperatorDecideRequest = { request_id: input.request_id, decision: submit.decision, target: submit.target_revision_id, payload: input.payload };
    return post(`${unitPath(input.run_id, input.unit_id)}/reviews/${encodeURIComponent(submit.review)}/decide`, request);
  }
  const request: OperatorIngressRequest = { request_id: input.request_id };
  if (submit.kind === "retry") return post(`${unitPath(input.run_id, input.unit_id)}/workers/${encodeURIComponent(submit.worker)}/retry`, request);
  return post(`${runPath(input.run_id)}/cancel`, request);
}

const inFlightDecisions = new Map<string, Promise<OperatorIngressCommitted>>();
/** One delivery per request id in flight; a resubmission after it settles is answered by the authority's replay. */
export function submitOperatorDecision(input: OperatorDecisionSubmission): Promise<OperatorIngressCommitted> {
  const identity = JSON.stringify([input.run_id, input.request_id]);
  const active = inFlightDecisions.get(identity);
  if (active) return active;
  const delivery = deliverDecision(input);
  inFlightDecisions.set(identity, delivery);
  void delivery.finally(() => { if (inFlightDecisions.get(identity) === delivery) inFlightDecisions.delete(identity); }).catch(() => undefined);
  return delivery;
}
