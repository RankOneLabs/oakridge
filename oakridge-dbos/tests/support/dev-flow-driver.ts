/**
 * Everyone but the agent, talking to Oakridge the way they really do.
 *
 * The agent emits artifacts through the work-order emit route. The operator
 * approves gates through the gate resume route, and confirms a merge through
 * the cohort pull request route — the same one the GitHub poller posts its
 * observations to. Nothing here reaches around the HTTP surface into a
 * workflow, because a message a test can post but production cannot is exactly
 * how a deadlock ships green.
 */
import { expect } from "bun:test";

import type { OperatorArtifactDetail, OperatorParkedGate, OperatorRunDetail, OperatorRunSummary, OperatorReviewInbox } from "../../src/domain/operator-projections";
import type { ArtifactId, JsonValue, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../../src/domain/primitives";
import type { ExecutionRequest } from "../../src/domain/execution";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../src/storage/sql-executor";
import { PostgresRunRecordRepository } from "../../src/storage/postgres-run-record";
import { artifactBody, awaitCondition, cohortHeadBranch, cohortPullRequestUrl, type ScriptedAgentScenario } from "./dev-flow-harness";

const readJson = async <Value>(response: Response, describe: string): Promise<Value> => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${describe} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Value;
};

export interface LaunchedRun {
  readonly run_id: OperatorRunSummary["id"];
  readonly root_workflow_id: string;
}

/**
 * Launches a run the way the operator surface does, and waits for it to start.
 *
 * `context` is supplied rather than defaulted because a run is defined by the
 * repositories it names — a caller proving what happens to a repository that
 * cannot be provisioned has to be able to name that one.
 */
