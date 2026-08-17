import { resolve } from "node:path";

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import { KbblExecutorAdapter } from "./adapters/kbbl";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "./domain/artifact-types";
import { createApp } from "./http/app";
import { selectControlPlaneAccess } from "./http/control-auth";
import { getGateWorkflowState, getHandoffWorkflowState, getStageAdmissionState, registerDbosTransportClient, sendArtifactWorkflowMessage, sendGateWorkflowCommand, sendHandoffWorkflowCommand, sendStageCommand } from "./http/dbos-transport";
import { dispatchArtifactNotifications } from "./runtime/artifact-notifications";
import { cancelAttempt } from "./runtime/cancel-run";
import { DbosCancellationClient } from "./runtime/dbos-cancellation-client";
import { DbosStageRerunClient } from "./runtime/dbos-stage-rerun-client";
import { createProductionTopologyServices } from "./runtime/production-services";
import { seedBuiltins } from "./seed/seed-builtins";
import { PostgresArtifactRevisionRepository, PostgresCancellationTargetRepository, PostgresExecutionArtifactContextRepository, PostgresExecutionProjectionRepository, PostgresResumeArtifactRepository, PostgresRerunTargetRepository, PostgresStageAdmissionTargetRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository, PostgresWorkflowRunRepository } from "./storage/postgres-domain";
import { DEFAULT_STALL_THRESHOLD_SECONDS, PostgresOperatorProjectionRepository } from "./storage/postgres-operators";
import { PostgresCollaborationRepository, PostgresFinalPullRequestRepository, PostgresGateDecisionAuditRepository } from "./storage/postgres-policy";
import { PostgresWorkflowDefinitionRepository } from "./storage/postgres-workflow-definitions";
import { PostgresProjectRepository } from "./storage/postgres-projects";
import { GitProjectRepositoryIdentityResolver } from "./runtime/project-identity";
import { dispatchRunLaunches } from "./runtime/run-launch-notifications";
import { createPromptTemplateLoader } from "./runtime/prompt-template";
import { DbosCollaborationPingClient } from "./runtime/collaboration-ping";
import { PgPostgresExecutor } from "./storage/sql-executor";
import { registerArtifactLifecycleObserver, registerExecutionProjectionObserver, registerExecutorAdapter } from "./workflows/executor-topology";
import { registerProductionTopologyServices } from "./workflows/production-topology";
import { registerCancellationControlServices } from "./workflows/cancellation";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("DBOS_SYSTEM_DATABASE_URL");
const applicationVersion = required("DBOS_APPLICATION_VERSION");
const kbblBaseUrl = required("KBBL_BASE_URL");
const host = process.env.OAKRIDGE_DBOS_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
const controlAccess = selectControlPlaneAccess({
  host,
  token: process.env.OAKRIDGE_CONTROL_TOKEN,
  allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1",
});
if (controlAccess.kind === "refused") throw new Error(controlAccess.detail);
const stallThresholdSeconds = Number(process.env.OAKRIDGE_STALL_THRESHOLD_SECONDS ?? String(DEFAULT_STALL_THRESHOLD_SECONDS));
if (!Number.isFinite(stallThresholdSeconds) || stallThresholdSeconds <= 0) throw new Error("OAKRIDGE_STALL_THRESHOLD_SECONDS must be a positive number of seconds");

DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: databaseUrl, applicationVersion });
const sql = PgPostgresExecutor.connect(databaseUrl);
const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });

const definitions = new PostgresWorkflowDefinitionRepository(sql);
const projects = new PostgresProjectRepository(sql);
const projectIdentity = new GitProjectRepositoryIdentityResolver();
const runs = new PostgresWorkflowRunRepository(sql);
const attempts = new PostgresWorkflowAttemptRepository(sql);
const stages = new PostgresStageInstanceRepository(sql);
const admissionTargets = new PostgresStageAdmissionTargetRepository(sql);
const artifacts = new PostgresArtifactRevisionRepository(sql);
const contexts = new PostgresExecutionArtifactContextRepository(sql);
const executions = new PostgresExecutionProjectionRepository(sql);
const resumeArtifacts = new PostgresResumeArtifactRepository(sql);
const rerunTargets = new PostgresRerunTargetRepository(sql);
const cancellationTargets = new PostgresCancellationTargetRepository(sql);
const audits = new PostgresGateDecisionAuditRepository(sql);
const collaboration = new PostgresCollaborationRepository(sql);
const finalPullRequests = new PostgresFinalPullRequestRepository(sql);
const projections = new PostgresOperatorProjectionRepository(sql, { stall_threshold_seconds: stallThresholdSeconds });
const now = () => new Date().toISOString();
const dbosRuns = new DbosStageRerunClient(client);
const dbosCancellation = new DbosCancellationClient(client);
const collaborationPings = new DbosCollaborationPingClient(client, applicationVersion);
const cancellation = { attempts, targets: cancellationTargets, dbos: dbosCancellation, now };
const promptTemplates = createPromptTemplateLoader(resolve(import.meta.dir, "../../oakridge-core/prompts"));

registerDbosTransportClient(client);
registerExecutorAdapter(new KbblExecutorAdapter({ base_url: kbblBaseUrl, executor_function_identity: applicationVersion }));
registerExecutionProjectionObserver(executions);
registerArtifactLifecycleObserver(artifacts);
registerCancellationControlServices({
  list_execution_targets: (root) => cancellationTargets.list_for_attempt(root),
  terminalize_pending_waits: (root, reason, at) => cancellationTargets.terminalize_pending_waits(root, "workflow_cancellation", reason ?? "workflow cancelled", at),
  finish_started_stages: (root, at, reason) => cancellationTargets.finish_started_stages(root, at, reason),
});
registerProductionTopologyServices(createProductionTopologyServices({ definitions, runs, attempts, stages, executions, rerun_targets: rerunTargets, resume_artifacts: resumeArtifacts,
  load_prompt_template: (path) => promptTemplates.load(path) }));

