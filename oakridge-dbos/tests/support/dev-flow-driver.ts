/**
 * Everyone but the agent, talking to Oakridge the way they really do.
 *
 * The agent emits artifacts through the executor callback route. The operator
 * approves gates through the gate resume route. Whatever watches GitHub
 * completes a handoff's external wait through the handoff completion route.
 * Nothing here reaches around the HTTP surface into a workflow, because a
 * message a test can post but production cannot is exactly how a deadlock ships
 * green.
 */
import type { OperatorParkedGate, OperatorRunDetail, OperatorRunSummary, OperatorReviewInbox } from "../../src/domain/operator-projections";
import type { ArtifactId, JsonValue, WorkflowDefinitionId } from "../../src/domain/primitives";
import type { ExecutionRequest } from "../../src/domain/execution";
import { artifactBody, awaitCondition, runContext } from "./dev-flow-harness";

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

/**
 * The agent's side of one execution: emit every artifact the unit owes,
 * through the same route a real coding agent calls.
 */
export const emitDeclaredArtifacts = async (baseUrl: string, request: ExecutionRequest): Promise<readonly EmittedArtifact[]> => {
  const emitted: EmittedArtifact[] = [];
  for (const expected of request.expected_artifacts) {
    const url = `${baseUrl}/executors/${EXECUTOR_TYPE}/${request.stage_instance_id}/units/${expected.unit_id}/emit/${expected.output_name}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${request.execution_id}:${expected.unit_id}:${expected.output_name}` },
      body: JSON.stringify(artifactBody(request, expected.unit_id) as JsonValue),
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

/** Whether the handoff was ready for its external completion yet. */
export type ExternalReviewAttempt =
  | { readonly kind: "completed" }
  | { readonly kind: "not_awaiting"; readonly detail: string };

/**
 * Completes a handoff's external wait — the `github_review` a build result
 * waits on once the assessor has approved it.
 *
 * One attempt, no waiting: the handoff only reaches `awaiting_external` once
 * the assessor's decision has travelled to it, and the assessor cannot even
 * start until the caller has driven it. A helper that blocked here would stall
 * the very work it is waiting for. The idempotency key is stable, so a repeated
 * attempt after the first success is a no-op rather than a second completion.
 *
 * Nothing in production makes this call. The route exists and is unit-tested;
 * no operator surface reaches it, and no reconciler observes GitHub on the
 * run's behalf. This function stands in for a participant that does not exist
 * yet — which is why it is here rather than hidden inside the system under
 * test, where it would read as a wait that completes itself.
 */
export const completeExternalReview = async (baseUrl: string, artifactId: ArtifactId): Promise<ExternalReviewAttempt> => {
  const response = await fetch(`${baseUrl}/handoffs/${artifactId}/external-complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ external_kind: "github_review", correlation_id: `github:${artifactId}`, idempotency_key: `external:${artifactId}` }),
  });
  if (response.ok) return { kind: "completed" };
  const detail = `${response.status} ${await response.text()}`;
  if (response.status !== 409) throw new Error(`external completion for ${artifactId} failed: ${detail}`);
  return { kind: "not_awaiting", detail };
};

export const readRun = async (baseUrl: string, runId: OperatorRunSummary["id"]): Promise<OperatorRunDetail> =>
  readJson<OperatorRunDetail>(await fetch(`${baseUrl}/runs/${runId}`), `read run ${runId}`);

export const readReviewInbox = async (baseUrl: string): Promise<OperatorReviewInbox> =>
  readJson<OperatorReviewInbox>(await fetch(`${baseUrl}/review_inbox`), "read review inbox");