export const launchRun = async (baseUrl: string, definitionId: WorkflowDefinitionId, context: JsonValue): Promise<LaunchedRun> => {
  const response = await fetch(`${baseUrl}/workflow_runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_def_id: definitionId, context }),
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

interface WorkOrderEmitResponse {
  readonly artifact_id: ArtifactId;
  readonly state: "released" | "pending";
}

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
  /**
   * Restricts the emission to these collection members — the `artifact_collection`
   * analog of `outputs`, for re-emitting one cohort's brief (say) without
   * touching the others `request.expected_artifacts` still lists.
   */
  readonly unit_ids?: readonly string[];
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
    if (options.unit_ids && !options.unit_ids.includes(expected.unit_id)) continue;
    const publication = (request.resolved_config as { readonly publication?: { readonly work_order_id: string; readonly capability: string } }).publication;
    if (!publication) throw new Error(`execution '${request.execution_id}' resolved with no v2 publication — a harness bug, not a legacy execution to emulate`);
    const url = `${baseUrl}/work-orders/${publication.work_order_id}/emit/${expected.output_name}`;
    const response = await fetch(url, {
      method: "PUT",
      // The revision rides in the key and the body alike: an unchanged payload
      // under a new key is still the same artifact, and an unchanged key is a
      // replay of the first emission whatever the payload says.
      headers: { "content-type": "application/json", "idempotency-key": `${request.execution_id}:${expected.unit_id}:${expected.output_name}:v${revision}`,
        "work-order-capability": publication.capability,
        ...(expected.unit_id !== request.unit_id ? { "output-collection-key": expected.unit_id } : {}) },
      body: JSON.stringify(artifactBody(request, expected.unit_id, expected.output_name, revision) as JsonValue),
    });
    const result = await readJson<WorkOrderEmitResponse>(response, `emit ${expected.output_name} for unit ${expected.unit_id}`);
    const sessionName = (request.resolved_config as { readonly session_name?: string }).session_name ?? "";
    const release = result.state === "released" ? "released" : sessionName.startsWith("build-") ? "waiting_handoff" : "waiting_gate";
    emitted.push({ artifact_id: result.artifact_id, output_name: expected.output_name, unit_id: expected.unit_id, release });
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

/** An artifact as the operator surface serves it, current revision first. */
export const readArtifact = async (baseUrl: string, artifactId: ArtifactId): Promise<OperatorArtifactDetail> =>
  readJson<OperatorArtifactDetail>(await fetch(`${baseUrl}/artifact_details/${artifactId}`), `read artifact ${artifactId}`);

export const readRun = async (baseUrl: string, runId: OperatorRunSummary["id"]): Promise<OperatorRunDetail> =>
  readJson<OperatorRunDetail>(await fetch(`${baseUrl}/runs/${runId}`), `read run ${runId}`);

export const readReviewInbox = async (baseUrl: string): Promise<OperatorReviewInbox> =>
  readJson<OperatorReviewInbox>(await fetch(`${baseUrl}/review_inbox`), "read review inbox");

/** The gates parked against one run, as `GET /runs/:id/gates` reports them. */
export const listRunGates = async (baseUrl: string, runId: LaunchedRun["run_id"]): Promise<readonly OperatorParkedGate[]> =>
  readJson<readonly OperatorParkedGate[]>(await fetch(`${baseUrl}/runs/${runId}/gates`), `list gates for run ${runId}`);

/**
 * One driven pass of the loop every scenario shares: emit whatever agents
 * owe, decide whichever parked gates the scenario's policy allows, confirm
 * every cohort merge waiting in the review inbox, then check whether the
 * scenario's own condition has been reached.
 */
export interface DriveOptions<Value> {
  /** Decide a parked gate, or leave it open. Called with the gate as `GET /gates` lists it. */
  readonly decide: (gate: OperatorParkedGate) => string | null;
  /** Stop when this returns non-null; it is polled after every pass. */
  readonly until: () => Promise<Value | null>;
  readonly timeout_ms: number;
}

export interface DriveOutcome<Value> {
  readonly value: Value;
  /** Execution workflow ids this drive emitted artifacts for and succeeded. */
  readonly driven: ReadonlySet<string>;
  /** Cohort ids (`${stage_instance_id}:${unit_id}`) confirmed merged this drive. */
  readonly confirmed: ReadonlySet<string>;
}

/**
 * Drives a launched run the way every participant but the operator's gate
 * policy really does: emit artifacts, confirm merges, and — the one thing
 * that varies between scenarios — decide only the gates `options.decide`
 * says to.
 *
 * `driven` and `confirmed` accumulate for the lifetime of this call only; a
 * scenario that calls `driveRun` more than once (to vary the gate policy
 * between phases) gets a fresh count each call, exactly as an inline loop
 * restarted with fresh sets would.
 */
export const driveRun = async <Value>(baseUrl: string, agent: ScriptedAgentScenario, run: LaunchedRun, options: DriveOptions<Value>): Promise<DriveOutcome<Value>> => {
  const driven = new Set<string>();
  const confirmed = new Set<string>();
  const decided = new Set<string>();
  const deadline = Date.now() + options.timeout_ms;
  for (;;) {
    for (const [workflowId, request] of agent.launched) {
      if (driven.has(workflowId)) continue;
      driven.add(workflowId);
      // The execution's publication handle is its own work order — the seam
      // the adapter and the emit route agree on.
      const publication = (request.resolved_config as { readonly publication?: { readonly work_order_id: string } }).publication;
      expect(publication?.work_order_id).toBe(workflowId);
      await emitDeclaredArtifacts(baseUrl, request);
      agent.succeed(request.execution_id);
    }

    // `listV2PendingGates` reports a collection-key gate's `unit_id` as the
    // collection key itself (spec §3.7), so the gate the API lists is passed
    // to `options.decide` as-is — no re-keying against the emitted artifact.
    for (const gate of await listRunGates(baseUrl, run.run_id)) {
      if (decided.has(gate.id)) continue;
      const action = options.decide(gate);
      if (!action) continue;
      if (!gate.artifact_revision_id) continue;
      decided.add(gate.id);
      await decideGate(baseUrl, gate.artifact_revision_id, action);
    }

    const inbox = await readReviewInbox(baseUrl);
    for (const item of inbox.items) {
      if (item.kind !== "pull_request_merge" || item.run_id !== run.run_id) continue;
      const cohortId = `${item.stage_instance_id}:${item.unit_id}`;
      // The inbox item's PR is the one the build's pr_summary named.
      expect(item.pr_url).toBe(cohortPullRequestUrl(item.unit_id as UnitId));
      const result = await confirmCohortMerged(baseUrl, cohortId);
      if (result.kind === "accepted" && result.outcome === "completed") confirmed.add(cohortId);
    }

    const value = await options.until();
    if (value !== null) return { value, driven, confirmed };
    if (Date.now() > deadline) throw new Error(`driveRun timed out after ${options.timeout_ms}ms waiting for run ${run.run_id}'s condition`);
    await Bun.sleep(50);
  }
};

