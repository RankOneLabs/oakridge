/**
 * An end-to-end harness for the seeded dev flow.
 *
 * The rest of this suite stubs each collaborator one layer inside the code
 * under test, which is why a broken contract *between* components passes it —
 * both halves assert against their own mocks and neither runs the other. This
 * harness inverts that: the DBOS runtime, the workflow topology, the gate and
 * handoff waits, and the artifact contract evaluation are all real. Only the
 * agent is faked, because a test cannot spawn a coding agent.
 *
 * It grew out of `src/dev/run-production-topology-proof.ts`, which proved the
 * topology once by hand and then never ran again.
 */
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import type { ArtifactRevision } from "../../src/domain/artifacts";
import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../../src/domain/execution";
import type { ArtifactId, ExecutionId, JsonValue, UnitId, WorkflowRunId } from "../../src/domain/primitives";
import type { CancellationExecutionTarget } from "../../src/domain/rerun";
import type { WorkflowDefinition } from "../../src/domain/workflow";
import { loadDevFlowV11 } from "../../src/seed/dev-flow-v11";

/**
 * How an execution behaves, for the scenario currently running.
 *
 * Exactly one adapter may be registered per process, so scenarios are swapped
 * behind a single adapter rather than registered per test.
 */
export interface ExecutionScenario {
  start_or_attach(request: ExecutionRequest): Promise<ExternalExecutionReference>;
  observe_terminal(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt>;
  cancel_or_fence(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void>;
}

let currentScenario: ExecutionScenario | null = null;

/** Point the registered adapter at the scenario for the test about to run. */
export const useScenario = (scenario: ExecutionScenario): void => { currentScenario = scenario; };

const requireScenario = (): ExecutionScenario => {
  if (!currentScenario) throw new Error("no execution scenario is active — call useScenario() first");
  return currentScenario;
};

/**
 * A scenario that never finishes on its own: each execution stays running
 * until something fences it. This is the state a run is in when an operator
 * cancels it, so it is what the cancellation path must be tested against.
 */
export interface IdleScenario extends ExecutionScenario {
  /**
   * Resolve every still-waiting observation. A pending observation keeps the
   * runtime's event loop alive, so a test that leaves one hanging cannot shut
   * DBOS down cleanly — this is the teardown for that.
   */
  releaseAll(): void;
}

export const neverFinishingScenario = (): IdleScenario => {
  const resolvers = new Map<ExecutionId, (attempt: ExecutorObservationAttempt) => void>();
  const cancelled = (detail: string): ExecutorObservationAttempt => ({ kind: "terminal", observation: { kind: "cancelled", detail } });
  return {
    async start_or_attach() { return { kind: "none" }; },
    observe_terminal(execution_id) {
      return new Promise((resolve) => resolvers.set(execution_id, resolve));
    },
    async cancel_or_fence(execution_id) {
      resolvers.get(execution_id)?.(cancelled("fenced by test"));
      resolvers.delete(execution_id);
    },
    releaseAll() {
      for (const resolve of resolvers.values()) resolve(cancelled("released at teardown"));
      resolvers.clear();
    },
  };
};

/**
 * Executions that succeed on demand, so a driver can emit their artifacts and
 * then report the agent as finished. Resolving on a signal rather than polling
 * keeps no timers alive between tests.
 */
export interface CompletableScenario extends ExecutionScenario {
  /** Report this execution's agent as having exited cleanly. */
  succeed(execution_id: ExecutionId | string): void;
  releaseAll(): void;
}

export const completableScenario = (): CompletableScenario => {
  const succeeded = new Set<string>();
  const waiters = new Map<string, (attempt: ExecutorObservationAttempt) => void>();
  const success: ExecutorObservationAttempt = { kind: "terminal", observation: { kind: "succeeded", metadata: {} } };
  return {
    async start_or_attach() { return { kind: "none" }; },
    observe_terminal(execution_id) {
      const id = String(execution_id);
      // The observation can be requested either side of the agent finishing;
      // both orders must terminate.
      if (succeeded.has(id)) return Promise.resolve(success);
      return new Promise((resolve) => waiters.set(id, resolve));
    },
    async cancel_or_fence() {},
    succeed(execution_id) {
      const id = String(execution_id);
      succeeded.add(id);
      waiters.get(id)?.(success);
      waiters.delete(id);
    },
    releaseAll() {
      for (const resolve of waiters.values()) resolve({ kind: "terminal", observation: { kind: "cancelled", detail: "released at teardown" } });
      waiters.clear();
    },
  };
};

/**
 * The executions a cancellation should fence.
 *
 * In production these come from `executor_projection`; the harness sets them
 * directly so a test can cancel a run at a chosen moment without racing the
 * projection write.
 */
let cancellationTargets: readonly CancellationExecutionTarget[] = [];
export const useCancellationTargets = (targets: readonly CancellationExecutionTarget[]): void => { cancellationTargets = targets; };

export interface HarnessArtifacts {
  /** Every artifact the harness has emitted, by id. */
  readonly state: Map<ArtifactId, ArtifactRevision>;
  /** Execution workflow ids the topology has launched, in launch order. */
  readonly launched: Map<string, ExecutionRequest>;
}

/**
 * Registers the process-wide topology collaborators and returns the state they
 * accumulate. Must be called once per process, before `DBOS.launch()`.
 */
export const installHarness = async (): Promise<{ definition: WorkflowDefinition; artifacts: HarnessArtifacts }> => {
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = loaded.value;

  const state = new Map<ArtifactId, ArtifactRevision>();
  const launched = new Map<string, ExecutionRequest>();

  const { registerExecutorAdapter, registerArtifactLifecycleObserver } = await import("../../src/workflows/executor-topology");
  const { registerProductionTopologyServices } = await import("../../src/workflows/production-topology");

  const adapter: ExecutorAdapter = {
    executor_type: "delegated_session",
    start_or_attach: (request) => requireScenario().start_or_attach(request),
    observe_terminal: (execution_id, reference) => requireScenario().observe_terminal(execution_id, reference),
    async deliver_input() {},
    cancel_or_fence: (execution_id, reference) => requireScenario().cancel_or_fence(execution_id, reference),
  };
  registerExecutorAdapter(adapter);

  registerArtifactLifecycleObserver({
    async find_by_id(id) { return state.get(id) ?? null; },
    async mark_released(id, released_at) {
      const artifact = state.get(id);
      if (!artifact) return { kind: "not_current", artifact_id: id };
      if (artifact.lifecycle.kind === "released") return { kind: "already_released", artifact };
      if (artifact.lifecycle.kind !== "current") return { kind: "not_current", artifact_id: id };
      const released = { ...artifact, lifecycle: { kind: "released" as const, released_at } };
      state.set(id, released);
      return { kind: "released", artifact: released };
    },
  });

  const { registerCancellationControlServices } = await import("../../src/workflows/cancellation");
  registerCancellationControlServices({
    async list_execution_targets() { return cancellationTargets; },
    async terminalize_pending_waits() { return []; },
    async finish_started_stages() {},
  });

  registerProductionTopologyServices({
    async ensure_run() {}, async finish_run() {},
    async find_external_reference() { return { kind: "none" }; },
    async load_compiled_definition(id, version) {
      if (id !== definition.id || version !== definition.version) throw new Error("harness requested the wrong seeded definition");
      const { compileWorkflowDefinition } = await import("../../src/compiler/compile-workflow");
      const compiled = compileWorkflowDefinition(definition);
      if (!compiled.ok) throw new Error(compiled.error.detail);
      return compiled.value;
    },
    async load_prompt_template(path) { return Bun.file(new URL(`../../../oakridge-core/prompts/${path}`, import.meta.url)).text(); },
    async start_stage() {}, async finish_stage() {},
    async record_execution(input) { launched.set(input.execution_workflow_id, input.request); },
    async replace_execution_projection() {},
    async load_resume_artifacts() { return []; },
  });

  return { definition, artifacts: { state, launched } };
};

/** The body a faked agent would have produced for a given stage. */
export const artifactBody = (request: ExecutionRequest, unitId: UnitId): JsonValue => {
  const session = (request.resolved_config as { readonly session_name?: string }).session_name ?? "";
  if (session.startsWith("spec-analyzer-")) return { requirements: [{ id: "R1", description: "harness" }] };
  if (session.startsWith("plan-writer-")) return { cohorts: [{ id: "foundation" }, { id: "web" }] };
  if (session.startsWith("brief-writer-")) {
    return { cohort_id: unitId, repository_key: "oakridge", title: String(unitId), goal: "harness", files_in_scope: [],
      next_action: "build", decisions_made: [], acceptance_criteria: ["passes"], depends_on: unitId === "web" ? ["foundation"] : [] };
  }
  if (session.startsWith("build-")) {
    return { repository_key: "oakridge", summary: `built ${unitId}`, pr_url: "https://example.test/pr/1", branch: `cohort/${unitId}`,
      base_branch: "epic/harness", changed_files: [], tests: { passed: 1, failed: 0, output: "ok" }, known_issues: [] };
  }
  return { verdict: "pass", findings: [], recommended_next_actions: [] };
};

export const runContext = (oakridgeUrl = "http://127.0.0.1:8790") => ({
  brief_notes: "end-to-end harness",
  repositories: [{ key: "oakridge", path: "/tmp", epic_branch: "epic/harness", base_branch: "main" }],
  oakridge_url: oakridgeUrl,
  planner_runtime: "claude-code" as const, planner_model: null, planner_effort: null,
  worker_runtime: "claude-code" as const, worker_model: null, worker_effort: null,
});

/**
 * DBOS `send` from outside a workflow needs its own client; the harness opens
 * one per message rather than holding a pool open across a test.
 */
export const sendMessage = async (databaseUrl: string, destinationId: string, message: unknown, idempotencyKey: string, topic = "execution-event"): Promise<void> => {
  const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabasePoolSize: 5, systemDatabasePollingConcurrency: 1 });
  try { await client.send(destinationId, message, topic, idempotencyKey); }
  finally { await client.destroy(); }
};

