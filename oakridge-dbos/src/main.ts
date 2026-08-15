import { readFile } from "node:fs/promises";

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import { KbblExecutorAdapter } from "./adapters/kbbl";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "./domain/artifact-types";
import { createApp } from "./http/app";
import { getGateWorkflowState, getHandoffWorkflowState, registerDbosTransportClient, sendArtifactWorkflowMessage, sendGateWorkflowCommand, sendHandoffWorkflowCommand } from "./http/dbos-transport";
import { dispatchArtifactNotifications } from "./runtime/artifact-notifications";
import { cancelAttempt } from "./runtime/cancel-run";
import { DbosCancellationClient } from "./runtime/dbos-cancellation-client";
import { DbosStageRerunClient } from "./runtime/dbos-stage-rerun-client";
import { createProductionTopologyServices } from "./runtime/production-services";
import { seedBuiltins } from "./seed/seed-builtins";
import { PostgresArtifactRevisionRepository, PostgresCancellationTargetRepository, PostgresExecutionArtifactContextRepository, PostgresExecutionProjectionRepository, PostgresResumeArtifactRepository, PostgresRerunTargetRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository, PostgresWorkflowRunRepository } from "./storage/postgres-domain";
import { PostgresOperatorProjectionRepository } from "./storage/postgres-operators";
import { PostgresCollaborationRepository, PostgresGateDecisionAuditRepository } from "./storage/postgres-policy";
import { PostgresWorkflowDefinitionRepository } from "./storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "./storage/sql-executor";
import { registerArtifactLifecycleObserver, registerExecutionProjectionObserver, registerExecutorAdapter } from "./workflows/executor-topology";
import { registerProductionTopologyServices } from "./workflows/production-topology";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("DBOS_SYSTEM_DATABASE_URL");
const applicationVersion = required("DBOS_APPLICATION_VERSION");
const kbblBaseUrl = required("KBBL_BASE_URL");
const port = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: databaseUrl, applicationVersion });
const sql = PgPostgresExecutor.connect(databaseUrl);
const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });

const definitions = new PostgresWorkflowDefinitionRepository(sql);
const runs = new PostgresWorkflowRunRepository(sql);
const attempts = new PostgresWorkflowAttemptRepository(sql);
const stages = new PostgresStageInstanceRepository(sql);
const artifacts = new PostgresArtifactRevisionRepository(sql);
const contexts = new PostgresExecutionArtifactContextRepository(sql);
const executions = new PostgresExecutionProjectionRepository(sql);
const resumeArtifacts = new PostgresResumeArtifactRepository(sql);
const rerunTargets = new PostgresRerunTargetRepository(sql);
const cancellationTargets = new PostgresCancellationTargetRepository(sql);
const audits = new PostgresGateDecisionAuditRepository(sql);
const collaboration = new PostgresCollaborationRepository(sql);
const projections = new PostgresOperatorProjectionRepository(sql);
const now = () => new Date().toISOString();
const dbosRuns = new DbosStageRerunClient(client);
const dbosCancellation = new DbosCancellationClient(client);
const cancellation = { attempts, targets: cancellationTargets, dbos: dbosCancellation, now };

registerDbosTransportClient(client);
registerExecutorAdapter(new KbblExecutorAdapter({ base_url: kbblBaseUrl, executor_function_identity: applicationVersion }));
registerExecutionProjectionObserver(executions);
registerArtifactLifecycleObserver(artifacts);
registerProductionTopologyServices(createProductionTopologyServices({ definitions, runs, attempts, stages, executions, resume_artifacts: resumeArtifacts,
  load_prompt_template: (path) => readFile(path, "utf8") }));

await seedBuiltins(definitions);
await DBOS.launch();
const dispatchNotifications = () => dispatchArtifactNotifications(artifacts, { send: sendArtifactWorkflowMessage });
await dispatchNotifications();
let isDispatchingNotifications = false;
const notificationTimer = setInterval(() => {
  if (isDispatchingNotifications) return;
  isDispatchingNotifications = true;
  void dispatchNotifications().catch((error: unknown) => console.error("artifact notification dispatch failed", error)).finally(() => { isDispatchingNotifications = false; });
}, 1_000);

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
  definitions,
  artifact_callback: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
  artifact_withdraw: { contexts, artifacts, dispatch_notifications: dispatchNotifications },
  gate_resume: { contexts, artifacts, collaboration, audits, get_gate_state: getGateWorkflowState, send_gate_command: sendGateWorkflowCommand,
    get_handoff_state: getHandoffWorkflowState, send_handoff_command: sendHandoffWorkflowCommand },
  handoff_complete: { artifacts, contexts, get_handoff_state: getHandoffWorkflowState, send_handoff_command: sendHandoffWorkflowCommand },
  collaboration: { artifacts, contexts, collaboration, policy_for_artifact_type: collaborationPolicy, dispatch_notifications: dispatchNotifications },
  operator_projections: projections,
  artifact_detail: { artifacts, stages, audits, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
  run_launch: { definitions, dbos: dbosRuns, now },
  rerun: {
    targets: rerunTargets,
    dbos: client,
    cancellation,
    stage_rerun: { runs, attempts, definitions, dbos: dbosRuns, now,
      supersede_attempt: (root) => cancelAttempt(root, { targets: cancellationTargets, dbos: dbosCancellation, now }, "superseded by stage rerun") },
  },
});

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`Oakridge DBOS backend listening on ${server.url}`);

const shutdown = async () => {
  clearInterval(notificationTimer);
  server.stop();
  await DBOS.shutdown();
  await client.destroy();
  await sql.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