/** `record_version` and how many transitions have been written for one run — invariant 7's measurement. */
export interface RunRecordFingerprint {
  readonly record_version: number;
  readonly transition_count: number;
}

export const readRunRecordFingerprint = async (sql: SqlExecutor, runId: WorkflowRunId): Promise<RunRecordFingerprint> => {
  const runRows = await sql.query<{ readonly record_version: number }>("SELECT record_version FROM oakridge.workflow_run WHERE id = $1", [runId]);
  if (!runRows[0]) throw new Error(`workflow run '${runId}' was not found`);
  const transitionRows = await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_transition WHERE run_id = $1", [runId]);
  return { record_version: Number(runRows[0].record_version), transition_count: Number(transitionRows[0]?.count ?? 0) };
};

/**
 * Invariant 7 measured: asking again changes nothing. Asks `decide_run`
 * twice — once to prove a quiescent record answers with no work, once more
 * to prove that answer wasn't itself a change — and asserts the fingerprint
 * taken before either ask still matches the one taken after both.
 */
/** How long the record must sit unchanged before the root is taken to be parked: several asks' worth, well under the 5 s recheck. */
const QUIET_SETTLE_MS = 1_500;

/**
 * Waits for the root's own cascade to finish. A drive pass returns as soon as
 * its `until` holds, but the consequences of that pass's last emission or
 * decision may still be in flight through the root (a wake, an ask, a
 * `recheck`, another ask); the quiet point is when the record has stopped
 * moving on its own.
 */
const awaitSettledRecord = async (sql: SqlExecutor, runId: WorkflowRunId): Promise<RunRecordFingerprint> => {
  let last = await readRunRecordFingerprint(sql, runId);
  let stableSince = Date.now();
  const deadline = Date.now() + 20_000;
  for (;;) {
    await Bun.sleep(100);
    const next = await readRunRecordFingerprint(sql, runId);
    if (next.record_version !== last.record_version || next.transition_count !== last.transition_count) { last = next; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= QUIET_SETTLE_MS) return last;
    if (Date.now() > deadline) throw new Error(`run ${runId}'s record never settled: still moving at ${JSON.stringify(next)}`);
  }
};

export const assertQuietAsk = async (sql: TransactionalSqlExecutor, runId: WorkflowRunId): Promise<void> => {
  const before = await awaitSettledRecord(sql, runId);
  const repository = new PostgresRunRecordRepository(sql);
  const first = await repository.decide_run(runId, new Date().toISOString());
  const second = await repository.decide_run(runId, new Date().toISOString());
  const after = await readRunRecordFingerprint(sql, runId);
  // A `recheck` here means the record was not quiescent when the scenario said
  // it was — and a test-side ask that starts work orphans it (nothing launches
  // its workflow), so this fails loudly instead of letting the scenario hang.
  for (const ask of [first, second]) {
    if (!ask.ok || ask.value.kind !== "wait") throw new Error(`quiet ask on run ${runId} was not quiet: ${JSON.stringify(ask)} (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
  }
  expect(after.record_version).toBe(before.record_version);
  expect(after.transition_count).toBe(before.transition_count);
};
