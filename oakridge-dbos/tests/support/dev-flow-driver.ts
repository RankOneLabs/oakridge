/**
 * Everyone but the agent, talking to Oakridge the way they really do.
 *
 * The agent emits artifacts through the executor callback route. The operator
 * approves gates through the gate resume route, and confirms a merge through
 * the cohort pull request route — the same one the GitHub poller posts its
 * observations to. Nothing here reaches around the HTTP surface into a
 * workflow, because a message a test can post but production cannot is exactly
 * how a deadlock ships green.
 */
import type { OperatorParkedGate, OperatorRunDetail, OperatorRunSummary, OperatorReviewInbox } from "../../src/domain/operator-projections";
import type { ArtifactId, JsonValue, UnitId, WorkflowDefinitionId } from "../../src/domain/primitives";
import type { ExecutionRequest } from "../../src/domain/execution";
import { artifactBody, awaitCondition, cohortHeadBranch, cohortPullRequestUrl, runContext } from "./dev-flow-harness";

const EXECUTOR_TYPE = "delegated_session";

const readJson = async <Value>(response: Response, describe: string): Promise<Value> => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${describe} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Value;
};

export interface LaunchedRun {
  readonly run_id: OperatorRunSummary["id"];
  readonly root_workflow_id: string;
}

/** Launches a run the way the operator surface does, and waits for it to start. */
export const launchRun = async (baseUrl: string, definitionId: WorkflowDefinitionId): Promise<LaunchedRun> => {
  const response = await fetch(`${baseUrl}/workflow_runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_def_id: definitionId, context: runContext(baseUrl) }),
  });
  const summary = await readJson<OperatorRunSummary>(response, "run launch");
  return { run_id: summary.id, root_workflow_id: summary.current_attempt_root_workflow_id };
};

/** What one emitted artifact became, as the emit route reports it. */
export interface EmittedArtifact {
  readonly artifact_id: ArtifactId;
  readonly output_name: string;
  readonly unit_id: string;
  /** The release policy that took the artifact, straight from the route. */
  readonly release: "released" | "waiting_gate" | "waiting_handoff";
}

interface EmitResponse { readonly artifact_id: ArtifactId; readonly release: EmittedArtifact["release"] }

/** Which of a unit's outputs an emission covers, and which round it is. */
export interface EmissionOptions {
  /** A later round carries the same identity and different content. */
  readonly revision?: number;
  /**
   * Restricts the emission to these outputs. A revising agent re-emits only
   * what changed: an already-released output is final, and the run refuses to
   * revise one — which is right, and means "emit everything again" is not what
   * a revision looks like.
   */
  readonly outputs?: readonly string[];
}

/**
 * The agent's side of one execution: emit the artifacts the unit owes, through
 * the same route a real coding agent calls.
 */
export const emitDeclaredArtifacts = async (baseUrl: string, request: ExecutionRequest, options: EmissionOptions = {}): Promise<readonly EmittedArtifact[]> => {
  const revision = options.revision ?? 1;
  const emitted: EmittedArtifact[] = [];
  for (const expected of request.expected_artifacts) {
    if (options.outputs && !options.outputs.includes(expected.output_name)) continue;
    const url = `${baseUrl}/executors/${EXECUTOR_TYPE}/${request.stage_instance_id}/units/${expected.unit_id}/emit/${expected.output_name}`;
    const response = await fetch(url, {
      method: "POST",
      // The revision rides in the key and the body alike: an unchanged payload
      // under a new key is still the same artifact, and an unchanged key is a
      // replay of the first emission whatever the payload says.
      headers: { "content-type": "application/json", "idempotency-key": `${request.execution_id}:${expected.unit_id}:${expected.output_name}:v${revision}` },
      body: JSON.stringify(artifactBody(request, expected.unit_id, expected.output_name, revision) as JsonValue),
    });
    const result = await readJson<EmitResponse>(response, `emit ${expected.output_name} for unit ${expected.unit_id}`);
    emitted.push({ artifact_id: result.artifact_id, output_name: expected.output_name, unit_id: expected.unit_id, release: result.release });
  }
  return emitted;
};

/** The gate an artifact is parked in, once the operator surface shows it. */
export const awaitPendingGate = async (baseUrl: string, artifactId: ArtifactId, timeoutMs = 30_000): Promise<OperatorParkedGate> =>
  awaitCondition(`a pending gate for artifact ${artifactId}`, async () => {
    const gates = await readJson<readonly OperatorParkedGate[]>(await fetch(`${baseUrl}/gates`), "list pending gates");
    return gates.find((gate) => gate.artifact_revision_id === artifactId) ?? null;
  }, timeoutMs);

/**
 * The operator's decision on a parked gate.
 *
 * For the assessor this is also what resolves the build's handoff: the gate's
 * `revision_target` is `upstream_handoff`, so the same request that decides the
 * assessment carries the downstream decision back to the build unit that has
 * been waiting on it. That routing is the route's job, and driving it here is
 * the point — it is the edge no test had ever exercised.
 */
export const decideGate = async (baseUrl: string, artifactId: ArtifactId, action: string): Promise<OperatorParkedGate> => {
  const gate = await awaitPendingGate(baseUrl, artifactId);
  if (!gate.resume_actions.includes(action)) throw new Error(`gate ${gate.id} does not offer action '${action}': ${gate.resume_actions.join(", ")}`);
  const response = await fetch(`${baseUrl}/gates/${gate.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: `${action}:${artifactId}`, artifact_revision_id: artifactId,
      gate_step: gate.gate_step, action, operator_comment: `integration test ${action}` }),
  });
  await readJson(response, `resume gate ${gate.id}`);
  return gate;
};

