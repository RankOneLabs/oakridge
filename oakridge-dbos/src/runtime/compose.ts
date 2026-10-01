/**
 * How an Oakridge backend is assembled.
 *
 * This used to live inline in `src/main.ts`, which meant the composition was a
 * script rather than a value: nothing but the process could build it, so
 * nothing but the process ever ran the real repositories, the real dispatchers
 * and the real HTTP routes together. Every test above unit scope had to rebuild
 * a smaller, differently-shaped system out of stubs — and the defects this
 * project keeps shipping live exactly in the seams those stubs paper over.
 *
 * `main.ts` is the process wrapper: environment, listener, timers, signals.
 * Everything that decides what the backend *is* happens here, once, for both
 * the process and the end-to-end tests.
 *
 * Two v14 calls are deliberately absent. `requireV2CutoverDatabase` is gone
 * because v15 is a clean baseline, not an upgrade — there is no pre-cutover
 * shape left to refuse. `registerRunRecordWorkflowServices` is still here, but
 * what it registers is the v15 topology: one machine per decision owner rather
 * than one root workflow that asked for the whole run's next move.
 */
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";

import { createDevFlowAdapterRegistry } from "../adapters/dev-flow";
import { registerDevFlowMachine } from "../adapters/dev-flow-machine";
import type { RegisteredEffect } from "../decision/stage-effects";
import { parseRepositoryRefs } from "../domain/repository-refs";
import { RepositoryProvisioningAdapter } from "../adapters/repository-provisioning";
import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { attemptWorkflowId, stageInstanceIdFor } from "../decision/ids";
import { StageMachineRegistry } from "./executor-registry";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../domain/artifact-types";
import type { ArtifactEnvelope, ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { CommittedSessionLaunch, DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { readJsonPointer } from "../domain/json-pointer";
import { err, ok, type AttemptId, type CohortId, type JsonValue, type Result, type RunTransitionId, type StageInstanceId, type UnitId, type WorkOrderId, type WorkflowRunId } from "../domain/primitives";
import { parseGithubPullRequestIdentity } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { InitializeStageInstance } from "../domain/run-record";
import type { RetryCohortResult, RetryCohortTarget } from "../domain/run-record";
import { selectOrphanedVersionRuns, type OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { PromptBundleEntry } from "../domain/workflow";
import { parseWorkflowDefinition } from "../validation/workflow-definition";
import { STAGE_CONTRACT_DEPENDENCY_KEY } from "../storage/load-run-snapshot";
import { STAGE_CONTRACT_INPUT_EDGES_KEY } from "../domain/stage-contract";
import { prepareDevFlowBuildCohort } from "./cohort-pull-request";
import { pollStagePullRequests, type PullRequestReader, type StagePullRequestPollOutcome } from "./github-pull-requests";
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import {
  PostgresArtifactRepository,
  PostgresCollaborationRepository,
  PostgresStageInstanceRepository,
  PostgresWorkflowRunRepository,
} from "../storage/postgres-domain";
import { PostgresDevFlowPullRequestRepository, PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresRunRecordWriter } from "../storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record-repository";
import { StageEventApplier } from "../storage/apply-stage-event";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { findExecutorAdapter, registerExecutorAdapter } from "./executor-registry";
import { loadStageInputs, registerRunRecordWorkflowServices, stageEffectWorkflow, attemptWorkflow } from "../workflows/run-record-topology";
import "../workflows/collaboration-responder";
import { DbosRunLaunchClient } from "./dbos-run-launch-client";
import { DbosCollaborationPingClient, PostgresSessionMessageRecipientResolver, PostgresSessionMessageRepository } from "./collaboration-ping";
import { BunGitCommandRunner } from "./git-command-runner";
import { createPromptTemplateLoader } from "./prompt-template";
import { GitProjectRepositoryIdentityResolver } from "./project-identity";
import { dispatchRunLaunches } from "./run-launch-dispatch";
import { publishWorkOrderArtifact } from "./publish-work-order-artifact";
import { resolveAttemptExecution } from "./resolve-work-order";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface OakridgeRuntimeConfig {
  readonly database_url: string;
  /**
   * Scopes DBOS workflow recovery. Also stamped on enqueued run launches, so a
   * launch is only picked up by a backend of the same version.
   */
  readonly application_version: string;
  /**
   * How a cohort's work actually gets done, one adapter per stage type. The
   * agent-facing one is the collaborator a test replaces; the deterministic
   * repository provisioner is built here, because it publishes its artifact
   * through the same transform the emit route uses and only this composition
   * holds the repositories that transform needs.
   */
  readonly executor_adapters: readonly ExecutorAdapter[];
  readonly prompt_template_directory: string;
  /** Bearer token required on state-changing requests; absent on a loopback bind. */
  readonly control_token?: string;
  readonly git_commands?: GitCommandRunner;
  /**
   * Reads the pull requests cohorts are waiting on. Absent when the backend has
   * no credentials for the forge, in which case nothing polls and an operator
   * confirms merges by hand through the same route.
   */
  readonly pull_request_reader?: PullRequestReader;
  readonly pull_request_poll_interval_ms?: number;
  readonly now?: () => string;
}

export interface OakridgeRuntime {
  readonly app: Hono;
  /** Starts the root machine of every run whose intent is stored but unstarted. */
  dispatch_launches(): Promise<number>;
  /** Writes the built-in workflow definitions. Safe to call repeatedly. */
  seed_builtins(): Promise<void>;
  /**
   * Asks the forge about every cohort parked on its pull request, and closes
   * the waits whose pull requests have merged. Resolves to null when no reader
   * is configured, which is a backend where merges are confirmed by hand.
   */
  poll_pull_requests(): Promise<readonly StagePullRequestPollOutcome[] | null>;
  readonly pull_request_poll_interval_ms: number | null;
  start_unstarted_effects(): Promise<number>;
  is_pull_request_poll_running(): boolean;
  pause_pull_request_polling(): Promise<() => void>;
  /**
   * Runs this executor has inherited from an application version it cannot
   * recover. Empty on a healthy start; anything here will never advance on its
   * own and has to be cancelled.
   */
  orphaned_version_runs(): Promise<readonly OrphanedVersionRuns[]>;
  /** Settles in-flight dispatch, then closes the SQL pool and DBOS client. */
  close(): Promise<void>;
}

export const createOakridgeRuntime = async (config: OakridgeRuntimeConfig): Promise<OakridgeRuntime> => {
  const pullRequestPollIntervalMs = config.pull_request_poll_interval_ms
    ?? Number(process.env.OAKRIDGE_PULL_REQUEST_POLL_SECONDS ?? "60") * 1_000;
  if (!Number.isFinite(pullRequestPollIntervalMs) || pullRequestPollIntervalMs < 1_000) {
    throw new Error("OAKRIDGE_PULL_REQUEST_POLL_SECONDS must be at least 1 second");
  }
  const now = config.now ?? (() => new Date().toISOString());
  const sql = PgPostgresExecutor.connect(config.database_url);
  const client = await DBOSClient.create({ systemDatabaseUrl: config.database_url });

  const adapterRegistry = createDevFlowAdapterRegistry();
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);
  const writer = new PostgresRunRecordWriter(sql, adapterRegistry);
  const runRecords = new PostgresRunRecordRepository(sql, writer);
  const machineRegistry = new StageMachineRegistry();
  const registeredEffects = new Map<string, RegisteredEffect>();
  registerDevFlowMachine(machineRegistry, registeredEffects);
  const definitions = new PostgresWorkflowDefinitionRepository(sql, adapterRegistry, machineRegistry);
  const startEffects = async (transition_ids: readonly RunTransitionId[]): Promise<void> => {
    if (transition_ids.length === 0) return;
    const rows = await sql.query<{ readonly id: string; readonly effect_workflow_id: string }>(
      `SELECT id::text,effect_workflow_id FROM oakridge.run_transition WHERE id=ANY($1::uuid[])`, [transition_ids]);
    for (const row of rows) await DBOS.startWorkflow(stageEffectWorkflow,
      { workflowID: row.effect_workflow_id })(row.id as RunTransitionId);
  };
  const stageEvents = new StageEventApplier({ sql, writer, registry: machineRegistry,
    registered_effects: registeredEffects,
    load_stage_inputs: async (_tx, stage_instance_id, cohort_key) => {
      const stage = await stages.find_contract(stage_instance_id);
      return stage ? loadStageInputs(stage.stage_contract, cohort_key) : {};
    },
    start_effects: startEffects, now });
  runRecords.set_stage_event_applier(stageEvents);
  const stages = new PostgresStageInstanceRepository(sql);
  const artifacts = new PostgresArtifactRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const pullRequests = new PostgresDevFlowPullRequestRepository(sql);
  const projections = new PostgresOperatorProjectionRepository(sql, config.application_version, adapterRegistry);
  const messages = new PostgresSessionMessageRepository(sql);
  const messageRecipients = new PostgresSessionMessageRecipientResolver(sql);

  const dbosRuns = new DbosRunLaunchClient(client);
  const collaborationPings = new DbosCollaborationPingClient(client, config.application_version, messages);

  // HTTP handlers and the periodic workers share these dispatch functions. Keep
  // every invocation in the same in-flight set so shutdown cannot close the SQL
  // pool while a request-triggered dispatcher is still using it.
  const inFlightDispatches = new Set<Promise<unknown>>();
  let isDispatchClosing = false;
  const trackDispatch = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (isDispatchClosing) return Promise.reject(new Error("Oakridge is shutting down; durable dispatch remains queued"));
    const pending = operation();
    inFlightDispatches.add(pending);
    void pending.finally(() => inFlightDispatches.delete(pending)).catch(() => undefined);
    return pending;
  };
  const dispatchLaunches = () => trackDispatch(() => dispatchRunLaunches(runs, dbosRuns, config.application_version));

  registerDbosTransportClient(client);
  for (const adapter of config.executor_adapters) registerExecutorAdapter(adapter);
  const git = config.git_commands ?? new BunGitCommandRunner();
  const enrichStagePublication = async (input: { readonly attempt_id: AttemptId;
    readonly output_name: string; readonly body: JsonValue }): Promise<Result<JsonValue | null,
      { readonly code: string; readonly detail: string }>> => {
    if (input.output_name !== "pr_summary") return ok(null);
    const rows = await sql.query<{ readonly repository_path: string; readonly canonical_ref: string;
      readonly expected_pr_base: string }>(
      `SELECT build.repository_path,build.canonical_ref,build.expected_pr_base
       FROM oakridge.attempt attempt JOIN oakridge.dev_flow_build_cohort build ON build.cohort_id=attempt.cohort_id
       WHERE attempt.id=$1`, [input.attempt_id]);
    const roles = rows[0];
    const base = { expected_pr_base: roles?.expected_pr_base ?? null,
      canonical_ref: roles?.canonical_ref ?? null };
    const url = isJsonObject(input.body) && typeof input.body.pr_url === "string" ? input.body.pr_url : null;
    const identity = url ? parseGithubPullRequestIdentity(url) : null;
    if (!identity || !roles) return ok({ ...base, pr: null, origin_head_sha: null });
    const reader = config.pull_request_reader;
    if (!reader) return err({ code: "enrichment_unavailable", detail: "GitHub reader is not configured" });
    const reading = await reader.read(identity.owner, identity.name, identity.number);
    if (!reading.ok) return err({ code: "enrichment_unavailable", detail: reading.error.detail });
    if (reading.value === null) return ok({ ...base, pr: null, origin_head_sha: null });
    const ref = `refs/heads/${roles.canonical_ref}`;
    let remote: Awaited<ReturnType<GitCommandRunner["run"]>>;
    try { remote = await git.run(roles.repository_path, ["ls-remote", "origin", ref]); }
    catch (error) { return err({ code: "enrichment_unavailable", detail: String(error) }); }
    if (remote.exit_code !== 0) return err({ code: "enrichment_unavailable", detail: remote.stderr.trim() || "origin could not be read" });
    const origin_head_sha = remote.stdout.trim().split(/\s+/)[0] || null;
    return ok({ ...base, pr: reading.value as unknown as JsonValue, origin_head_sha });
  };
  registerExecutorAdapter(new RepositoryProvisioningAdapter({
    git,
    publish_work_order: async (request) => {
      const result = await publishWorkOrderArtifact({
        attempt_id: request.work_order_id as unknown as AttemptId, capability: request.capability,
        output_name: request.output_name, collection_key: null, body: request.body,
        idempotency_key: request.idempotency_key,
      }, { records: runRecords, now });
      if (result.kind === "published" || result.kind === "pending" || result.kind === "already_applied") {
        await sendRunWakeHint(result.run_id, `provision:${result.artifact_id}`).catch(() => undefined);
      }
      return result;
    },
  }));

  /**
   * The stage contract a run's stages are opened with, compiled from the
   * definition version the run was launched against.
   *
   * `dependency_stage_instance_ids` is written beside the compiled contract
   * rather than inside it: `derive` closes over stage-instance ids, and core has
   * no business resolving a definition's stage *names* at decision time. The
   * projections still read `stage_contract->>'operator_role'`, so the compiled
   * contract keeps its own shape untouched.
   */
  const compileRunStages = async (run_id: WorkflowRunId): Promise<readonly InitializeStageInstance[]> => {
    const launch = await runs.find_launch_by_id(run_id);
    if (!launch) throw new Error(`workflow run '${run_id}' was not found`);
    const definition = await definitions.find_by_id(launch.workflow_definition_id);
    if (!definition) throw new Error(`workflow definition '${launch.workflow_definition_id}' was not found`);
    const parsed = parseWorkflowDefinition(definition, adapterRegistry);
    if (!parsed.ok) throw new Error(`run ${run_id}'s definition is invalid: ${parsed.error.detail}`);
    const compiled = compileWorkflowDefinition(parsed.value, undefined, adapterRegistry, machineRegistry);
    if (!compiled.ok) throw new Error(`run ${run_id}'s definition does not compile: ${compiled.error.detail}`);
    const producers = new Map<string, Set<string>>();
    for (const edge of compiled.value.edges) {
      const existing = producers.get(edge.consumer_stage) ?? new Set<string>();
      existing.add(edge.producer_stage);
      producers.set(edge.consumer_stage, existing);
    }
    const collecting = new Map<string, boolean>();
    for (const [stage_key, contract] of Object.entries(compiled.value.stages)) {
      for (const input of contract.inputs) collecting.set(`${stage_key}:${input.name}`, input.collect);
    }
    return Object.entries(compiled.value.stages).map(([stage_key, contract]) => ({
      id: stageInstanceIdFor(run_id, stage_key),
      stage_key,
      stage_type: contract.stage_type,
      stage_contract: { ...(contract as unknown as Record<string, JsonValue>),
        [STAGE_CONTRACT_DEPENDENCY_KEY]: [...(producers.get(stage_key) ?? [])].sort()
          .map((producer) => stageInstanceIdFor(run_id, producer) as string),
        [STAGE_CONTRACT_INPUT_EDGES_KEY]: compiled.value.edges
          .filter((edge) => edge.consumer_stage === stage_key)
          .map((edge) => ({ input_name: edge.consumer_input,
            producer_stage_instance_id: stageInstanceIdFor(run_id, edge.producer_stage) as string,
            producer_output: edge.producer_output,
            collect: collecting.get(`${stage_key}:${edge.consumer_input}`) === true })),
      } as JsonValue,
      dependency_stage_instance_ids: [...(producers.get(stage_key) ?? [])].sort()
        .map((producer) => stageInstanceIdFor(run_id, producer)),
    }));
  };

  const runContextOf = async (run_id: WorkflowRunId): Promise<JsonValue | null> => {
    const launch = await runs.find_launch_by_id(run_id);
    return launch ? launch.context as JsonValue : null;
  };

  const promptBundleOf = async (run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]> => {
    const launch = await runs.find_launch_by_id(run_id);
    if (!launch) throw new Error(`workflow run '${run_id}' was not found`);
    const bundle = await definitions.find_prompt_bundle(launch.bundle_pin.prompt_bundle_hash);
    if (!bundle) throw new Error(`run '${run_id}' is pinned to prompt bundle '${launch.bundle_pin.prompt_bundle_hash}', which is not stored`);
    return bundle.matrix;
  };

  const resolveStageAttemptRequest = async (attempt_id: AttemptId): Promise<ExecutionRequest> => {
    const rows = await sql.query<{ readonly run_id: string; readonly stage_instance_id: string;
      readonly cohort_id: string; readonly cohort_key: string; readonly stage_data: JsonValue;
      readonly stage_contract: JsonValue; readonly context: JsonValue; readonly effect_descriptor: JsonValue;
      readonly launch_transition_id: string }>(
      `SELECT attempt.run_id::text,attempt.stage_instance_id::text,cohort.id::text AS cohort_id,
              cohort.cohort_key,cohort.stage_data,stage.stage_contract,run.context,
              launch.effect_descriptor,launch.id::text AS launch_transition_id
       FROM oakridge.attempt attempt JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id=attempt.run_id
       JOIN oakridge.session session ON session.attempt_id=attempt.id
       JOIN oakridge.run_transition launch ON launch.id=session.launch_transition_id
       WHERE attempt.id=$1`, [attempt_id]);
    const row = rows[0];
    if (!row) throw new Error(`attempt '${attempt_id}' was not found`);
    const stage = row.stage_contract as unknown as CompiledStageContract;
    const data = row.stage_data;
    const artifact = isJsonObject(data) ? data.artifact ?? null : null;
    const inputs = await loadStageInputs(row.stage_contract, row.cohort_key);
    const descriptor = row.effect_descriptor;
    const effects = isJsonObject(descriptor) && Array.isArray(descriptor.effects) ? descriptor.effects : [];
    const launch = effects.find((effect) => isJsonObject(effect) && effect.name === "launch_session");
    const args = launch && isJsonObject(launch) ? launch.args : null;
    const role = args && isJsonObject(args) && typeof args.role === "string" ? args.role : null;
    const reason = args && isJsonObject(args) && typeof args.reason === "string" ? args.reason : null;
    const accepted = await sql.query<{ readonly id: string; readonly artifact_type: string;
      readonly output_name: string; readonly collection_key: string | null; readonly body: JsonValue; readonly chain_id: string }>(
      `SELECT artifact.id::text,artifact.artifact_type,acceptance.output_name,acceptance.collection_key,
              artifact.body,artifact.chain_id::text
       FROM oakridge.artifact_acceptance acceptance
       JOIN oakridge.artifact artifact ON artifact.id=acceptance.artifact_id
       WHERE acceptance.cohort_id=$1 AND acceptance.superseded_at IS NULL`, [row.cohort_id]);
    const accepted_outputs: readonly ArtifactEnvelope[] = accepted.map((entry) => ({
      artifact_id: entry.id as import("../domain/primitives").ArtifactId,
      artifact_type: entry.artifact_type, output_name: entry.output_name,
      unit_id: (entry.collection_key ?? row.cohort_key) as UnitId,
      collection_key: entry.collection_key, body: entry.body,
      chain_id: entry.chain_id as import("../domain/primitives").ArtifactId,
    }));
    let build_cohort = await pullRequests.find_cohort_for_unit(row.stage_instance_id as StageInstanceId, row.cohort_key as UnitId);
    if (role === "build" && stage.stage_key === "build" && build_cohort === null) {
      const repository_key = readJsonPointer(artifact, "/artifact/repository_key");
      if (typeof repository_key !== "string") throw new Error("build brief has no repository_key");
      const refs = inputs.repository_refs;
      const choices = refs === undefined ? [] : Array.isArray(refs) ? refs : [refs as ArtifactEnvelope];
      const matching = choices.find((candidate) => readJsonPointer(candidate.body, "/repository_key") === repository_key);
      if (!matching) throw new Error(`repository refs for '${repository_key}' are missing`);
      const parsed = parseRepositoryRefs(matching.body);
      if (!parsed.ok) throw new Error(parsed.error.detail);
      const prepared = await prepareDevFlowBuildCohort({ pull_requests: pullRequests, git }, {
        cohort_id: row.cohort_id as CohortId, stage_instance_id: row.stage_instance_id as StageInstanceId,
        cohort_key: row.cohort_key, repository: parsed.value, prepared_at: now(),
      });
      if (!prepared.ok) throw new Error(`${prepared.error.kind}: ${prepared.error.detail}`);
      build_cohort = prepared.value.cohort;
    }
    let session_launch: CommittedSessionLaunch | undefined;
    if (stage.stage_type === "delegated_session") {
      if (!role || !reason) throw new Error("launch transition has no role and reason");
      const config = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
      const entry = config.prompt_matrix.find((candidate) => candidate.session_role === role && candidate.launch_reason === reason);
      const bundle = await promptBundleOf(row.run_id as WorkflowRunId);
      const cell = bundle.find((candidate) => candidate.stage_key === stage.stage_key
        && candidate.session_role === role && candidate.launch_reason === reason
        && candidate.template_path === entry?.template_path);
      if (!cell) throw new Error(`pinned prompt bundle has no ${stage.stage_key}:${role}:${reason} cell`);
      session_launch = { reason: { transition_id: row.launch_transition_id as RunTransitionId, name: reason },
        session_role: role, prompt: { template_path: cell.template_path, content: cell.content },
        existing_pull_request: null };
    }
    const resolved = await resolveAttemptExecution({
      run_id: row.run_id as WorkflowRunId, stage, stage_instance_id: row.stage_instance_id as StageInstanceId,
      unit: { unit_id: row.cohort_key as UnitId, parameters: artifact, depends_on: [] },
      inputs, accepted_cohort_outputs: accepted_outputs, context: row.context,
      outputs: stage.outputs.map((output) => ({ output_name: output.name, artifact_type: output.artifact_type,
        release: output.release, attention: output.attention ?? "none" })),
      identity: `attempt:${attempt_id}`, capability_seed: await runRecords.load_work_order_capability_seed(),
      ...(session_launch ? { session_launch } : {}),
      ...(build_cohort ? { build_cohort } : {}),
      attempt_id: attempt_id as unknown as WorkOrderId,
      attempt_workflow_id: attemptWorkflowId(attempt_id),
    });
    return resolved.request;
  };

  registerRunRecordWorkflowServices({
    records: runRecords, stages, artifacts, effects_sql: sql, stage_events: stageEvents, find_run_context: runContextOf,
    resolve_attempt_request: resolveStageAttemptRequest,
    find_executor: findExecutorAdapter, now,
  });

  /**
   * A cohort fact from outside any machine's loop — the forge poller, an
   * operator's confirmed merge, a verification the final-stage route performed.
   *
   * It goes through the cohort's own driver and the same single-writer commit
   * the machine's step uses, then wakes the machine so it acts on the new state
   * without waiting out its bounded recheck.
   */
  const pollPullRequests = (): Promise<readonly StagePullRequestPollOutcome[] | null> => {
    const reader = config.pull_request_reader;
    if (!reader) return Promise.resolve(null);
    return trackDispatch(() => pollStagePullRequests({ sql, reader, stage_events: stageEvents }));
  };
  const retryStageCohort = async (target: RetryCohortTarget, idempotency_key: string): Promise<RetryCohortResult> => {
    const cohort_id = target.kind === "cohort" ? target.cohort_id
      : (await runRecords.find_cohort_location(target.stage_instance_id,
        target.cohort_key as import("../domain/primitives").UnitId))?.cohort_id;
    if (!cohort_id) return { kind: "cohort_not_found", detail: "cohort not found" };
    const readClaim = () => runRecords.find_cohort_retry_claim(cohort_id, idempotency_key);
    const claim = await readClaim();
    const location = await sql.query<{ readonly run_id: string; readonly durable_version: string }>(
      "SELECT run_id::text,durable_version::text FROM oakridge.cohort WHERE id=$1", [cohort_id]);
    if (!location[0]) return { kind: "cohort_not_found", detail: "cohort not found" };
    if (!claim) {
      const applied = await stageEvents.apply(cohort_id, { kind: "operator_retry", idempotency_key, actor: "operator" });
      if (!applied.ok) return { kind: "refused", code: applied.error.kind, detail: applied.error.detail };
      if (applied.value.kind === "refused") {
        const raced = await readClaim();
        if (!raced) return { kind: "refused", code: applied.value.code, detail: applied.value.detail };
      } else if (applied.value.kind === "ignored") return { kind: "refused", code: applied.value.reason,
        detail: "cohort is terminal" };
    }
    const stored = await readClaim();
    if (!stored) return { kind: "refused", code: "attempt_missing", detail: "retry did not create an attempt" };
    return { kind: claim ? "already_created" : "created", run_id: location[0].run_id as WorkflowRunId,
      cohort_id, attempt_id: stored.attempt_id, attempt_number: stored.attempt_number,
      durable_version: stored.durable_version };
  };
  const startUnstartedEffects = async (): Promise<number> => {
    const transitions = await sql.query<{ readonly id: string }>(
      `SELECT id::text FROM oakridge.run_transition
       WHERE effect_descriptor->>'external'='true' AND effects_started_at IS NULL
         AND created_at<clock_timestamp()-interval '5 seconds'
       ORDER BY created_at LIMIT 100`, []);
    await startEffects(transitions.map((row) => row.id as RunTransitionId));
    const attempts = await sql.query<{ readonly id: string }>(
      `SELECT attempt.id::text FROM oakridge.attempt attempt
       WHERE attempt.ended_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM dbos.workflow_status status
           WHERE status.workflow_uuid='v15-attempt:' || attempt.id::text)
       ORDER BY attempt.created_at LIMIT 100`, []);
    for (const attempt of attempts) await DBOS.startWorkflow(attemptWorkflow,
      { workflowID: `v15-attempt:${attempt.id}` })(attempt.id as AttemptId);
    return transitions.length + attempts.length;
  };
  let effectSweep: Promise<unknown> | null = null;
  const effectSweepTimer = setInterval(() => {
    if (effectSweep) return;
    effectSweep = startUnstartedEffects()
      .catch((error: unknown) => { console.error("stage effect sweep failed", error); })
      .finally(() => { effectSweep = null; });
  }, 30_000);
  let pullRequestPoll: Promise<unknown> | null = null;
  let isPullRequestPollClosing = false;
  let pullRequestTimer: ReturnType<typeof setInterval> | null = null;
  const startPullRequestTimer = (): void => {
    if (!config.pull_request_reader || isPullRequestPollClosing || pullRequestTimer) return;
    pullRequestTimer = setInterval(() => {
      if (pullRequestPoll) return;
      pullRequestPoll = pollPullRequests()
        .then((outcomes) => {
          for (const outcome of outcomes ?? []) if (outcome.kind === "unavailable")
            console.warn(`cohort ${outcome.cohort_id} pull request unavailable`);
        })
        .catch((error: unknown) => { console.error("cohort pull request poll failed", error); })
        .finally(() => { pullRequestPoll = null; });
    }, pullRequestPollIntervalMs);
  };
  startPullRequestTimer();

  const presentation = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { component_id: definition.component_id, capabilities: definition.capabilities,
      anchor_schema: definition.anchor_schema, review: definition.review as unknown as JsonValue } : null;
  };
  const collaborationPolicy = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { commentable: definition.capabilities.commentable,
      atom_editable: definition.capabilities.atom_editable } : null;
  };

  const app = createApp({
    configuration: { projects, definitions, project_identity: projectIdentity, now,
      prompt_templates: promptTemplates, adapter_roles: adapterRegistry },
    operator_retry: { retry_through_driver: retryStageCohort,
      abandon: async (cohort_id, detail) => {
        const result = await stageEvents.apply(cohort_id, { kind: "operator_abandon", actor: "operator", detail });
        if (!result.ok) return result.error.kind === "cohort_not_found"
          ? { kind: "not_found" as const }
          : { kind: "refused" as const, code: result.error.kind, detail: result.error.detail };
        return result.value.kind === "applied"
          ? { kind: "applied" as const, state: result.value.to }
          : { kind: "refused" as const, code: result.value.kind === "refused" ? result.value.code : result.value.reason,
            detail: result.value.kind === "refused" ? result.value.detail : "cohort is terminal" };
      } },
    run_lifecycle: { records: runRecords },
    domain_reads: { stages, artifacts, session_holds: projections, session_run_locations: projections },
    work_order_artifact_callback: { records: runRecords, enrich: enrichStagePublication,
      now, send_run_wake: sendRunWakeHint },
    gate_resume: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: { refresh: async (cohort_id) => {
      const reader = config.pull_request_reader;
      if (reader) await pollStagePullRequests({ sql, reader, stage_events: stageEvents }, cohort_id);
      const rows = await sql.query<{ readonly state: string }>(
        "SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]);
      return rows[0] ?? null;
    } },
    collaboration: { artifacts, collaboration, policy_for_artifact_type: collaborationPolicy,
      messages, message_recipients: messageRecipients,
      send_message: (input) => collaborationPings.enqueue(input),
      ping_thread: (input) => collaborationPings.enqueue(input) },
    operator_projections: projections,
    artifact_detail: { artifacts, stages, audits: artifacts, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
    run_launch: { definitions, projects, runs, projections,
      start_run: async (request) => {
        // Every stage instance exists before the root machine runs, because
        // `derive` closes over the whole graph. Initialization is idempotent, so
        // the launch path and the unstarted sweep can both reach it.
        await runRecords.initialize_run({ run_id: request.run_id, stages: await compileRunStages(request.run_id), initialized_at: now() });
        return dbosRuns.start_v2_run(request);
      },
      application_version: config.application_version, adapter_version: "delegated-session-v1",
      artifact_schema_version: "v1", now },
    rerun: { v2_cancellation: { records: runRecords, find_executor: findExecutorAdapter, now, send_run_wake: sendRunWakeHint } },
    ...(config.control_token ? { control_token: config.control_token } : {}),
  });

  return {
    app,
    dispatch_launches: dispatchLaunches,
    start_unstarted_effects: startUnstartedEffects,
    seed_builtins: () => seedBuiltins(definitions),
    poll_pull_requests: pollPullRequests,
    pull_request_poll_interval_ms: config.pull_request_reader ? pullRequestPollIntervalMs : null,
    is_pull_request_poll_running: () => pullRequestTimer !== null,
    async pause_pull_request_polling() {
      if (pullRequestTimer) clearInterval(pullRequestTimer);
      pullRequestTimer = null;
      await Promise.allSettled(pullRequestPoll ? [pullRequestPoll] : []);
      return startPullRequestTimer;
    },
    async orphaned_version_runs() {
      return selectOrphanedVersionRuns(await projections.list_application_versions(), config.application_version);
    },
    async close() {
      clearInterval(effectSweepTimer);
      await Promise.allSettled(effectSweep ? [effectSweep] : []);
      isPullRequestPollClosing = true;
      if (pullRequestTimer) clearInterval(pullRequestTimer);
      pullRequestTimer = null;
      await Promise.allSettled(pullRequestPoll ? [pullRequestPoll] : []);
      isDispatchClosing = true;
      await Promise.allSettled([...inFlightDispatches]);
      await client.destroy();
      await sql.close();
    },
  };
};
