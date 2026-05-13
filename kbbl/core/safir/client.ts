// Thin HTTP wrapper around safir's REST API. The methods exposed here are
// the strict subset kbbl actually calls — read paths the PWA proxies and
// the lifecycle write paths SessionManager invokes. Anything else stays
// out so an over-eager call site can't drift outside the contract the
// in-process integration tests in PR-B verify.
//
// Error model:
//   - 2xx → return parsed JSON, untyped (callers Zod-validate only on
//           reads that need it; trust safir on writes).
//   - 4xx/5xx → throw SafirHttpError with the status and parsed body.
//   - Network / abort → re-throw the native TypeError so safirCall can
//           discriminate transient failures from real bugs.

import type {
  CreatePermissionProfile,
  CreateRunPhase,
  CreateTaskRun,
  HandoffDocRecord,
  PermissionProfile,
  Plan,
  RunPhase,
  SubmitHandoff,
  Task,
  TaskRun,
  UpdatePermissionProfile,
  UpdateRunPhase,
  UpdateTaskRun,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Narrow signature for the fetch dependency. Equivalent to the call
 * signature of the global `fetch`, but without the static surface (e.g.
 * Bun adds `fetch.preconnect`) so test stubs can be plain functions
 * without satisfying the static methods.
 */
export type FetchFn = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export class SafirHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `safir HTTP ${status}`);
    this.name = "SafirHttpError";
  }
}

export interface CreateTaskBody {
  project_id: string;
  parent_id?: number | null;
  title: string;
  notes?: string | null;
  status?: string;
  priority?: number;
  deadline?: string | null;
  blocked_reason?: string | null;
}

export interface AgentResponseBody {
  status: "completed" | "failed";
  reply_message_id?: string;
  error?: string;
}

