import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import type { ArtifactRevision } from "../domain/artifacts";
import type { ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import type { WorkflowDefinition } from "../domain/workflow";
import type { ArtifactId, ExecutionId, JsonValue, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import { PgPostgresExecutor } from "../storage/sql-executor";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const applicationVersion = `${process.env.PROOF_APPLICATION_VERSION ?? "production-topology"}-${crypto.randomUUID()}`;
const proofSql = PgPostgresExecutor.connect(databaseUrl);
const proofServiceSql = PgPostgresExecutor.connect(databaseUrl);
const proofClient = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabasePoolSize: 50, systemDatabasePollingConcurrency: 1 });
await proofSql.query("CREATE TABLE IF NOT EXISTS public.oakridge_proof_execution (workflow_id text PRIMARY KEY, request jsonb NOT NULL)", []);
DBOS.setConfig({ name: "oakridge-production-proof", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });

const delegated = (sessionName: string, materialization: object = {}) => ({ runtime: "claude-code", prompt_template_path: `${sessionName}.md`, slot_bindings: {}, workdir: { from: "literal", value: "/tmp" }, session_name: `${sessionName}-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}`, ...materialization });
const definition: WorkflowDefinition = { id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db" as WorkflowDefinitionId, name: "production-proof", version: 1, created_at: "2026-08-14T00:00:00Z", archived: false, graph: { stages: {
  source: { stage_type: "delegated_session", operator_role: "plan", config: delegated("source"), inputs: [], outputs: [{ name: "plan", artifact_type: "proof.plan" }] },
  brief: { stage_type: "delegated_session", operator_role: "brief", config: delegated("brief", { artifacts: { over: { from: "input", input_name: "plan", path: "/cohorts" }, id_path: "/id" } }), inputs: [{ name: "plan", artifact_type: "proof.plan", optional: false, collect: false, delivery: "producer_complete" }], outputs: [{ name: "brief", artifact_type: "proof.brief" }] },
  build: { stage_type: "delegated_session", operator_role: "build", config: delegated("build", { fan_out: { over: { from: "input", input_name: "brief" }, unit_id_path: "/unit_id", depends_on_path: "/artifact/depends_on", max_parallel: 2 } }), inputs: [{ name: "brief", artifact_type: "proof.brief", optional: false, collect: false, delivery: "unit_complete" }], outputs: [{ name: "result", artifact_type: "proof.result" }] },
  assess: { stage_type: "delegated_session", operator_role: "assessment", config: delegated("assess", { fan_out: { over: { from: "input", input_name: "result" }, unit_id_path: "/unit_id", depends_on_path: null, max_parallel: 2 } }), inputs: [{ name: "result", artifact_type: "proof.result", optional: false, collect: false, delivery: "unit_complete" }], outputs: [{ name: "assessment", artifact_type: "proof.assessment" }] },
}, edges: [
  { from: { stage: "source", slot: "plan" }, to: { stage: "brief", slot: "plan" } },
  { from: { stage: "brief", slot: "brief" }, to: { stage: "build", slot: "brief" } },
  { from: { stage: "build", slot: "result" }, to: { stage: "assess", slot: "result" } },
] } };
const compiled = compileWorkflowDefinition(definition);
if (!compiled.ok) throw new Error(compiled.error.detail);

interface ProofExecutionRow { readonly workflow_id: string; readonly request: ExecutionRequest }
const terminalResolvers = new Map<ExecutionId, () => void>();
const adapter: ExecutorAdapter = {
  executor_type: "delegated_session",
  async start_or_attach() { return { kind: "none" }; },
  observe_terminal(executionId) { return new Promise((resolve) => terminalResolvers.set(executionId, () => resolve({ kind: "succeeded", metadata: {} }))); },
  async deliver_input() {},
  async cancel_or_fence(executionId) { terminalResolvers.get(executionId)?.(); },
};