/** A gate decision the route refused, for a caller asserting the refusal. */
export interface RefusedGateDecision { readonly status: number; readonly error: string; readonly code?: string }

/** Posts a gate decision and reports the refusal rather than throwing on it. */
export const attemptGateDecision = async (baseUrl: string, artifactId: ArtifactId, action: string): Promise<RefusedGateDecision> => {
  const gate = await awaitPendingGate(baseUrl, artifactId);
  const response = await fetch(`${baseUrl}/gates/${gate.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: `${action}:${artifactId}`, artifact_revision_id: artifactId,
      gate_step: gate.gate_step, action, operator_comment: `integration test ${action}` }),
  });
  const parsed = await response.json() as { readonly error?: string; readonly code?: string };
  return { status: response.status, error: parsed.error ?? "", ...(parsed.code ? { code: parsed.code } : {}) };
};

/** What the cohort pull request route made of the evidence. */
export type CohortPullRequestAttempt =
  | { readonly kind: "accepted"; readonly outcome: string }
  | { readonly kind: "refused"; readonly detail: string };

const postCohortEvidence = async (baseUrl: string, cohortId: string, body: unknown): Promise<CohortPullRequestAttempt> => {
  const response = await fetch(`${baseUrl}/cohorts/${encodeURIComponent(cohortId)}/pull_request`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.ok) return { kind: "accepted", outcome: (JSON.parse(text) as { outcome: { kind: string } }).outcome.kind };
  if (response.status !== 409) throw new Error(`cohort pull request evidence for ${cohortId} failed: ${response.status} ${text}`);
  return { kind: "refused", detail: `${response.status} ${text}` };
};

/**
 * The operator's fallback: confirm by hand that a cohort's pull request merged.
 *
 * One attempt, no waiting. The handoff only reaches `awaiting_external` once
 * the assessor's decision has travelled to it, and the assessor cannot even
 * start until the caller has driven it — a helper that blocked here would stall
 * the very work it is waiting for.
 *
 * This is the same route the poller uses, and the confirmation is checked
 * against the same expectations as a polled observation. Driving it from a test
 * is not standing in for a missing participant any more: it is the button.
 */
export const confirmCohortMerged = async (baseUrl: string, cohortId: string): Promise<CohortPullRequestAttempt> =>
  postCohortEvidence(baseUrl, cohortId, {
    kind: "operator_confirmation", idempotency_key: `confirm-merged:${cohortId}`, operator_comment: "integration test confirmed the merge",
  });

/** The poller's path: report what the forge said about a cohort's pull request. */
export const observeCohortPullRequest = async (baseUrl: string, cohortId: string, observation: unknown): Promise<CohortPullRequestAttempt> =>
  postCohortEvidence(baseUrl, cohortId, { kind: "observation", observation });

/**
 * What `GithubPullRequestReader` would have produced for a merged cohort pull
 * request, built from the same values the faked agent reported opening.
 */
export const mergedPullRequestObservation = (unitId: UnitId, baseBranch: string) => {
  const url = cohortPullRequestUrl(unitId);
  const number = Number(url.slice(url.lastIndexOf("/") + 1));
  return {
    provider: "github", owner: "RankOneLabs", name: "oakridge", number, url,
    head_branch: cohortHeadBranch(unitId), base_branch: baseBranch, head_sha: "abc123",
    state: "merged", source: "poll", observed_at: new Date().toISOString(), merged_at: new Date().toISOString(),
  };
};

export const readRun = async (baseUrl: string, runId: OperatorRunSummary["id"]): Promise<OperatorRunDetail> =>
  readJson<OperatorRunDetail>(await fetch(`${baseUrl}/runs/${runId}`), `read run ${runId}`);

export const readReviewInbox = async (baseUrl: string): Promise<OperatorReviewInbox> =>
  readJson<OperatorReviewInbox>(await fetch(`${baseUrl}/review_inbox`), "read review inbox");
