// API client for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  CohortPullRequestResponse,
  ConfirmCohortMergedRequest,
  OakridgeConfig,
  Project,
  ProjectId,
  ProjectUpdateCommand,
  ProjectUpdateError,
  ProjectWriteInput,
  WorkflowDefSummary,
  WorkflowDefFull,
  WorkflowDefInput,
  CreateRunRequest,
  RunSummary,
  RunDetail,
  ArtifactDetail,
  ArtifactTypeDescriptor,
  CollabThread,
  ReviewItem,
  PostThreadRequest,
  PostMessageRequest,
  PostAtomEditRequest,
  PostReviewItemRequest,
  PatchReviewItemRequest,
  ReviewInbox,
  ConfirmFinalPullRequestRequest,
  EpicWorkflowProfile,
  FinalPullRequestResponse,
  RepositoryKey,
  EpicProfileId,
  WorkflowRunId,
  RunSessionAttempt,
  SessionRunLocation,
} from "./types";
import type { Result } from "../lib/result";
import type { OperatorArtifactDetail, OperatorCollaborationMessageRow, OperatorCollaborationThreadRow, OperatorCollaborationThreadView, OperatorDefinitionDetail, OperatorDefinitionPage, OperatorDefinitionSummary, OperatorIngressResponse, OperatorProjectList, OperatorProjectView, OperatorReviewItemRow, OperatorRunInboxBatch, OperatorRunPage, OperatorRunView, OperatorUnitView } from "./operator-contracts";
import { artifactKeyFromComposite, artifactTypes, attemptToWorkOrder, compositeId, latestUnitAttemptPerSession, parseCompositeId, replaceJsonPointer, revisionToArtifact, runSnapshot, runSummary, SCALAR_STAGE_UNIT_ID, unwrap as unwrapAdapter, type CompositeId } from "./adapters/core";
import { createGateClient } from "./client-gates";
import { classifyDevelopmentInbox, replaceDevelopmentInboxRun } from "./adapters/inbox";
import { developmentLaunch } from "./adapters/launch";
import { parseProject, projectUpdateError, selectFailureDetail } from "./adapters/boundary";
import { parseArtifactDetail, parseRunInboxBatch, parseRunView, parseUnitViews } from "./adapters/parse";

const API = "/oakridge/api";
const OPERATOR = "/api";
interface CachedUnits {
  readonly promise: Promise<readonly OperatorUnitView[]>;
  expiresAt: number;
  isLoading: boolean;
}
/** Run surfaces poll every ten seconds; a settled read must expire before their next poll. */
const UNIT_CACHE_FRESH_MS = 5_000;
const unitCache = new Map<string, CachedUnits>();
const runPath = (runId: string): string => `${OPERATOR}/runs/${encodeURIComponent(runId)}`;
const unitPath = (runId: string, unitId: string): string => `${runPath(runId)}/units/${encodeURIComponent(unitId)}`;
async function resolveArtifactId(id: string): Promise<CompositeId> {
  const parsed = parseCompositeId(id, "artifact");
  if (parsed.ok) return parsed.value;
  const matches: CompositeId[] = [];
  for (const run of await readRunPage()) for (const unit of await readUnits(run.run_id)) {
    for (const artifact of unit.artifacts) if (artifact.latest_revision?.id === id) {
      matches.push({ kind: "artifact", runId: run.run_id, unitId: unit.unit_id, name: `${artifact.artifact_key}:${id}` });
    }
  }
  if (matches.length !== 1) throw new Error(`oakridge ${id}: opaque artifact revision ${matches.length === 0 ? "not found" : "is ambiguous"}`);
  return matches[0];
}
const readUnits = (runId: string): Promise<readonly OperatorUnitView[]> => {
  const cached = unitCache.get(runId);
  if (cached && (cached.isLoading || cached.expiresAt > Date.now())) return cached.promise;
  const path = `${runPath(runId)}/units`;
  const entry: CachedUnits = {
    expiresAt: 0,
    isLoading: true,
    promise: oakridgeGet<unknown>(path).then((value) => {
      const units = unwrapAdapter(path, parseUnitViews(value));
      entry.isLoading = false;
      entry.expiresAt = Date.now() + UNIT_CACHE_FRESH_MS;
      return units;
    }).catch((error) => {
      if (unitCache.get(runId) === entry) unitCache.delete(runId);
      throw error;
    }),
  };
  unitCache.set(runId, entry);
  return entry.promise;
};
export const invalidateCachedRunUnits = (runId: string | null): void => {
  if (runId) unitCache.delete(runId);
  else unitCache.clear();
};

