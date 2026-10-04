import { observeCohortPullRequest } from "./observe-cohort-pull-request";
import { prepareCohortRepository } from "./prepare-cohort-repository";
import { selectAvailableArtifactReviewContext } from "../domain/v15-operator-review";
import { loadStageCohortContext, loadStageCohortEvaluation } from "../storage/load-stage-cohort";
import { observeWorkerExecution } from "./observe-worker-execution";
import { discoverFinalIntegrationPullRequest } from "./final-integration";
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
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";

import { createDevFlowAdapterRegistry, registerDevFlowCohortDetails } from "../adapters/dev-flow";
import { stageInstanceIdFor } from "../decision/ids";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../domain/artifact-types";
import type { ExecutorAdapter } from "../domain/execution";
import { type JsonValue, type WorkflowRunId } from "../domain/primitives";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { InitializeStageInstance } from "../domain/run-record";
import { selectOrphanedVersionRuns, type OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { PromptBundleEntry } from "../domain/workflow";
import { STAGE_CONTRACT_DEPENDENCY_KEY } from "../storage/load-run-snapshot";
import { pollStagePullRequests, type PullRequestReader, type StagePullRequestPollOutcome } from "./github-pull-requests";
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import {
  PostgresForgeRepositoryRepository,
  PostgresArtifactRepository,
  PostgresCollaborationRepository,
  PostgresStageInstanceRepository,
  PostgresWorkflowRunRepository,
} from "../storage/postgres-domain";
import { PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresRunRecordWriter } from "../storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record-repository";
import { PostgresDevFlowPullRequestRepository } from "../storage/postgres-dev-flow";
import { StageEventApplier } from "../storage/apply-stage-event";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { findExecutorAdapter, registerExecutorAdapter } from "./executor-registry";
import { registerRunRecordWorkflowServices, WORKER_EXECUTION_WORKFLOW_NAME } from "../workflows/run-record-topology";
import "../workflows/collaboration-responder";
import { DbosRunLaunchClient } from "./dbos-run-launch-client";
import { DbosCollaborationPingClient, PostgresSessionMessageRecipientResolver, PostgresSessionMessageRepository } from "./collaboration-ping";
import { BunGitCommandRunner } from "./git-command-runner";
import { createPromptTemplateLoader } from "./prompt-template";
import { GitProjectRepositoryIdentityResolver } from "./project-identity";
import { dispatchRunLaunches, dispatchCohortExecution, stopCohortExecution } from "./run-launch-dispatch";
import { createImplementationWorkerSessionIO } from "./implementation-worker-session";
import { dispatchProvisionExecution } from "./provision-execution";
import { createImplementationPublicationEnricher } from "./implementation-publication";

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
  readonly pull_request_reader: PullRequestReader;
  readonly pull_request_poll_interval_ms?: number;
  readonly now?: () => string;
}

export interface OakridgeRuntime {
  readonly app: Hono;
  /** Starts the root machine of every run whose intent is stored but unstarted. */
  dispatch_launches(): Promise<number>;
  /** Writes the built-in workflow definitions. Safe to call repeatedly. */
  seed_builtins(): Promise<void>;
  poll_pull_requests(): Promise<readonly StagePullRequestPollOutcome[]>;
  readonly pull_request_poll_interval_ms: number;
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
  const git = config.git_commands ?? new BunGitCommandRunner();
  const cohortPullRequests = new PostgresDevFlowPullRequestRepository(sql);
  const client = await DBOSClient.create({ systemDatabaseUrl: config.database_url });

