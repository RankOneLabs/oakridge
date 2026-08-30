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
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import { PostgresArtifactRevisionRepository, PostgresStageInstanceRepository, PostgresWorkflowRunRepository } from "../storage/postgres-domain";
import { PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresCohortPullRequestRepository, PostgresCollaborationRepository, PostgresEpicWorkflowProfileRepository, PostgresFinalPullRequestRepository, PostgresGateDecisionAuditRepository } from "../storage/postgres-policy";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { requireV2CutoverDatabase } from "../storage/cutover";
import { findExecutorAdapter, registerExecutorAdapter } from "./executor-registry";
import { registerRunRecordWorkflowServices } from "../workflows/run-record-topology";
import "../workflows/collaboration-responder";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record";
import { DbosRunLaunchClient } from "./dbos-run-launch-client";
import { DbosCollaborationPingClient } from "./collaboration-ping";
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
  /** Drains the run launch outbox, starting each launched run's root workflow. */
  dispatch_launches(): Promise<number>;
  /** Writes the built-in workflow definitions. Safe to call repeatedly. */
  seed_builtins(): Promise<void>;
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
  const cutover = await requireV2CutoverDatabase(sql);
  if (!cutover.ok) {
    await sql.close();
    throw new Error(cutover.error.detail);
  }
  const client = await DBOSClient.create({ systemDatabaseUrl: config.database_url });

  const definitions = new PostgresWorkflowDefinitionRepository(sql);
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);
  const runRecords = new PostgresRunRecordRepository(sql, { load_prompt_template: (path) => promptTemplates.load(path) });
  const stages = new PostgresStageInstanceRepository(sql);
  const artifacts = new PostgresArtifactRevisionRepository(sql);
  const audits = new PostgresGateDecisionAuditRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const finalPullRequests = new PostgresFinalPullRequestRepository(sql);
  const epicProfiles = new PostgresEpicWorkflowProfileRepository(sql);
  const cohortReconciliations = new PostgresCohortPullRequestRepository(sql);
  const projections = new PostgresOperatorProjectionRepository(sql, config.application_version);

  const dbosRuns = new DbosRunLaunchClient(client);
  const collaborationPings = new DbosCollaborationPingClient(client, config.application_version);

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
  registerExecutorAdapter(new RepositoryProvisioningAdapter({
    git: config.git_commands ?? new BunGitCommandRunner(),
    publish_work_order: async (request) => {
      const result = await publishWorkOrderArtifact({ ...request, collection_key: null }, { records: runRecords, now });
      if (result.kind === "published" || result.kind === "pending" || result.kind === "already_applied") {
        await sendRunWakeHint(result.run_id, `provision:${result.run_id}:${result.record_version}`).catch(() => undefined);
      }
      return result;
    },
  }));
  // The wait table is the record of gate/handoff state; DBOS stays the command
  // mechanism, so the send functions above keep coming from the transport.
  registerRunRecordWorkflowServices({ records: runRecords, find_executor: findExecutorAdapter, now });

  const cohortPullRequests: CohortPullRequestDependencies = {
    runs, epic_profiles: epicProfiles, reconciliations: cohortReconciliations, records: runRecords, now, send_run_wake: sendRunWakeHint,
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
    run_lifecycle: { records: runRecords },
    domain_reads: { stages, artifacts, session_holds: projections },
    final_pull_requests: { final_pull_requests: finalPullRequests, now },
    work_order_artifact_callback: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    gate_resume: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    handoff_complete: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: cohortPullRequests,
    collaboration: { artifacts, collaboration, policy_for_artifact_type: collaborationPolicy, records: runRecords,
      send_run_wake: sendRunWakeHint, ping_thread: (input) => collaborationPings.enqueue(input) },
    operator_projections: projections,
    artifact_detail: { artifacts, stages, audits, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
    run_launch: { definitions, projects, runs, projections, start_run: (request) => dbosRuns.start_v2_run(request), application_version: config.application_version, now },
    rerun: { v2_cancellation: { records: runRecords, find_executor: findExecutorAdapter, now, send_run_wake: sendRunWakeHint } },
    ...(config.control_token ? { control_token: config.control_token } : {}),
  });

  return {
    app,
    dispatch_launches: dispatchLaunches,
    seed_builtins: () => seedBuiltins(definitions),
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
