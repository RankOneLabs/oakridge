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

import { createDelegatedSessionCohortDriver } from "../adapters/delegated-session-cohort";
import { createDeterministicCohortDriver } from "../adapters/deterministic-cohort";
import { createDevFlowAdapterRegistry } from "../adapters/dev-flow";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE } from "../domain/repository-refs";
import { RepositoryProvisioningAdapter } from "../adapters/repository-provisioning";
import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { stageInstanceIdFor } from "../decision/ids";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../domain/artifact-types";
import type { ExecutorAdapter } from "../domain/execution";
import { err, type AttemptId, type CohortId, type JsonValue, type WorkflowRunId } from "../domain/primitives";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { InitializeStageInstance } from "../domain/run-record";
import { selectOrphanedVersionRuns, type OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { PromptBundleEntry } from "../domain/workflow";
import { parseWorkflowDefinition } from "../validation/workflow-definition";
import { STAGE_CONTRACT_DEPENDENCY_KEY } from "../storage/load-run-snapshot";
import { STAGE_CONTRACT_INPUT_EDGES_KEY } from "../domain/stage-contract";
import { verifyAndBindCohortPullRequest, type CohortPullRequestDependencies } from "./cohort-pull-request";
import { pollCohortPullRequests, type CohortPollOutcome, type PullRequestReader } from "./github-pull-requests";
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendCohortWakeHint, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import {
  PostgresArtifactRepository,
  PostgresCollaborationRepository,
  PostgresForgeRepositoryRepository,
  PostgresStageInstanceRepository,
  PostgresWorkflowRunRepository,
} from "../storage/postgres-domain";
import { PostgresDevFlowPullRequestRepository, PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresRunRecordWriter } from "../storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record-repository";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { findExecutorAdapter, registerExecutorAdapter } from "./executor-registry";
import { recordCohortAdapterEvent, registerRunRecordWorkflowServices, retryCohortThroughDriver, type CohortMachineDriver } from "../workflows/run-record-topology";
import "../workflows/collaboration-responder";
import { DbosRunLaunchClient } from "./dbos-run-launch-client";
import { DbosCollaborationPingClient, PostgresSessionMessageRecipientResolver, PostgresSessionMessageRepository } from "./collaboration-ping";
import { BunGitCommandRunner } from "./git-command-runner";
import { createPromptTemplateLoader } from "./prompt-template";
import { GitProjectRepositoryIdentityResolver } from "./project-identity";
import { dispatchRunLaunches } from "./run-launch-dispatch";
import { publishWorkOrderArtifact } from "./publish-work-order-artifact";

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
  poll_pull_requests(): Promise<readonly CohortPollOutcome[] | null>;
  readonly pull_request_poll_interval_ms: number | null;
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
  const definitions = new PostgresWorkflowDefinitionRepository(sql, adapterRegistry);
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);
  const writer = new PostgresRunRecordWriter(sql, adapterRegistry);
  const runRecords = new PostgresRunRecordRepository(sql, writer);
  const stages = new PostgresStageInstanceRepository(sql);
  const artifacts = new PostgresArtifactRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const forgeRepositories = new PostgresForgeRepositoryRepository(sql);
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
  const forgeReader = config.pull_request_reader ?? { read: async () => null };
  registerExecutorAdapter(new RepositoryProvisioningAdapter({
    git,
    publish_work_order: async (request) => {
      const result = await publishWorkOrderArtifact({
        attempt_id: request.work_order_id as unknown as AttemptId, capability: request.capability,
        output_name: request.output_name, collection_key: null, body: request.body,
        idempotency_key: request.idempotency_key,
      }, { records: runRecords, now });
      if (result.kind === "published" || result.kind === "pending" || result.kind === "already_applied") {
        await sendCohortWakeHint(result.cohort_id, `provision:${result.artifact_id}`).catch(() => undefined);
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
    const compiled = compileWorkflowDefinition(parsed.value);
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

  /**
   * One cohort driver per stage type.
   *
   * Registered rather than switched on: a stage type's roster and its advance
   * belong to whoever owns that stage type, and core carries the name through
   * durable records without closing over it. The two shipped types are the
   * agent-facing delegated session and the deterministic provisioning action.
   */
  const devFlowDriver = createDelegatedSessionCohortDriver({
    records: runRecords, pull_requests: pullRequests, git, load_prompt_bundle: promptBundleOf,
    verify_build_pull_request: async (input) => {
      const location = await runRecords.find_cohort_location(input.stage_instance_id, input.cohort_key as import("../domain/primitives").UnitId);
      const cohort = await pullRequests.find_cohort_for_unit(input.stage_instance_id, input.cohort_key as import("../domain/primitives").UnitId);
      if (!location || !cohort || location.cohort_id !== input.cohort_id) {
        return err({ operation: "verify_cohort_pull_request" as const, kind: "build_cohort_not_found" as const,
          detail: "stored build cohort is missing", current_verification_id: null });
      }
      const forgeRepository = await forgeRepositories.find_forge_repository(location.run_id, cohort.repository_key);
      if (!forgeRepository) return err({ operation: "verify_cohort_pull_request" as const,
        kind: "repository_mismatch" as const, detail: "run context has no forge identity for the build repository" });
      const verified = await verifyAndBindCohortPullRequest({ pull_requests: pullRequests,
        reader: forgeReader, git, now }, { cohort, forge_repository: forgeRepository,
        candidate_url: input.candidate_url, replace_verification_id: null });
      return verified.ok ? { ok: true, value: { pull_request_url: verified.value.pull_request_url,
        head_sha: verified.value.head_sha, binding: verified.value.binding } } : verified;
    },
  });
  const provisioningDriver = createDeterministicCohortDriver({
    records: runRecords, stage_type: PROVISION_REPOSITORY_REFS_STAGE_TYPE,
  });
  const drivers = new Map<string, CohortMachineDriver>(
    [devFlowDriver, provisioningDriver].map((driver) => [driver.stage_type, driver]));

  // The wait tables are the record of gate/handoff state; DBOS stays the
  // command mechanism, so the wake hints above keep coming from the transport.
  registerRunRecordWorkflowServices({
    records: runRecords, stages, artifacts, find_run_context: runContextOf,
    find_driver: (stage_type) => drivers.get(stage_type),
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
  const recordCohortEvent = async (cohort_id: CohortId, event: JsonValue): Promise<void> => {
    const outcome = await recordCohortAdapterEvent(cohort_id, event);
    if (!outcome.committed) return;
    await sendCohortWakeHint(cohort_id, `adapter_event:${cohort_id}:${outcome.status}`).catch(() => undefined);
  };

  // Without a forge reader nothing can be read, and every verification refuses
  // with `unreadable_pull_request` — which is exactly the documented no-token
  // backend, where an operator confirms merges through the same checked route.
  const cohortPullRequests: CohortPullRequestDependencies = {
    pull_requests: pullRequests, forge_repositories: forgeRepositories, reader: forgeReader,
    git, records: runRecords, now,
    record_build_event: (cohort_id, event) => recordCohortEvent(cohort_id, event as unknown as JsonValue),
    send_run_wake: sendRunWakeHint,
  };
  const pollPullRequests = (): Promise<readonly CohortPollOutcome[] | null> => {
    const reader = config.pull_request_reader;
    if (!reader) return Promise.resolve(null);
    return trackDispatch(() => pollCohortPullRequests({ ...cohortPullRequests, reader, list_cohorts: () => projections.list_cohorts() }));
  };
  let pullRequestPoll: Promise<unknown> | null = null;
  let isPullRequestPollClosing = false;
  let pullRequestTimer: ReturnType<typeof setInterval> | null = null;
  const startPullRequestTimer = (): void => {
    if (!config.pull_request_reader || isPullRequestPollClosing || pullRequestTimer) return;
    pullRequestTimer = setInterval(() => {
      if (pullRequestPoll) return;
      pullRequestPoll = pollPullRequests()
        .then((outcomes) => {
          for (const outcome of outcomes ?? []) {
            if (outcome.resolution.kind === "refused") console.warn(`cohort ${outcome.stage_instance_id}:${outcome.unit_id} pull request refused: ${outcome.resolution.detail}`);
          }
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
    operator_retry: { retry_through_driver: retryCohortThroughDriver },
    run_lifecycle: { records: runRecords },
    domain_reads: { stages, artifacts, session_holds: projections, session_run_locations: projections },
    work_order_artifact_callback: { records: runRecords, now, send_cohort_wake: sendCohortWakeHint, send_run_wake: sendRunWakeHint },
    gate_resume: { records: runRecords, now, send_cohort_wake: sendCohortWakeHint, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: cohortPullRequests,
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