  const adapterRegistry = createDevFlowAdapterRegistry();
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);
  const writer = new PostgresRunRecordWriter(sql);
  const definitions = new PostgresWorkflowDefinitionRepository(sql);
  const stages = new PostgresStageInstanceRepository(sql);
  const forgeRepositories = new PostgresForgeRepositoryRepository(sql);
  const observePr = (cohort_id: import("../domain/primitives").CohortId) => observeCohortPullRequest({ sql, git,
    reader: config.pull_request_reader, pull_requests: cohortPullRequests, forge_repositories: forgeRepositories }, cohort_id);
  const stageEvents = new StageEventApplier({ sql, writer,
    observe_pr: observePr,
    prepare_repository: (cohort_id) => prepareCohortRepository({ sql, git, pull_requests: cohortPullRequests, now }, cohort_id),
    dispatch_executions: async (ids) => {
      for (const execution_id of ids) await client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: WORKER_EXECUTION_WORKFLOW_NAME,
        workflowID: `v15-worker:${execution_id}`, appVersion: config.application_version }, [execution_id]);
    }, now });
  const runRecords = new PostgresRunRecordRepository(sql, writer, stageEvents);
  const artifacts = new PostgresArtifactRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const projections = new PostgresOperatorProjectionRepository(sql, config.application_version, adapterRegistry, observePr);
  registerDevFlowCohortDetails(projections, sql);
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
  const enrichStagePublication = createImplementationPublicationEnricher({ sql, git,
    pull_requests: cohortPullRequests, forge_repositories: forgeRepositories, reader: config.pull_request_reader });


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
    const source = definition.definition;
    return Object.entries(source.stages).map(([stage_key, contract]) => ({
      id: stageInstanceIdFor(run_id, stage_key), stage_key,
      stage_type: stage_key === "repository_preparation" ? "provision_repository_refs" : "delegated_session",
      stage_contract: { ...contract, [STAGE_CONTRACT_DEPENDENCY_KEY]: contract.prerequisites.map((key: import("../domain/dev-flow-v15").StageKey) => stageInstanceIdFor(run_id, key)) } as unknown as JsonValue,
      dependency_stage_instance_ids: contract.prerequisites.map((key: import("../domain/dev-flow-v15").StageKey) => stageInstanceIdFor(run_id, key)),
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
    return bundle.entries;
  };

  const workerSessionIO = createImplementationWorkerSessionIO({ sql, git, records: runRecords,
    prompt_bundle: promptBundleOf, run_context: runContextOf, find_executor: findExecutorAdapter, now,
    discover_final_pr: (cohort_id) => discoverFinalIntegrationPullRequest({ sql, git, reader: config.pull_request_reader }, cohort_id) });
  const dispatchWorkerExecution = async (execution_id: import("../domain/primitives").ExecutionId): Promise<void> => {
    const intents = await sql.query<{ readonly worker: string }>("SELECT worker FROM oakridge.execution_intent WHERE id=$1", [execution_id]);
    const dispatched = intents[0]?.worker === "provision"
      ? await dispatchProvisionExecution({ sql, git, now, advance: (cohort_id) => stageEvents.advance(cohort_id, null) }, execution_id)
      : await dispatchCohortExecution(sql, execution_id, workerSessionIO);
    if (!dispatched.ok && dispatched.error.kind === "stop_failed") throw new Error(dispatched.error.detail);
    if (!dispatched.ok) console.warn(`worker execution ${execution_id}: ${dispatched.error.detail}`);
  };

  registerRunRecordWorkflowServices({
    records: runRecords, effects_sql: sql, stage_events: stageEvents,
    initialize_run: async (run_id) => {
      await runRecords.initialize_run({ run_id, stages: await compileRunStages(run_id), initialized_at: now() });
    },
    dispatch_worker_execution: dispatchWorkerExecution,
    observe_worker_execution: async (execution_id) => {
      const observed = await observeWorkerExecution({ sql, adapter: findExecutorAdapter("delegated_session"), stage_events: stageEvents, now }, execution_id);
      if (!observed.ok) throw new Error(observed.error.detail);
      return observed.value;
    },
    now,
  });

  const pollPullRequests = (): Promise<readonly StagePullRequestPollOutcome[]> =>
    trackDispatch(() => pollStagePullRequests({ sql, stage_events: stageEvents }));
  const startUnstartedEffects = async (): Promise<number> => {
    const intents = await sql.query<{ readonly id: import("../domain/primitives").ExecutionId }>(
      `SELECT id FROM oakridge.execution_intent WHERE status='dispatching' OR (status='pending'
       AND stop_requested_at IS NULL) ORDER BY created_at LIMIT 100`, []);
    for (const intent of intents) await client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: WORKER_EXECUTION_WORKFLOW_NAME,
      workflowID: `v15-worker:${intent.id}`, appVersion: config.application_version }, [intent.id]);

    const stops = await sql.query<{ readonly id: import("../domain/primitives").ExecutionId }>(
      `SELECT id FROM oakridge.execution_intent WHERE stop_requested_at IS NOT NULL AND stop_completed_at IS NULL
       ORDER BY stop_requested_at LIMIT 100`, []);
    for (const intent of stops) {
      const stopped = await stopCohortExecution(sql, intent.id, workerSessionIO);
      if (!stopped.ok) console.warn(`worker execution ${intent.id}: ${stopped.error.detail}`);
    }
    return intents.length + stops.length;
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
    if (isPullRequestPollClosing || pullRequestTimer) return;
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
    operator_retry: { submit_request: async (envelope) => {
      const result = await stageEvents.advance(envelope.cohort_id, envelope);
      if (result.ok) {
        const cohorts = await sql.query<{ readonly run_id: WorkflowRunId }>("SELECT run_id::text FROM oakridge.cohort WHERE id=$1", [envelope.cohort_id]);
        if (cohorts[0]) await sendRunWakeHint(cohorts[0].run_id, `request:${envelope.id}`);
      }
      return result;
    } },
    run_lifecycle: { records: runRecords },
    domain_reads: { stages, artifacts, session_holds: projections, session_run_locations: projections },
    work_order_artifact_callback: { records: runRecords, enrich: enrichStagePublication,
      now, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: { refresh: async (cohort_id) => {
      const outcomes = await pollStagePullRequests({ sql, stage_events: stageEvents }, cohort_id);
      if (outcomes.some((outcome) => outcome.kind === "unavailable")) return { ok: false, error: {
        operation: "refresh_pull_request", cohort_id, detail: "GitHub pull request status is unavailable; try again later",
      } };
      const rows = await sql.query<{ readonly state: string }>(
        "SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]);
      return { ok: true, value: rows[0] ?? null };
    } },
    collaboration: { artifacts, collaboration, policy_for_artifact_type: collaborationPolicy,
      messages, message_recipients: messageRecipients,
      send_message: (input) => collaborationPings.enqueue(input),
      ping_thread: (input) => collaborationPings.enqueue(input) },
    operator_projections: projections,
    artifact_detail: { artifacts, stages, acceptance: artifacts, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES,
      review_context: async (revision) => {
        if (!revision.cohort_id) return { ok: true as const, value: null };
        const stage = await stages.find_by_id(revision.stage_instance_id);
        if (!stage) return { ok: true as const, value: null };
        const snapshot = await loadStageCohortContext(sql, revision.cohort_id, stage.stage_key as import("../domain/dev-flow-v15").StageKey);
        if (!snapshot.ok) throw new Error(snapshot.error.detail);
        let context = snapshot.value;
        if (context.stage === "final_integration" || context.stage === "implementation") {
          const observed = await observePr(revision.cohort_id);
          if (!observed.ok) return { ok: false as const, error: { detail: observed.error.detail } };
          context = { ...context, pr: observed.value };
        }
        const evaluation = await loadStageCohortEvaluation(sql, context);
        if (!evaluation.ok) throw new Error(evaluation.error.detail);
        return { ok: true as const, value: selectAvailableArtifactReviewContext(evaluation.value, { id: revision.chain_id, version: revision.version }) };
      } },
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
    pull_request_poll_interval_ms: pullRequestPollIntervalMs,
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