export interface SafirClient {
  createRun(taskId: number, body: CreateTaskRun): Promise<TaskRun>;
  updateRun(runId: string, body: UpdateTaskRun): Promise<TaskRun>;
  abandonRun(runId: string): Promise<TaskRun | null>;
  createPhase(runId: string, body: CreateRunPhase): Promise<RunPhase>;
  updatePhase(phaseId: string, body: UpdateRunPhase): Promise<RunPhase>;
  submitHandoff(
    phaseId: string,
    body: SubmitHandoff,
  ): Promise<HandoffDocRecord>;
  getTask(taskId: number): Promise<Task>;
  listTasks(): Promise<Task[]>;
  listHandoffsForTask(taskId: number): Promise<HandoffDocRecord[]>;
  getHandoff(handoffId: string): Promise<HandoffDocRecord>;
  listPermissionProfiles(): Promise<PermissionProfile[]>;
  getPermissionProfile(id: number): Promise<PermissionProfile>;
  createPermissionProfile(body: CreatePermissionProfile): Promise<PermissionProfile>;
  updatePermissionProfile(id: number, body: UpdatePermissionProfile): Promise<PermissionProfile>;
  setTaskDefaultPermissionProfile(taskId: number, profileId: number | null): Promise<Task>;
  createTask(body: CreateTaskBody): Promise<Task>;
  addDependency(taskId: number, dependsOn: number): Promise<void>;
  listPlansForTask(taskId: number): Promise<Plan[]>;
  getPlan(planId: string): Promise<Plan>;
  updatePlanStatus(planId: string, body: { status: string; rejection_reason?: string | null }): Promise<Plan>;
  reopenPlan(planId: string): Promise<Plan>;
  // --- review responder surface ---
  getThread(threadId: string): Promise<Record<string, unknown>>;
  getAtomMap(targetType: string, targetId: string): Promise<Record<string, string>>;
  listOpenThreads(targetType: string, targetId: string): Promise<Record<string, unknown>[]>;
  postAgentResponse(threadId: string, body: AgentResponseBody): Promise<unknown>;
  // --- cohort 2: plan review surface ---
  listAllThreads(targetType: string, targetId: string): Promise<Record<string, unknown>[]>;
  listAtomHistory(targetType: string, targetId: string): Promise<Record<string, unknown>[]>;
  postAtomEdit(targetType: string, targetId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  createThread(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  postThreadMessage(threadId: string, body: { body: string; author: string }): Promise<Record<string, unknown>>;
  pingThread(threadId: string): Promise<unknown>;
  updateThreadStatus(threadId: string, body: { status: string }): Promise<Record<string, unknown>>;
}

export interface CreateSafirClientOpts {
  /** Base URL with no trailing slash; e.g. "http://localhost:7145". */
  baseUrl: string;
  /** Bearer token. Read from process.env.SAFIR_API_TOKEN at the call site. */
  apiToken?: string;
  /** Test seam: inject a fetch shim. Defaults to global fetch. */
  fetch?: FetchFn;
  /** Per-request timeout. Defaults to 5000ms. */
  timeoutMs?: number;
}

export function createSafirClient(opts: CreateSafirClientOpts): SafirClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  // Cast: the global `fetch` is structurally compatible with FetchFn
  // (FetchFn is its call signature minus the static methods). The cast
  // is just to satisfy TS that the Bun-specific static surface isn't
  // required at the call site.
  const fetchFn: FetchFn = opts.fetch ?? (fetch as unknown as FetchFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.apiToken) headers["authorization"] = `Bearer ${opts.apiToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsedBody: unknown = text;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. an upstream proxy error page). Leave as raw
        // text so the caller can still surface something useful.
      }
    } else {
      parsedBody = null;
    }

    if (res.status >= 200 && res.status < 300) {
      return parsedBody as T;
    }
    throw new SafirHttpError(res.status, parsedBody);
  }

  return {
    createRun: (taskId, body) =>
      request<TaskRun>("POST", `/tasks/${taskId}/runs`, body),
    updateRun: (runId, body) =>
      request<TaskRun>("PATCH", `/runs/${runId}`, body),
    abandonRun: (runId) =>
      request<TaskRun | null>("POST", `/runs/${runId}/abandon`),
    createPhase: (runId, body) =>
      request<RunPhase>("POST", `/runs/${runId}/phases`, body),
    updatePhase: (phaseId, body) =>
      request<RunPhase>("PATCH", `/phases/${phaseId}`, body),
    submitHandoff: (phaseId, body) =>
      request<HandoffDocRecord>("POST", `/phases/${phaseId}/handoff`, body),
    getTask: (taskId) => request<Task>("GET", `/tasks/${taskId}`),
    listTasks: () => request<Task[]>("GET", "/tasks"),
    listHandoffsForTask: (taskId) =>
      request<HandoffDocRecord[]>("GET", `/tasks/${taskId}/handoffs`),
    getHandoff: (handoffId) =>
      request<HandoffDocRecord>("GET", `/handoffs/${handoffId}`),
    listPermissionProfiles: () =>
      request<PermissionProfile[]>("GET", "/permission-profiles"),
    getPermissionProfile: (id) =>
      request<PermissionProfile>("GET", `/permission-profiles/${id}`),
    createPermissionProfile: (body) =>
      request<PermissionProfile>("POST", "/permission-profiles", body),
    updatePermissionProfile: (id, body) =>
      request<PermissionProfile>("PATCH", `/permission-profiles/${id}`, body),
    setTaskDefaultPermissionProfile: (taskId, profileId) =>
      request<Task>("POST", `/tasks/${taskId}/permission-profile`, { profile_id: profileId }),
    createTask: (body) =>
      request<Task>("POST", "/tasks", body),
    addDependency: async (taskId, dependsOn) => {
      await request<unknown>(
        "POST",
        `/tasks/${taskId}/dependencies`,
        { depends_on: dependsOn },
      );
    },
    listPlansForTask: (taskId) =>
      request<Plan[]>("GET", `/tasks/${taskId}/plans`),
    getPlan: (planId) =>
      request<Plan>("GET", `/plans/${planId}`),
    updatePlanStatus: (planId, body) =>
      request<Plan>("PATCH", `/plans/${planId}/status`, body),
    reopenPlan: (planId) =>
      request<Plan>("POST", `/plans/${planId}/reopen`),
    getThread: (threadId) =>
      request<Record<string, unknown>>("GET", `/threads/${threadId}`),
    getAtomMap: (targetType, targetId) =>
      request<Record<string, string>>("GET", `/atoms/${targetType}/${targetId}`),
    listOpenThreads: (targetType, targetId) =>
      request<Record<string, unknown>[]>(
        "GET",
        `/artifacts/${targetType}/${targetId}/threads?status=open`,
      ),
    postAgentResponse: (threadId, body) =>
      request<unknown>("POST", `/threads/${threadId}/agent-response`, body),
    listAllThreads: (targetType, targetId) =>
      request<Record<string, unknown>[]>("GET", `/artifacts/${targetType}/${targetId}/threads`),
    listAtomHistory: (targetType, targetId) =>
      request<Record<string, unknown>[]>("GET", `/atoms/${targetType}/${targetId}/history`),
    postAtomEdit: (targetType, targetId, body) =>
      request<Record<string, unknown>>("POST", `/atoms/${targetType}/${targetId}/edits`, body),
    createThread: (body) =>
      request<Record<string, unknown>>("POST", "/threads", body),
    postThreadMessage: (threadId, body) =>
      request<Record<string, unknown>>("POST", `/threads/${threadId}/messages`, body),
    pingThread: (threadId) =>
      request<unknown>("POST", `/threads/${threadId}/ping`),
    updateThreadStatus: (threadId, body) =>
      request<Record<string, unknown>>("PATCH", `/threads/${threadId}/status`, body),
  };
}