/** Waits for a workflow to publish an event reaching the expected status. */
export const awaitEventStatus = async (workflowId: string, key: string, expectedStatus: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await DBOS.getEvent<{ readonly status?: string }>(workflowId, key, { timeoutSeconds: 1 });
    if (event?.status === expectedStatus) return;
    await Bun.sleep(25);
  }
  throw new Error(`workflow '${workflowId}' event '${key}' did not reach '${expectedStatus}' within ${timeoutMs}ms`);
};

/** Waits for a predicate over the harness's launched executions. */
export const awaitLaunched = async (artifacts: HarnessArtifacts, rootId: string, predicate: (ids: string[]) => boolean, timeoutMs = 15_000): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = [...artifacts.launched.keys()].filter((id) => id.startsWith(`${rootId}:`));
    if (predicate(ids)) return ids;
    await Bun.sleep(25);
  }
  throw new Error(`no execution matching the predicate launched under '${rootId}' within ${timeoutMs}ms`);
};

/**
 * Emits every artifact one execution declared, driving it through whichever
 * release path its stage uses — an approval gate, a downstream handoff, or a
 * direct release. This is the faked agent plus the faked operator.
 */
export const completeExecution = async (
  databaseUrl: string,
  artifacts: HarnessArtifacts,
  executionWorkflowId: string,
): Promise<void> => {
  const request = artifacts.launched.get(executionWorkflowId);
  if (!request) throw new Error(`execution '${executionWorkflowId}' was never launched`);
  for (const expected of request.expected_artifacts) {
    const artifact: ArtifactRevision = {
      id: crypto.randomUUID() as ArtifactId, chain_id: crypto.randomUUID() as ArtifactId, run_id: "harness" as WorkflowRunId,
      stage_instance_id: request.stage_instance_id, execution_id: request.execution_id, unit_id: expected.unit_id,
      output_name: expected.output_name, artifact_type: expected.artifact_type, label: expected.unit_id,
      body: artifactBody(request, expected.unit_id), version: 1, parent_artifact_id: null,
      lifecycle: { kind: "current" }, created_at: new Date().toISOString(),
    };
    artifacts.state.set(artifact.id, artifact);

    if (["spec_analysis", "plan", "brief", "assessment"].includes(expected.output_name)) {
      await sendMessage(databaseUrl, executionWorkflowId, { kind: "artifact_emitted", release: { kind: "waiting_gate", artifact,
        gate_steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }] } }, `emit:${artifact.id}`);
      const gateId = `${executionWorkflowId}:gate:${artifact.id}:wait:artifact_approval`;
      await awaitEventStatus(gateId, "gate-state", "pending");
      await sendMessage(databaseUrl, gateId, { kind: "decision", action: "approve", artifact_revision_id: artifact.id, gate_step: "artifact_approval" }, `approve:${artifact.id}`, "gate-command");
    } else if (expected.output_name === "build_result") {
      await sendMessage(databaseUrl, executionWorkflowId, { kind: "artifact_emitted", release: { kind: "waiting_handoff", artifact, downstream_role: "assessment", external_wait_kind: "github_review" } }, `emit:${artifact.id}`);
      const handoffId = `${executionWorkflowId}:handoff:${artifact.id}`;
      await awaitEventStatus(handoffId, "handoff-state", "awaiting_downstream");
      await sendMessage(databaseUrl, handoffId, { kind: "downstream_decision", action: "approve", decision_artifact_id: crypto.randomUUID() as ArtifactId }, `handoff-approve:${artifact.id}`, "handoff-command");
      await awaitEventStatus(handoffId, "handoff-state", "awaiting_external");
      await sendMessage(databaseUrl, handoffId, { kind: "external_completed", external_kind: "github_review", correlation_id: `github:${artifact.id}` }, `handoff-complete:${artifact.id}`, "handoff-command");
    } else {
      await sendMessage(databaseUrl, executionWorkflowId, { kind: "artifact_emitted", release: { kind: "released", artifact } }, `emit:${artifact.id}`);
    }
  }
};
