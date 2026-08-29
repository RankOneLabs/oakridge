/**
 * How an Oakridge backend is assembled.
 *
 * This used to live inline in `src/main.ts`, which meant the composition was a
 * script rather than a value: nothing but the process could build it, so
 * nothing but the process ever ran the real repositories, the real outbox
 * dispatchers and the real HTTP routes together. Every test above unit scope
 * had to rebuild a smaller, differently-shaped system out of stubs — and the
 * defects this project keeps shipping live exactly in the seams those stubs
 * paper over.
 *
 * `main.ts` is now the process wrapper: environment, listener, timers, signals.
 * Everything that decides what the backend *is* happens here, once, for both
 * the process and the end-to-end tests.
 */
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";

import { RepositoryProvisioningAdapter } from "../adapters/repository-provisioning";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../domain/artifact-types";
import type { ExecutorAdapter } from "../domain/execution";
import type { JsonValue } from "../domain/primitives";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { selectOrphanedVersionRuns, type OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { CohortPullRequestDependencies } from "./cohort-pull-request";
import { pollCohortPullRequests, type CohortPollOutcome, type PullRequestReader } from "./github-pull-requests";
import type { ArtifactId } from "../domain/primitives";
import { selectGateStateView, selectHandoffStateView, type GateWorkflowState, type HandoffWorkflowState } from "../domain/wait";
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendArtifactWorkflowMessage, sendGateWorkflowCommand, sendHandoffWorkflowCommand, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import { PostgresArtifactRevisionRepository, PostgresCancellationTargetRepository, PostgresExecutionArtifactContextRepository, PostgresExecutionProjectionRepository, PostgresResumeArtifactRepository, PostgresRerunTargetRepository, PostgresSessionHoldRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository, PostgresWorkflowRunRepository } from "../storage/postgres-domain";
import { DEFAULT_STALL_THRESHOLD_SECONDS, PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresCohortPullRequestRepository, PostgresCollaborationRepository, PostgresEpicWorkflowProfileRepository, PostgresFinalPullRequestRepository, PostgresGateDecisionAuditRepository } from "../storage/postgres-policy";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresWaitRepository } from "../storage/postgres-wait";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { registerCancellationControlServices } from "../workflows/cancellation";
import { registerWaitRepository } from "../workflows/wait-record";
import { registerArtifactLifecycleObserver, registerExecutionProjectionObserver, registerExecutorAdapter } from "../workflows/executor-topology";
import { findExecutorAdapter } from "../workflows/executor-topology";
import { registerRunRecordWorkflowServices } from "../workflows/run-record-topology";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record";
import { registerProductionTopologyServices } from "../workflows/production-topology";
import { dispatchArtifactNotifications } from "./artifact-notifications";
import { cancelAttempt } from "./cancel-run";
import { DbosCancellationClient } from "./dbos-cancellation-client";
import { DbosStageRerunClient } from "./dbos-stage-rerun-client";
import { DbosCollaborationPingClient } from "./collaboration-ping";
import { emitExecutionArtifact } from "./emit-artifact";
import { BunGitCommandRunner } from "./git-command-runner";
import { createProductionTopologyServices } from "./production-services";
import { createPromptTemplateLoader } from "./prompt-template";
import { GitProjectRepositoryIdentityResolver } from "./project-identity";
import { dispatchRunLaunches } from "./run-launch-notifications";

export interface OakridgeRuntimeConfig {
  readonly database_url: string;
  /**
   * Scopes DBOS workflow recovery. Also stamped on enqueued run launches, so a
   * launch is only picked up by a backend of the same version.
   */
  readonly application_version: string;
  /**
   * How a unit's work actually gets done, one adapter per stage type. The
   * agent-facing one is the collaborator a test replaces; the deterministic
   * repository provisioner is built here, because it publishes its artifact
   * through the same transform the emit route uses and only this composition
   * holds the repositories that transform needs.
   */
  readonly executor_adapters: readonly ExecutorAdapter[];
  readonly prompt_template_directory: string;
  /** Bearer token required on state-changing requests; absent on a loopback bind. */
  readonly control_token?: string;
  readonly stall_threshold_seconds?: number;
  /**
   * Runs the git commands the provisioning stage needs. Defaults to real
   * subprocesses; a test supplies its own to drive the sequencing without a
   * checkout, though the end-to-end suite deliberately uses the real one.
   */
  readonly git_commands?: GitCommandRunner;
  /**
   * Reads the pull requests cohorts are waiting on. Absent when the backend has
   * no credentials for the forge, in which case nothing polls and an operator
   * confirms merges by hand through the same route.
   */
  readonly pull_request_reader?: PullRequestReader;
  readonly now?: () => string;
}