async function readRunPage(isArchived = false): Promise<OperatorRunView[]> {
  const items: OperatorRunView[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100", archived: String(isArchived) });
    if (cursor) query.set("cursor", cursor);
    const path = `${OPERATOR}/runs?${query}`;
    const page: OperatorRunPage = await oakridgeGet(path);
    if (!Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === "string"))
      throw new Error(`oakridge ${path}: invalid run page`);
    items.push(...page.items.map((run) => unwrapAdapter(path, parseRunView(run))));
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

async function readDefinitions(isArchived: boolean): Promise<OperatorDefinitionSummary[]> {
  const items: OperatorDefinitionSummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ archived: String(isArchived), limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await oakridgeGet<OperatorDefinitionPage>(`${OPERATOR}/definitions?${query}`);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

async function readRunInboxBatch(runIds: readonly string[]): Promise<OperatorRunInboxBatch["items"]> {
  const entries: OperatorRunInboxBatch["items"][number][] = [];
  for (let offset = 0; offset < runIds.length; offset += 100) {
    const ids = runIds.slice(offset, offset + 100);
    const path = `${OPERATOR}/run-inboxes?ids=${ids.map(encodeURIComponent).join(",")}`;
    const batch = unwrapAdapter(path, parseRunInboxBatch(await oakridgeGet<unknown>(path)));
    entries.push(...batch.items);
  }
  return entries;
}

function committed(response: OperatorIngressResponse, path: string): string {
  if (response.kind === "committed") return response.run_id;
  throw new Error(`oakridge ${path}: unexpected ingress response`);
}

async function decide(runId: string, unitId: string, review: string, decision: string, target: string, payload: unknown, requestId: string): Promise<string> {
  const path = `${unitPath(runId, unitId)}/reviews/${encodeURIComponent(review)}/decide`;
  return committed(await oakridgePost<OperatorIngressResponse>(path, { request_id: requestId, decision, target, payload }), path);
}

export { parseOakridgeRunEventFrame } from "./adapters/event";

export { selectFailureDetail } from "./adapters/boundary";

async function oakridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(body, `oakridge ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

interface OakridgePostOptions { readonly idempotency_key?: string }

async function oakridgePost<T>(path: string, body: unknown, options: OakridgePostOptions = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.idempotency_key ? { "Idempotency-Key": options.idempotency_key } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge POST ${path}: ${res.status}`);
    throw new Error(detail);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

async function oakridgePutBody<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Oakridge-Publisher": "operator" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge PUT ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const gateClient = createGateClient({ readRunPage, readUnits, unitPath, get: oakridgeGet, decide, invalidateCachedRunUnits });
export const { fetchRunGates, fetchRunSentFeedback, fetchGates, resumeGate, fetchMergeStatus } = gateClient;

export async function fetchOakridgeConfig(): Promise<OakridgeConfig> {
  const res = await fetch("/oakridge/config");
  if (!res.ok) return { available: false };
  return (await res.json()) as OakridgeConfig;
}

export async function fetchRuns(filter?: string): Promise<RunSummary[]> {
  const runs = await readRunPage(filter === "archived");
  return Promise.all(runs.map(async (run) => runSummary(unwrapAdapter(runPath(run.run_id), runSnapshot(run, await readUnits(run.run_id))), run)));
}

export async function fetchRun(id: string): Promise<RunDetail> {
  const path = runPath(id);
  const [run, units] = await Promise.all([oakridgeGet<unknown>(path).then((value) => unwrapAdapter(path, parseRunView(value))), readUnits(id)]);
  return unwrapAdapter(path, runSnapshot(run, units));
}

export function fetchRunSessions(runId: string): Promise<RunSessionAttempt[]> {
  return readUnits(runId).then((units) => unwrapAdapter(runPath(runId), latestUnitAttemptPerSession(units))
    .map(({ unit, attempt }) => unwrapAdapter(unitPath(runId, unit.unit_id), attemptToWorkOrder({ runId, stage: unit.stage ?? "$root", unit, attempt }))));
}

export async function fetchSessionRun(sessionId: string): Promise<SessionRunLocation | null> {
  const runs = await readRunPage();
  for (const run of runs) {
    const units = await readUnits(run.run_id);
    for (const unit of units) {
      const attempt = unit.attempts.find((candidate) => candidate.kbbl_session_id === sessionId);
      if (attempt) return { run_id: run.run_id as WorkflowRunId,
        stage_instance_id: compositeId({ kind: "stage", runId: run.run_id, unitId: unit.unit_id, name: unit.stage ?? "$root" }),
        stage_key: unit.stage ?? "$root", unit_id: unit.collection_key ?? unit.unit_key, work_order_id: attempt.id };
    }
  }
  return null;
}

export async function fetchReviewInbox(): Promise<ReviewInbox> {
  const runs = await readRunPage();
  if (runs.length === 0) return { cohorts: [], items: [] };
  const entries = await readRunInboxBatch(runs.map((run) => run.run_id));
  const titles = new Map(runs.map((run) => [run.run_id, run.title]));
  const slices = await Promise.all(entries.map(async (entry) => unwrapAdapter(`${runPath(entry.run_id)}/inbox`, classifyDevelopmentInbox(entry, await readUnits(entry.run_id), titles.get(entry.run_id) ?? null))));
  return { cohorts: slices.flatMap((slice) => slice.cohorts), items: slices.flatMap((slice) => slice.items) };
}

export async function refreshReviewInboxRun(runId: string, current: ReviewInbox): Promise<ReviewInbox> {
  const path = `${runPath(runId)}/inbox`;
  const page = await oakridgeGet<{ readonly items: OperatorRunInboxBatch["items"][number]["items"] }>(path);
  const runTitle = [...current.items, ...current.cohorts].find((work) => work.run_id === runId)?.run_title ?? null;
  const slice = unwrapAdapter(path, classifyDevelopmentInbox({ run_id: runId, items: page.items }, await readUnits(runId), runTitle));
  return replaceDevelopmentInboxRun(current, runId, slice);
}

export async function fetchArtifact(id: string): Promise<ArtifactDetail> {
  const parsed = await resolveArtifactId(id);
  const path = `${unitPath(parsed.runId, parsed.unitId)}/artifacts/${encodeURIComponent(artifactKeyFromComposite(parsed.name))}`;
  const [rawArtifact, units] = await Promise.all([oakridgeGet<unknown>(path), readUnits(parsed.runId)]);
  const unit = units.find((candidate) => candidate.unit_id === parsed.unitId);
  if (!unit) throw new Error(`oakridge ${path}: artifact unit not found`);
  return unwrapAdapter(path, revisionToArtifact(unwrapAdapter(path, parseArtifactDetail(rawArtifact)), unit));
}

export async function confirmCohortMerged(cohortId: string, req: ConfirmCohortMergedRequest): Promise<CohortPullRequestResponse> {
  const separator = cohortId.lastIndexOf(":");
  const stage = unwrapAdapter(cohortId, parseCompositeId(cohortId.slice(0, separator), "stage"));
  const unit = (await readUnits(stage.runId)).find((candidate) => candidate.collection_key === cohortId.slice(separator + 1) || candidate.unit_key === cohortId.slice(separator + 1));
  if (!unit) throw new Error(`oakridge ${cohortId}: unit unavailable`);
  const decision = unit.decisions.find((candidate) => candidate.submit.kind === "review" && candidate.submit.decision === "confirm_merged");
  if (!decision || decision.submit.kind !== "review") throw new Error(`oakridge ${cohortId}: confirm_merged unavailable`);
  await decide(stage.runId, unit.unit_id, decision.submit.review, decision.submit.decision, decision.submit.target_revision_id, {}, req.idempotency_key);
  invalidateCachedRunUnits(stage.runId);
  return { cohort_id: cohortId, outcome: { kind: "completed" } };
}

export function fetchProjects(): Promise<Project[]> {
  return oakridgeGet<OperatorProjectList>(`${OPERATOR}/projects`).then((list) => list.items.map(projectFromV2));
}

export function createProject(body: ProjectWriteInput): Promise<Project> {
  return oakridgePost<OperatorProjectView>(`${OPERATOR}/projects`, body).then(projectFromV2);
}

const projectFromV2 = (project: OperatorProjectView): Project => ({ id: project.id as ProjectId, name: project.name,
  repo_dir: project.repo_dir, created_at: project.created_at, forge_repository: project.forge_repository,
  base_branch: project.integration_branch });

export async function updateProject(command: ProjectUpdateCommand): Promise<Result<Project, ProjectUpdateError>> {
  const path = `${OPERATOR}/projects/${encodeURIComponent(command.id)}`;
  try {
    const response = await fetch(`${API}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.project),
    });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null) as unknown;
      return projectUpdateError(path, selectFailureDetail(responseBody, `oakridge PUT ${path}: ${response.status}`));
    }
    const parsed = parseProject(await response.json());
    return parsed.ok ? parsed : projectUpdateError(path, `${parsed.error.operation}: ${parsed.error.detail}`);
  } catch (error) {
    return projectUpdateError(path, error instanceof Error ? error.message : "request failed");
  }
}

export async function fetchWorkflowDefs(includeArchived = false): Promise<WorkflowDefSummary[]> {
  const definitions = includeArchived ? (await Promise.all([readDefinitions(false), readDefinitions(true)])).flat() : await readDefinitions(false);
  return definitions.map(definitionSummary);
}

const definitionSummary = (definition: OperatorDefinitionSummary): WorkflowDefSummary => ({ id: definition.bundle_id,
  name: definition.bundle.key, version: 1, archived: definition.archived_at !== null });

export function archiveWorkflowDef(defId: string): Promise<unknown> {
  return oakridgePost<unknown>(`${OPERATOR}/definitions/${encodeURIComponent(defId)}/archive`, {});
}

export function unarchiveWorkflowDef(defId: string): Promise<unknown> {
  return oakridgePost<unknown>(`${OPERATOR}/definitions/${encodeURIComponent(defId)}/unarchive`, {});
}

export function fetchWorkflowDef(id: string): Promise<WorkflowDefFull> {
  return oakridgeGet<OperatorDefinitionDetail>(`${OPERATOR}/definitions/${encodeURIComponent(id)}`).then((definition) => ({
    ...definitionSummary(definition), graph: { stages: {}, edges: [] }, created_at: "",
  }));
}

export function fetchOperatorDefinition(id: string): Promise<OperatorDefinitionDetail> {
  return oakridgeGet<OperatorDefinitionDetail>(`${OPERATOR}/definitions/${encodeURIComponent(id)}`);
}

export function createWorkflowDef(body: WorkflowDefInput): Promise<WorkflowDefFull> {
  return Promise.reject(new Error(`v1 workflow graph ${body.name} cannot compile as a v2 definition`));
}

export async function createRun(body: CreateRunRequest, idempotencyKey: string): Promise<RunSummary> {
  const definition = await fetchOperatorDefinition(body.workflow_def_id);
  const path = `${OPERATOR}/runs`;
  const launch = unwrapAdapter(path, developmentLaunch(body, definition, idempotencyKey));
  const runId = committed(await oakridgePost<OperatorIngressResponse>(path, launch), path);
  const run = unwrapAdapter(runPath(runId), parseRunView(await oakridgeGet<unknown>(runPath(runId))));
  return runSummary(unwrapAdapter(runPath(runId), runSnapshot(run, await readUnits(runId))), run);
}

export async function cancelRun(runId: string): Promise<unknown> {
  const path = `${runPath(runId)}/cancel`;
  const response = await oakridgePost<OperatorIngressResponse>(path, { request_id: crypto.randomUUID() });
  committed(response, path);
  invalidateCachedRunUnits(runId);
  return response;
}

export function archiveRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`${runPath(runId)}/archive`, {});
}

export function unarchiveRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`${runPath(runId)}/unarchive`, {});
}

export function deleteRun(runId: string): Promise<void> {
  return Promise.reject(new Error(`oakridge ${runPath(runId)}: run deletion is not wired; use Cancel or Archive`));
}

export async function retryRunUnit(stageInstanceId: string, unitId: string): Promise<unknown> {
  const stage = unwrapAdapter(stageInstanceId, parseCompositeId(stageInstanceId, "stage"));
  // A collection key repeats across stages (a brief and its cohort share one), so match within the stage.
  const unit = (await readUnits(stage.runId)).find((candidate) => candidate.stage === stage.name
    && (candidate.collection_key ?? SCALAR_STAGE_UNIT_ID) === unitId);
  if (!unit) throw new Error(`oakridge ${stageInstanceId}: unit ${unitId} unavailable`);
  const retry = unit.decisions.find((decision) => decision.submit.kind === "retry");
  if (!retry || retry.submit.kind !== "retry") throw new Error(`oakridge ${stageInstanceId}: retry unavailable`);
  const path = `${unitPath(stage.runId, unit.unit_id)}/workers/${encodeURIComponent(retry.submit.worker)}/retry`;
  const result = await oakridgePost<OperatorIngressResponse>(path, { request_id: crypto.randomUUID() });
  invalidateCachedRunUnits(stage.runId);
  return committed(result, path);
}

export function confirmFinalPullRequest(
  runId: string,
  repositoryKey: RepositoryKey,
  request: ConfirmFinalPullRequestRequest,
): Promise<FinalPullRequestResponse> {
  return readUnits(runId).then(async (units) => {
    const unit = units.find((candidate) => candidate.stage === "integration" && candidate.collection_key === repositoryKey);
    const decision = unit?.decisions.find((candidate) => candidate.submit.kind === "review" && candidate.submit.decision === "confirm_merged");
    if (!unit || !decision || decision.submit.kind !== "review") throw new Error(`oakridge ${runPath(runId)}: integration confirm_merged unavailable`);
    await decide(runId, unit.unit_id, decision.submit.review, decision.submit.decision, decision.submit.target_revision_id, {}, request.idempotency_key);
    invalidateCachedRunUnits(runId);
    const profile: EpicWorkflowProfile = { id: runId as EpicProfileId, workflow_run_id: runId as WorkflowRunId,
      title: "development", slug: "development", lifecycle_state: "final_integration", final_merge_policy: "external_confirmation",
      base_branch: "", repositories: [], created_at: "", updated_at: "" };
    return { outcome: "waiting", profile };
  });
}

export function fetchArtifactTypes(): Promise<ArtifactTypeDescriptor[]> {
  return Promise.resolve(artifactTypes());
}

// ── Collaboration through v2 revision and thread routes ─────────────────────

interface RevisionLocation { readonly runId: string; readonly unitId: string; readonly artifactKey: string; readonly revisionId: string; readonly detail: OperatorArtifactDetail }
const threadLocation = new Map<string, { readonly runId: string; readonly unitId: string }>();
async function revisionLocation(artifactId: string): Promise<RevisionLocation> {
  const parsed = await resolveArtifactId(artifactId);
  const artifactKey = artifactKeyFromComposite(parsed.name);
  const path = `${unitPath(parsed.runId, parsed.unitId)}/artifacts/${encodeURIComponent(artifactKey)}`;
  const detail = unwrapAdapter(path, parseArtifactDetail(await oakridgeGet<unknown>(path)));
  const revisionId = parsed.name.includes(":") ? parsed.name.slice(artifactKey.length + 1) : detail.revisions.at(-1)?.id;
  if (!revisionId || !detail.revisions.some((revision) => revision.id === revisionId)) throw new Error(`oakridge ${path}: revision unavailable`);
  return { runId: parsed.runId, unitId: parsed.unitId, artifactKey, revisionId, detail };
}
const threadsPath = (location: RevisionLocation): string =>
  `${unitPath(location.runId, location.unitId)}/revisions/${encodeURIComponent(location.revisionId)}/threads`;
const threadView = (thread: OperatorCollaborationThreadView, artifactId: string): CollabThread => {
  threadLocation.set(thread.id, { runId: thread.run_id, unitId: thread.unit_id });
  return { id: thread.id, artifact_id: artifactId, revision_id: thread.artifact_revision_id,
    anchor: thread.context.anchor, status: "open", created_at: thread.created_at,
    messages: thread.messages.map((message) => ({ id: message.id, thread_id: message.thread_id,
      body: message.body.text, author: message.body.author, created_at: message.created_at })) };
};

export async function fetchThreads(artifactId: string): Promise<CollabThread[]> {
  const location = await revisionLocation(artifactId);
  const threads = await oakridgeGet<OperatorCollaborationThreadView[]>(threadsPath(location));
  return threads.map((thread) => threadView(thread, artifactId));
}

export async function postThread(artifactId: string, req: PostThreadRequest): Promise<{ thread_id: string; message_id: string }> {
  const location = await revisionLocation(artifactId);
  const thread = await oakridgePost<OperatorCollaborationThreadRow>(threadsPath(location),
    { request_key: crypto.randomUUID(), title: req.body || "Discussion", anchor: req.anchor ?? null });
  threadLocation.set(thread.id, { runId: location.runId, unitId: location.unitId });
  const message = await postMessage(thread.id, { body: req.body, author: req.author });
  return { thread_id: thread.id, message_id: message.message_id };
}

export async function postMessage(threadId: string, req: PostMessageRequest): Promise<{ message_id: string }> {
  const location = threadLocation.get(threadId);
  if (!location) throw new Error(`oakridge thread ${threadId}: load its artifact before posting`);
  const path = `${unitPath(location.runId, location.unitId)}/threads/${encodeURIComponent(threadId)}/messages`;
  const response = await oakridgePost<{ readonly message: OperatorCollaborationMessageRow }>(path,
    { request_key: crypto.randomUUID(), text: req.body });
  return { message_id: response.message.id };
}

export function pingThread(threadId: string, _idempotencyKey: string): Promise<{ ok: boolean }> {
  return Promise.reject(new Error(`oakridge thread ${threadId}: v2 has no ping operation`));
}

export function resolveThread(threadId: string): Promise<{ thread_id: string; status: string }> {
  return Promise.reject(new Error(`oakridge thread ${threadId}: v2 has no resolution operation`));
}

export async function postAtomEdit(revisionId: string, req: PostAtomEditRequest): Promise<{ artifact_id: string }> {
  const location = await revisionLocation(revisionId);
  const revision = location.detail.revisions.find((candidate) => candidate.id === location.revisionId);
  if (!revision) throw new Error(`oakridge ${revisionId}: revision unavailable`);
  const body = unwrapAdapter(revisionId, replaceJsonPointer(revision.body, req.anchor, req.prev_value, req.new_value));
  return publishArtifactRevision(location, body);
}

/** Publish a whole successor body for edits an anchor replacement cannot express. */
export async function putArtifactRevisionBody(revisionId: string, body: unknown): Promise<{ artifact_id: string }> {
  return publishArtifactRevision(await revisionLocation(revisionId), body);
}

async function publishArtifactRevision(location: RevisionLocation, body: unknown): Promise<{ artifact_id: string }> {
  const revision = location.detail.revisions.find((candidate) => candidate.id === location.revisionId);
  if (!revision) throw new Error(`oakridge ${location.revisionId}: revision unavailable`);
  const path = `${unitPath(location.runId, location.unitId)}/artifacts/${encodeURIComponent(location.artifactKey)}`;
  committed(await oakridgePutBody<OperatorIngressResponse>(path, { request_id: crypto.randomUUID(), body,
    predecessor: location.revisionId, subject: revision.subject_id }), path);
  invalidateCachedRunUnits(location.runId);
  return { artifact_id: location.revisionId };
}

const reviewItemView = (item: OperatorReviewItemRow, artifactId: string, anchor: string): ReviewItem => ({
  id: item.id, artifact_id: artifactId, revision_id: item.artifact_revision_id, anchor,
  claim: item.body.title, reality: item.body.detail,
  status: item.body.status === "resolved" || item.body.status === "waived" ? item.body.status : "open",
  resolution: null, created_at: item.created_at,
});
export async function fetchReviewItems(artifactId: string): Promise<ReviewItem[]> {
  const location = await revisionLocation(artifactId);
  const threads = await oakridgeGet<OperatorCollaborationThreadView[]>(threadsPath(location));
  return threads.flatMap((thread) => thread.review_items.map((item) => reviewItemView(item, artifactId, thread.context.anchor ?? "")));
}

export async function postReviewItem(artifactId: string, req: PostReviewItemRequest): Promise<ReviewItem> {
  const location = await revisionLocation(artifactId);
  const thread = await oakridgePost<OperatorCollaborationThreadRow>(threadsPath(location),
    { request_key: crypto.randomUUID(), title: req.claim, anchor: req.anchor });
  const path = `${unitPath(location.runId, location.unitId)}/threads/${encodeURIComponent(thread.id)}/review-items`;
  const item = await oakridgePost<OperatorReviewItemRow>(path,
    { request_key: crypto.randomUUID(), title: req.claim, detail: req.reality, status: "open" });
  return reviewItemView(item, artifactId, req.anchor);
}

export function patchReviewItem(reviewItemId: string, _req: PatchReviewItemRequest): Promise<ReviewItem> {
  return Promise.reject(new Error(`oakridge review item ${reviewItemId}: v2 has no update operation`));
}