const { registerExecutorAdapter } = await import("../workflows/executor-topology");
const { productionRunWorkflow, registerProductionTopologyServices } = await import("../workflows/production-topology");
registerExecutorAdapter(adapter);
registerProductionTopologyServices({
  async ensure_run() {},
  async load_compiled_definition() { return compiled.value; }, async load_prompt_template() { return "Run {{UNIT_ID}}"; },
  async start_stage() {}, async finish_stage() {}, async record_execution(input) {
    await proofServiceSql.query("INSERT INTO public.oakridge_proof_execution (workflow_id, request) VALUES ($1, $2::jsonb) ON CONFLICT (workflow_id) DO NOTHING", [input.execution_workflow_id, input.request]);
  },
  async replace_execution_projection() {},
  async load_resume_artifacts() { return []; },
});

const artifactBody = (request: ExecutionRequest, unitId: UnitId): JsonValue => {
  const session = (request.resolved_config as { readonly session_name?: string }).session_name ?? "";
  if (session.startsWith("source-")) return { cohorts: [{ id: "foundation" }, { id: "web" }] };
  if (session.startsWith("brief-")) return { cohort_id: unitId, depends_on: unitId === "web" ? ["foundation"] : [] };
  if (session.startsWith("build-")) return { repository_key: unitId, summary: "built" };
  return { verdict: "pass", unit_id: unitId };
};
const sendProofMessage = async (destinationId: string, message: unknown, idempotencyKey: string): Promise<void> => {
  await proofClient.send(destinationId, message, "execution-event", idempotencyKey);
};

await DBOS.launch();
try {
  const rootId = process.env.PROOF_WORKFLOW_ID ?? `production-proof-${crypto.randomUUID()}`;
  const handle = await DBOS.startWorkflow(productionRunWorkflow, { workflowID: rootId })({ run_id: crypto.randomUUID() as WorkflowRunId, workflow_definition_id: definition.id, workflow_definition_version: 1, context: {} });
  const emitted = new Set<string>();
  const deadline = Date.now() + 15_000;
  while (emitted.size < 6) {
    const pending = await proofSql.query<ProofExecutionRow>("SELECT workflow_id, request FROM public.oakridge_proof_execution WHERE workflow_id LIKE $1 ORDER BY workflow_id", [`${rootId}:%`]);
    for (const execution of pending) {
      if (emitted.has(execution.workflow_id)) continue;
      emitted.add(execution.workflow_id);
      console.error(`proof emitting ${execution.workflow_id} (${execution.request.expected_artifacts?.length ?? 0} artifacts)`);
      await Promise.all((execution.request.expected_artifacts ?? []).map(async (expected) => {
        const artifact: ArtifactRevision = { id: crypto.randomUUID() as ArtifactId, chain_id: crypto.randomUUID() as ArtifactId, run_id: "proof" as WorkflowRunId,
          stage_instance_id: execution.request.stage_instance_id, execution_id: execution.request.execution_id, unit_id: expected.unit_id, output_name: expected.output_name,
          artifact_type: expected.artifact_type, label: expected.unit_id, body: artifactBody(execution.request, expected.unit_id), version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: new Date().toISOString() };
        await sendProofMessage(execution.workflow_id, { kind: "artifact_emitted", release: { kind: "released", artifact } }, `proof:${artifact.id}`);
      }));
      console.error(`proof emitted ${execution.workflow_id}`);
    }
    if (Date.now() > deadline) throw new Error("production topology proof timed out");
    await Bun.sleep(50);
  }
  const result = await handle.getResult();
  const workflows = await DBOS.listWorkflows({ workflow_id_prefix: rootId, loadInput: false, loadOutput: false });
  console.log(JSON.stringify({ result, child_count: workflows.length - 1, workflows: workflows.map((workflow) => ({ id: workflow.workflowID, status: workflow.status, parent: workflow.parentWorkflowID })) }));
} finally {
  await DBOS.shutdown();
  await proofClient.destroy();
  await proofServiceSql.close();
  await proofSql.close();
}