export interface OakridgeRuntime {
  readonly app: Hono;
  /** Drains the artifact notification outbox into the workflows waiting on it. */
  dispatch_notifications(): Promise<number>;
  /** Drains the run launch outbox, starting each launched run's root workflow. */
  dispatch_launches(): Promise<number>;
  /** Writes the built-in workflow definitions. Safe to call repeatedly. */
  seed_builtins(): Promise<void>;
  /** Deletes delivered outbox rows older than the retention window. */
  purge_outbox(older_than: string): Promise<number>;
  /**
   * Asks the forge about every cohort parked on its pull request, and closes
   * the waits whose pull requests have merged. Resolves to null when no reader
   * is configured, which is a backend where merges are confirmed by hand.
   */
  poll_pull_requests(): Promise<readonly CohortPollOutcome[] | null>;
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
  const now = config.now ?? (() => new Date().toISOString());
  const sql = PgPostgresExecutor.connect(config.database_url);
  const client = await DBOSClient.create({ systemDatabaseUrl: config.database_url });

  const definitions = new PostgresWorkflowDefinitionRepository(sql);
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const runRecords = new PostgresRunRecordRepository(sql);
  const attempts = new PostgresWorkflowAttemptRepository(sql);
  const stages = new PostgresStageInstanceRepository(sql);
  const artifacts = new PostgresArtifactRevisionRepository(sql);
  const contexts = new PostgresExecutionArtifactContextRepository(sql);
  const executions = new PostgresExecutionProjectionRepository(sql);
  const resumeArtifacts = new PostgresResumeArtifactRepository(sql);
  const rerunTargets = new PostgresRerunTargetRepository(sql);
  const cancellationTargets = new PostgresCancellationTargetRepository(sql);
  const waits = new PostgresWaitRepository(sql);
  const sessionHolds = new PostgresSessionHoldRepository(sql, config.application_version);
  const audits = new PostgresGateDecisionAuditRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const finalPullRequests = new PostgresFinalPullRequestRepository(sql);
  const epicProfiles = new PostgresEpicWorkflowProfileRepository(sql);
  const cohortReconciliations = new PostgresCohortPullRequestRepository(sql);
  const projections = new PostgresOperatorProjectionRepository(sql, { stall_threshold_seconds: config.stall_threshold_seconds ?? DEFAULT_STALL_THRESHOLD_SECONDS });

