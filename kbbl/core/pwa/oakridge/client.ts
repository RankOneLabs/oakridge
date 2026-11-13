import type { ExecutedPromptRead } from "./lib/prompt-view";
import type { ExecutedPromptTurn } from "../../executed-prompt";
// API client for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type { CohortPullRequestResponse, ConfirmCohortMergedRequest, ArtifactDetail, ArtifactTypeDescriptor, ReviewInbox } from "./artifact-types";
import type { OakridgeConfig, WorkflowDefSummary } from "./project-types";
import type { CreateRunRequest, RunSummary, RunDetail, ConfirmFinalPullRequestRequest, EpicWorkflowProfile, FinalPullRequestResponse, RepositoryKey, EpicProfileId, WorkflowRunId, RunSessionAttempt, SessionRunLocation } from "./run-types";
import type { OperatorIngressResponse } from "./operator-contracts/http/ingress";
import type { OperatorDefinitionDetail, OperatorDefinitionPage, OperatorDefinitionSummary } from "./operator-contracts/projections/definition-view";
import type { OperatorRunInboxBatch } from "./operator-contracts/projections/inbox";
import type { OperatorRunPage, OperatorRunView } from "./operator-contracts/projections/run-view";
import type { OperatorUnitView } from "./operator-contracts/projections/unit-view";
import { artifactKeyFromComposite, artifactTypes, attemptToWorkOrder, compositeId, latestUnitAttemptPerSession, parseCompositeId, revisionToArtifact, runSnapshot, runSummary, SCALAR_STAGE_UNIT_ID, unwrap as unwrapAdapter, type CompositeId } from "./adapters/core";
import { createCollabClient } from "./client-collab";
import { createGateClient } from "./client-gates";
import { committed, oakridgeGet, oakridgePost, OPERATOR, runPath, unitPath } from "./client-http";
import { classifyDevelopmentInbox, replaceDevelopmentInboxRun } from "./adapters/inbox";
import { developmentLaunch } from "./adapters/launch";
import { parseArtifactDetail, parseRunInboxBatch, parseRunView, parseUnitViews } from "./adapters/parse";

interface CachedUnits {
  readonly promise: Promise<readonly OperatorUnitView[]>;
  expiresAt: number;
  isLoading: boolean;
}
/** Run surfaces poll every ten seconds; a settled read must expire before their next poll. */
const UNIT_CACHE_FRESH_MS = 5_000;
const unitCache = new Map<string, CachedUnits>();
/** Every unit input field the adapters read; the rest repeats upstream artifacts in each unit. */
const UNIT_INPUT_FIELDS = ["brief", "cohort", "repositories", "repository", "repository_key", "title", "workspace"];
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
  const path = `${runPath(runId)}/units?input_fields=${UNIT_INPUT_FIELDS.join(",")}`;
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

async function readDefinitions(): Promise<OperatorDefinitionSummary[]> {
  const items: OperatorDefinitionSummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100" });
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

async function decide(runId: string, unitId: string, review: string, decision: string, target: string, payload: unknown, requestId: string): Promise<string> {
  const path = `${unitPath(runId, unitId)}/reviews/${encodeURIComponent(review)}/decide`;
  return committed(await oakridgePost<OperatorIngressResponse>(path, { request_id: requestId, decision, target, payload }), path);
}

export { parseOakridgeRunEventFrame } from "./adapters/event";

export { selectFailureDetail } from "./adapters/boundary";

const gateClient = createGateClient({ readRunPage, readUnits, unitPath, get: oakridgeGet, decide, invalidateCachedRunUnits });
export const { fetchRunGates, fetchRunSentFeedback, fetchGates, resumeGate, fetchMergeStatus } = gateClient;

const collabClient = createCollabClient({ resolveArtifactId, invalidateCachedRunUnits });
export const { fetchThreads, postThread, postMessage, pingThread, resolveThread, postAtomEdit, putArtifactRevisionBody, fetchReviewItems, postReviewItem, patchReviewItem } = collabClient;

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

export async function fetchWorkflowDefs(): Promise<WorkflowDefSummary[]> {
  return (await readDefinitions()).map(definitionSummary);
}
const definitionSummary = (definition: OperatorDefinitionSummary): WorkflowDefSummary => ({ id: definition.definition_id, name: definition.bundle.key });
export function fetchWorkflowDef(id: string): Promise<OperatorDefinitionDetail> {
  return fetchOperatorDefinition(id);
}

export function fetchOperatorDefinition(id: string): Promise<OperatorDefinitionDetail> {
  return oakridgeGet<OperatorDefinitionDetail>(`${OPERATOR}/definitions/${encodeURIComponent(id)}`);
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

/** The local kbbl read has already redacted all publication credentials. */
export async function readExecutedPrompt(session_id: string): Promise<ExecutedPromptRead> {
  const response = await fetch(`/oakridge/sessions/${encodeURIComponent(session_id)}/executed-prompt`);
  if (response.status === 404) {
    const body = await response.json() as { readonly error?: { readonly code?: string } };
    if (body.error?.code === "not_retained") return { state: "not_retained" };
  }
  if (!response.ok) throw new Error(`Executed prompt read failed (${response.status})`);
  return { state: "retained", turns: await response.json() as ExecutedPromptTurn[] };
}
