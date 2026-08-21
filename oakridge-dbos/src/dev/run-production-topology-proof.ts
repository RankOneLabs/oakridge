import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import { RepositoryProvisioningAdapter } from "../adapters/repository-provisioning";
import type { ArtifactRevision } from "../domain/artifacts";
import type { ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import type { ArtifactId, ExecutionId, JsonValue, UnitId, WaitId, WorkflowRunId } from "../domain/primitives";
import type { Wait, WaitClosesOn, WaitKind, WaitOutcome } from "../domain/wait";
import { loadDevFlowV14 } from "../seed/dev-flow-v14";
import { PgPostgresExecutor } from "../storage/sql-executor";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const applicationVersion = `${process.env.PROOF_APPLICATION_VERSION ?? "production-topology"}-${crypto.randomUUID()}`;
const proofSql = PgPostgresExecutor.connect(databaseUrl);
const proofServiceSql = PgPostgresExecutor.connect(databaseUrl);
await proofSql.query("CREATE TABLE IF NOT EXISTS public.oakridge_proof_execution (workflow_id text PRIMARY KEY, request jsonb NOT NULL)", []);
DBOS.setConfig({ name: "oakridge-production-proof", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });

const loaded = await loadDevFlowV14();
if (!loaded.ok) throw new Error(loaded.error.detail);
const definition = loaded.value;

/** Where the proof's repository pretends its epic branch already points. */
const PROOF_EPIC_HEAD = "0000000000000000000000000000000000000000";

interface ProofExecutionRow { readonly workflow_id: string; readonly request: ExecutionRequest }
const terminalResolvers = new Map<ExecutionId, () => void>();
const adapter: ExecutorAdapter = {
  executor_type: "delegated_session",
  async start_or_attach() { return { kind: "none" }; },
  observe_terminal(executionId) { return new Promise((resolve) => terminalResolvers.set(executionId, () => resolve({ kind: "terminal", observation: { kind: "succeeded", metadata: {} } }))); },
  async deliver_input() {},
  async cancel_or_fence(executionId) { terminalResolvers.get(executionId)?.(); },
};

/**
 * The provisioning stage, with git already having done its part.
 *
 * This proof is about the topology — what runs when, and what it is handed —
 * so the repository is taken as already provisioned. Emission is left to the
 * proof loop below, which publishes every recorded execution's expected
 * artifacts through one path; the adapter emitting as well would open a second.
 */
const provisioningAdapter = new RepositoryProvisioningAdapter({
  git: {
    async run(_path, args) {
      if (args[0] === "ls-remote") return { exit_code: 0, stdout: `${PROOF_EPIC_HEAD}\trefs/heads/epic/proof\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { exit_code: 0, stdout: `${PROOF_EPIC_HEAD}\n`, stderr: "" };
      return { exit_code: 0, stdout: "", stderr: "" };
    },
  },
  async emit() { return { ok: true, value: { artifact: { id: "proof" } as never, release: { kind: "released", artifact: {} as never }, superseded_artifact_id: null } }; },
});

const { registerExecutorAdapter } = await import("../workflows/executor-topology");
const { registerArtifactLifecycleObserver } = await import("../workflows/executor-topology");
const { registerWaitRepository } = await import("../workflows/wait-record");
const { productionRunWorkflow, registerProductionTopologyServices } = await import("../workflows/production-topology");
registerExecutorAdapter(adapter);
registerExecutorAdapter(provisioningAdapter);
const artifactState = new Map<ArtifactId, ArtifactRevision>();
registerArtifactLifecycleObserver({
  async find_by_id(id) { return artifactState.get(id) ?? null; },
  async mark_released(id, released_at) {
    const artifact = artifactState.get(id);
    if (!artifact) return { kind: "not_current", artifact_id: id };
    if (artifact.lifecycle.kind === "released") return { kind: "already_released", artifact };
    if (artifact.lifecycle.kind !== "current") return { kind: "not_current", artifact_id: id };
    const released = { ...artifact, lifecycle: { kind: "released" as const, released_at } };
    artifactState.set(id, released);
    return { kind: "released", artifact: released };
  },
});
// In-memory wait rows, keyed like the table's replay-idempotency index. Every
// §1 column arrives in the open input, so there is nothing to resolve.
const waitKey = (command_workflow_id: string, kind: WaitKind): string => `${command_workflow_id}|${kind}`;
const waitState = new Map<string, Wait>();
const openWait = (row: Omit<Wait, "id" | "closes_on" | "status" | "opened_at">, kind: WaitKind, closes_on: WaitClosesOn): void => {
  const key = waitKey(row.command_workflow_id, kind);
  if (waitState.has(key)) return;
  waitState.set(key, { ...row, id: crypto.randomUUID() as WaitId, closes_on, status: { kind: "open" }, opened_at: new Date().toISOString() });
};
const closeWait = (command_workflow_id: string, kind: WaitKind, outcome: WaitOutcome): void => {
  const key = waitKey(command_workflow_id, kind);
  const existing = waitState.get(key);
  if (!existing) throw new Error(`no '${kind}' wait is recorded for workflow '${command_workflow_id}'`);
  waitState.set(key, { ...existing, status: { kind: "closed", outcome, closed_at: new Date().toISOString() } });
};
registerWaitRepository({
  async open_gate(input) {
    openWait(input, "gate", { kind: "gate", gate_step: input.gate_step, actions: input.actions });
  },
  async open_handoff_downstream(input) {
    openWait(input, "handoff_downstream", { kind: "handoff_downstream", downstream_role: input.downstream_role });
  },
  async close(command_workflow_id, kind, outcome) { closeWait(command_workflow_id, kind, outcome); },
  async release_downstream(command_workflow_id, decided_outcome, external_closes_on) {
    closeWait(command_workflow_id, "handoff_downstream", decided_outcome);
    const downstream = waitState.get(waitKey(command_workflow_id, "handoff_downstream"))!;
    openWait(downstream, "handoff_external", external_closes_on);
  },
  async find_gate_wait(artifact_revision_id, gate_step, execution_workflow_id) {
    return [...waitState.values()].find((wait) => wait.artifact_revision_id === artifact_revision_id
      && wait.closes_on.kind === "gate" && wait.closes_on.gate_step === gate_step
      && wait.execution_workflow_id === execution_workflow_id) ?? null;
  },
  async find_handoff_waits(artifact_revision_id, execution_workflow_id) {
    return [...waitState.values()].filter((wait) => wait.artifact_revision_id === artifact_revision_id
      && wait.closes_on.kind !== "gate" && wait.execution_workflow_id === execution_workflow_id);
  },
  async count_open_waits(command_workflow_id) {
    return [...waitState.values()].filter((wait) => wait.command_workflow_id === command_workflow_id && wait.status.kind === "open").length;
  },
  async close_orphaned(command_workflow_id, at) {
    for (const [key, wait] of waitState) {
      if (wait.command_workflow_id !== command_workflow_id || wait.status.kind !== "open") continue;
      waitState.set(key, { ...wait, status: { kind: "closed", outcome: { kind: "withdrawn" }, closed_at: at } });
    }
  },
});
registerProductionTopologyServices({
  async ensure_run() {},
  async finish_run() {},
  async find_external_reference() { return { kind: "none" }; },
  async load_compiled_definition(id, version) {
    if (id !== definition.id || version !== definition.version) throw new Error("proof requested the wrong seeded definition");
    const { compileWorkflowDefinition } = await import("../compiler/compile-workflow");
    const compiled = compileWorkflowDefinition(definition);
    if (!compiled.ok) throw new Error(compiled.error.detail);
    return compiled.value;
  },
  async load_prompt_template(path) { return Bun.file(new URL(`../../../oakridge-core/prompts/${path}`, import.meta.url)).text(); },
  async start_stage() {}, async finish_stage() {}, async record_execution(input) {
    await proofServiceSql.query("INSERT INTO public.oakridge_proof_execution (workflow_id, request) VALUES ($1, $2::jsonb) ON CONFLICT (workflow_id) DO NOTHING", [input.execution_workflow_id, JSON.stringify(input.request)]);
  },
  async replace_execution_projection() {},
  async load_resume_artifacts() { return []; },
});

const artifactBody = (request: ExecutionRequest, unitId: UnitId): JsonValue => {
  if (request.executor_type === "provision_repository_refs") {
    return { repository_key: String(unitId), repository_path: "/tmp", integration_branch: "main", base_branch: "epic/proof", base_head_sha: PROOF_EPIC_HEAD };
  }
  const session = (request.resolved_config as { readonly session_name?: string }).session_name ?? "";
  if (session.startsWith("spec-analyzer-")) return { requirements: [{ id: "R1", description: "proof" }] };
  if (session.startsWith("plan-writer-")) return { cohorts: [{ id: "foundation" }, { id: "web" }] };
  if (session.startsWith("brief-writer-")) return { cohort_id: unitId, repository_key: "oakridge", title: String(unitId), goal: "proof", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["passes"], depends_on: unitId === "web" ? ["foundation"] : [] };
  if (session.startsWith("build-")) return { repository_key: "oakridge", summary: `built ${unitId}`, pr_url: "https://example.test/pr/1", branch: `cohort/${unitId}`, base_branch: "epic/proof", changed_files: [], tests: { passed: 1, failed: 0, output: "ok" }, known_issues: [] };
  return { verdict: "pass", findings: [], recommended_next_actions: [] };
};
const sendProofMessage = async (destinationId: string, message: unknown, idempotencyKey: string, topic = "execution-event"): Promise<void> => {
  const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabasePoolSize: 5, systemDatabasePollingConcurrency: 1 });
  try { await client.send(destinationId, message, topic, idempotencyKey); }
  finally { await client.destroy(); }
};
const awaitEventStatus = async (workflowId: string, key: string, expectedStatus: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const event = await DBOS.getEvent<{ readonly status?: string }>(workflowId, key, { timeoutSeconds: 1 });
    if (event?.status === expectedStatus) return;
    await Bun.sleep(25);
  }
  throw new Error(`workflow '${workflowId}' event '${key}' did not reach '${expectedStatus}'`);
};

await DBOS.launch();
try {
  const rootId = process.env.PROOF_WORKFLOW_ID ?? `production-proof-${crypto.randomUUID()}`;
  const handle = await DBOS.startWorkflow(productionRunWorkflow, { workflowID: rootId })({ run_id: crypto.randomUUID() as WorkflowRunId, workflow_definition_id: definition.id, workflow_definition_version: definition.version, context: {
    brief_notes: "deterministic proof", base_branch: "epic/proof", repositories: [{ key: "oakridge", path: "/tmp", integration_branch: "main" }], oakridge_url: "http://127.0.0.1:8790",
    planner_runtime: "claude-code", planner_model: null, planner_effort: null, worker_runtime: "claude-code", worker_model: null, worker_effort: null,
  } });
  const emitted = new Set<string>();
  const deadline = Date.now() + 30_000;
  // Eight: the five agent-driven stages' seven units, plus one provisioning
  // unit for the run's single repository.
  const EXPECTED_EXECUTIONS = 8;
  while (emitted.size < EXPECTED_EXECUTIONS) {
    const pending = await proofSql.query<ProofExecutionRow>("SELECT workflow_id, request FROM public.oakridge_proof_execution WHERE workflow_id LIKE $1 ORDER BY workflow_id", [`${rootId}:%`]);
    for (const execution of pending) {
      if (emitted.has(execution.workflow_id)) continue;
      emitted.add(execution.workflow_id);
      console.error(`proof emitting ${execution.workflow_id} (${execution.request.expected_artifacts.length} artifacts)`);
      for (const expected of execution.request.expected_artifacts) {
        const artifact: ArtifactRevision = { id: crypto.randomUUID() as ArtifactId, chain_id: crypto.randomUUID() as ArtifactId, run_id: "proof" as WorkflowRunId,
          stage_instance_id: execution.request.stage_instance_id, execution_id: execution.request.execution_id, unit_id: expected.unit_id, output_name: expected.output_name,
          artifact_type: expected.artifact_type, label: expected.unit_id, body: artifactBody(execution.request, expected.unit_id), version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: new Date().toISOString() };
        artifactState.set(artifact.id, artifact);
        if (["spec_analysis", "plan", "brief", "assessment"].includes(expected.output_name)) {
          await sendProofMessage(execution.workflow_id, { kind: "artifact_emitted", release: { kind: "waiting_gate", artifact, gate_steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }] } }, `proof:${artifact.id}`);
          const gateId = `${execution.workflow_id}:gate:${artifact.id}:wait:artifact_approval`;
          await awaitEventStatus(gateId, "gate-state", "pending");
          await sendProofMessage(gateId, { kind: "decision", action: "approve", artifact_revision_id: artifact.id, gate_step: "artifact_approval" }, `approve:${artifact.id}`, "gate-command");
        } else if (expected.output_name === "build_result") {
          await sendProofMessage(execution.workflow_id, { kind: "artifact_emitted", release: { kind: "waiting_handoff", artifact, downstream_role: "assessment", external_wait_kind: "github_review" } }, `proof:${artifact.id}`);
          const handoffId = `${execution.workflow_id}:handoff:${artifact.id}`;
          await awaitEventStatus(handoffId, "handoff-state", "awaiting_downstream");
          await sendProofMessage(handoffId, { kind: "downstream_decision", action: "approve", decision_artifact_id: crypto.randomUUID() as ArtifactId }, `handoff-approve:${artifact.id}`, "handoff-command");
          await awaitEventStatus(handoffId, "handoff-state", "awaiting_external");
          await sendProofMessage(handoffId, { kind: "external_completed", external_kind: "github_review", correlation_id: `github:${artifact.id}` }, `handoff-complete:${artifact.id}`, "handoff-command");
        } else {
          await sendProofMessage(execution.workflow_id, { kind: "artifact_emitted", release: { kind: "released", artifact } }, `proof:${artifact.id}`);
        }
      }
      console.error(`proof emitted ${execution.workflow_id}`);
    }
    if (Date.now() > deadline) throw new Error("production topology proof timed out");
    await Bun.sleep(50);
  }
  const result = await handle.getResult();
  const workflows = await DBOS.listWorkflows({ workflow_id_prefix: rootId, loadInput: false, loadOutput: false });
  const recorded = await proofSql.query<ProofExecutionRow>("SELECT workflow_id, request FROM public.oakridge_proof_execution WHERE workflow_id LIKE $1 ORDER BY workflow_id", [`${rootId}:%`]);
  const assessors = recorded.filter((row) => row.workflow_id.includes(":stage:assessor:unit:"));
  const assessorLineageIsExact = assessors.length === 2 && assessors.every((row) => {
    const buildResult = row.request.inputs.find((input) => input.output_name === "build_result");
    return row.request.workspace_source?.execution_id === buildResult?.producer_execution_id
      && row.request.inputs.length === 2 && new Set(row.request.inputs.map((input) => input.unit_id)).size === 1;
  });
  if (result.outcome.kind !== "succeeded" || Object.keys(result.stage_workflow_ids).length !== 6 || emitted.size !== EXPECTED_EXECUTIONS || !assessorLineageIsExact) throw new Error(`seeded dev flow proof failed: ${JSON.stringify({ result, emitted: emitted.size, assessorLineageIsExact })}`);
  console.log(JSON.stringify({
    outcome: result.outcome,
    stage_count: Object.keys(result.stage_workflow_ids).length,
    execution_count: emitted.size,
    child_count: workflows.length - 1,
    assessor_lineage_is_exact: assessorLineageIsExact,
    child_statuses: [...new Set(workflows.map((workflow) => workflow.status))],
  }));
} finally {
  await DBOS.shutdown();
  await proofServiceSql.close();
  await proofSql.close();
}