  const dbosRuns = new DbosStageRerunClient(client);
  const dbosCancellation = new DbosCancellationClient(client);
  const collaborationPings = new DbosCollaborationPingClient(client, config.application_version);
  const cancellation = { attempts, targets: cancellationTargets, dbos: dbosCancellation, now };
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);

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
  const dispatchNotifications = () => trackDispatch(() => dispatchArtifactNotifications(artifacts, { send: sendArtifactWorkflowMessage }));
  const dispatchLaunches = () => trackDispatch(() => dispatchRunLaunches(runs, dbosRuns));

  registerDbosTransportClient(client);
  for (const adapter of config.executor_adapters) registerExecutorAdapter(adapter);
  registerExecutorAdapter(new RepositoryProvisioningAdapter({
    git: config.git_commands ?? new BunGitCommandRunner(),
    emit: (request) => emitExecutionArtifact({ contexts, artifacts, dispatch_notifications: dispatchNotifications }, request),
  }));
  registerExecutionProjectionObserver(executions);
  registerArtifactLifecycleObserver(artifacts);
  registerWaitRepository(waits);
  registerCancellationControlServices({
    list_execution_targets: (root) => cancellationTargets.list_for_attempt(root),
    terminalize_pending_waits: (root, reason, at) => cancellationTargets.terminalize_pending_waits(root, "workflow_cancellation", reason ?? "workflow cancelled", at),
    finish_started_stages: (root, at, reason) => cancellationTargets.finish_started_stages(root, at, reason),
    count_open_waits: (command_workflow_id) => waits.count_open_waits(command_workflow_id),
    close_orphaned_waits: (command_workflow_id, at) => waits.close_orphaned(command_workflow_id, at),
  });
  // The wait table is the record of gate/handoff state; DBOS stays the command
  // mechanism, so the send functions above keep coming from the transport.
  const getGateState = async (artifact_revision_id: ArtifactId, gate_step: string, execution_workflow_id: string): Promise<GateWorkflowState | null> =>
    selectGateStateView(await waits.find_gate_wait(artifact_revision_id, gate_step, execution_workflow_id));
  const getHandoffState = async (artifact_id: ArtifactId, execution_workflow_id: string): Promise<HandoffWorkflowState | null> =>
    selectHandoffStateView(await waits.find_handoff_waits(artifact_id, execution_workflow_id));
  registerProductionTopologyServices(createProductionTopologyServices({ definitions, runs, attempts, stages, executions, rerun_targets: rerunTargets,
    resume_artifacts: resumeArtifacts, waits, load_prompt_template: (path) => promptTemplates.load(path) }));
  registerRunRecordWorkflowServices({ records: runRecords, find_executor: findExecutorAdapter, now });

  const cohortPullRequests: CohortPullRequestDependencies = {
    runs, epic_profiles: epicProfiles, contexts, artifacts, reconciliations: cohortReconciliations,
    get_handoff_state: getHandoffState, send_handoff_command: sendHandoffWorkflowCommand, now,
  };
  const pollPullRequests = (): Promise<readonly CohortPollOutcome[] | null> => {
    const reader = config.pull_request_reader;
    if (!reader) return Promise.resolve(null);
    return trackDispatch(() => pollCohortPullRequests({ ...cohortPullRequests, reader, list_cohorts: () => projections.list_cohorts() }));
  };

  const presentation = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { component_id: definition.component_id, capabilities: definition.capabilities,
      anchor_schema: definition.anchor_schema, review: definition.review as unknown as JsonValue } : null;
  };
  const collaborationPolicy = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { commentable: definition.capabilities.commentable, review_items: definition.capabilities.review_items,
      atom_editable: definition.capabilities.atom_editable, anchor_schema: definition.anchor_schema } : null;
  };

  const app = createApp({
    configuration: { projects, definitions, project_identity: projectIdentity, now },
    admission: { records: runRecords, now },
    operator_retry: { records: runRecords, now },
    run_lifecycle: { runs },
    domain_reads: { stages, artifacts, session_holds: sessionHolds },
    final_pull_requests: { final_pull_requests: finalPullRequests, now },
    artifact_callback: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
    work_order_artifact_callback: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    artifact_withdraw: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
    gate_resume: { contexts, artifacts, collaboration, audits, get_gate_state: getGateState, send_gate_command: sendGateWorkflowCommand,
      get_handoff_state: getHandoffState, send_handoff_command: sendHandoffWorkflowCommand, records: runRecords, now, send_run_wake: sendRunWakeHint },
    handoff_complete: { artifacts, contexts, get_handoff_state: getHandoffState, send_handoff_command: sendHandoffWorkflowCommand, records: runRecords, now, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: cohortPullRequests,
    collaboration: { artifacts, contexts, executions, collaboration, policy_for_artifact_type: collaborationPolicy,
      ping_thread: (input) => collaborationPings.enqueue(input), dispatch_notifications: dispatchNotifications },
    operator_projections: projections,
    artifact_detail: { artifacts, stages, audits, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
    run_launch: { definitions, projects, runs, projections, dispatch_launches: dispatchLaunches, application_version: config.application_version, now },
    rerun: {
      stages, targets: rerunTargets, dbos: client, cancellation,
      stage_rerun: { runs, attempts, definitions, dbos: dbosRuns, now,
        supersede_attempt: (root) => cancelAttempt(root, { dbos: dbosCancellation, now }, "superseded by stage rerun") },
    },
    ...(config.control_token ? { control_token: config.control_token } : {}),
  });

  return {
    app,
    dispatch_notifications: dispatchNotifications,
    dispatch_launches: dispatchLaunches,
    seed_builtins: () => seedBuiltins(definitions),
    purge_outbox: (olderThan) => artifacts.purge_delivered_commands(olderThan),
    poll_pull_requests: pollPullRequests,
    async orphaned_version_runs() {
      return selectOrphanedVersionRuns(await projections.list_application_versions(), config.application_version);
    },
    async close() {
      isDispatchClosing = true;
      await Promise.allSettled([...inFlightDispatches]);
      await client.destroy();
      await sql.close();
    },
  };
};