await seedBuiltins(definitions);
await DBOS.launch();

// HTTP handlers and the periodic workers share these dispatch functions. Keep
// every invocation in the same in-flight set so shutdown cannot close the SQL
// pool while a request-triggered dispatcher is still using it.
const inFlightDispatches = new Set<Promise<unknown>>();
let isDispatchClosing = false;
const trackDispatch = <T>(operation: () => Promise<T>): Promise<T> => {
  if (isDispatchClosing) {
    return Promise.reject(new Error("Oakridge is shutting down; durable dispatch remains queued"));
  }
  const pending = operation();
  inFlightDispatches.add(pending);
  void pending.finally(() => inFlightDispatches.delete(pending)).catch(() => undefined);
  return pending;
};
const dispatchNotifications = () => trackDispatch(
  () => dispatchArtifactNotifications(artifacts, { send: sendArtifactWorkflowMessage }),
);
const dispatchLaunches = () => trackDispatch(() => dispatchRunLaunches(runs, dbosRuns));
await dispatchNotifications();
await dispatchLaunches();
let notificationDispatch: Promise<unknown> | null = null;
const notificationTimer = setInterval(() => {
  if (notificationDispatch) return;
  notificationDispatch = dispatchNotifications()
    .catch((error: unknown) => { console.error("artifact notification dispatch failed", error); })
    .finally(() => { notificationDispatch = null; });
}, 1_000);
let launchDispatch: Promise<unknown> | null = null;
const launchTimer = setInterval(() => {
  if (launchDispatch) return;
  launchDispatch = dispatchLaunches()
    .catch((error: unknown) => { console.error("run launch dispatch failed", error); })
    .finally(() => { launchDispatch = null; });
}, 1_000);

// The outbox is polled every second by both dispatchers, so delivered rows left
// in place turn a bounded working set into a table that only ever grows. Swept
// on its own slow timer: the retention window keeps a day of dispatch history,
// which is what an operator would want to look back at, and no more.
const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1_000;
const OUTBOX_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
let outboxPurge: Promise<unknown> | null = null;
const outboxPurgeTimer = setInterval(() => {
  if (outboxPurge) return;
  outboxPurge = artifacts.purge_delivered_commands(new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString())
    .catch((error: unknown) => { console.error("command outbox purge failed", error); })
    .finally(() => { outboxPurge = null; });
}, OUTBOX_PURGE_INTERVAL_MS);

const presentation = (artifactType: string) => {
  const definition = findArtifactType(artifactType);
  return definition ? { component_id: definition.component_id, capabilities: definition.capabilities,
    anchor_schema: definition.anchor_schema, review: definition.review as unknown as import("./domain/primitives").JsonValue } : null;
};
const collaborationPolicy = (artifactType: string) => {
  const definition = findArtifactType(artifactType);
  return definition ? { commentable: definition.capabilities.commentable, review_items: definition.capabilities.review_items,
    atom_editable: definition.capabilities.atom_editable, anchor_schema: definition.anchor_schema } : null;
};
const app = createApp({
  configuration: { projects, definitions, project_identity: projectIdentity, now },
  admission: { targets: admissionTargets, get_admission_state: getStageAdmissionState, send_stage_command: sendStageCommand },
  run_lifecycle: { runs },
  domain_reads: { stages, artifacts },
  final_pull_requests: { final_pull_requests: finalPullRequests, now },
  artifact_callback: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
  artifact_withdraw: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
  gate_resume: { contexts, artifacts, collaboration, audits, get_gate_state: getGateWorkflowState, send_gate_command: sendGateWorkflowCommand,
    get_handoff_state: getHandoffWorkflowState, send_handoff_command: sendHandoffWorkflowCommand },
  handoff_complete: { artifacts, contexts, get_handoff_state: getHandoffWorkflowState, send_handoff_command: sendHandoffWorkflowCommand },
  collaboration: { artifacts, contexts, executions, collaboration, policy_for_artifact_type: collaborationPolicy,
    ping_thread: (input) => collaborationPings.enqueue(input), dispatch_notifications: dispatchNotifications },
  operator_projections: projections,
  artifact_detail: { artifacts, stages, audits, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
  run_launch: { definitions, projects, runs, projections, dispatch_launches: dispatchLaunches, application_version: applicationVersion, now },
  rerun: {
    stages,
    targets: rerunTargets,
    dbos: client,
    cancellation,
    stage_rerun: { runs, attempts, definitions, dbos: dbosRuns, now,
      supersede_attempt: (root) => cancelAttempt(root, { dbos: dbosCancellation, now }, "superseded by stage rerun") },
  },
  ...(controlAccess.kind === "token_required" ? { control_token: controlAccess.token } : {}),
});

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 255,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/events") {
      bunServer.timeout(request, 0);
    }
    return app.fetch(request);
  },
});
console.log(`Oakridge DBOS backend listening on ${server.url}`);

let shutdownPromise: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    isDispatchClosing = true;
    clearInterval(notificationTimer);
    clearInterval(launchTimer);
    clearInterval(outboxPurgeTimer);
    server.stop();
    // clearInterval stops the next purge from starting; it does not settle one
    // already running, which would still be holding a connection when SQL closes.
    await Promise.allSettled([...inFlightDispatches, ...(outboxPurge ? [outboxPurge] : [])]);
    await DBOS.shutdown();
    await client.destroy();
    await sql.close();
  })();
  return shutdownPromise;
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
