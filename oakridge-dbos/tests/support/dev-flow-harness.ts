/**
 * The seeded dev flow, running on the backend the process runs.
 *
 * This harness used to register stub topology services, an in-memory artifact
 * store, and a `send` that posted lifecycle messages straight into a workflow.
 * It called that "faking only the agent". It was not: it also stood in for the
 * artifact emit route, the artifact repository, the notification outbox, the
 * gate resume route and the handoff completion route — which is to say, for
 * every seam where this project's defects actually live. The deadlock that
 * stopped every dev-flow run at its first build unit passed that harness,
 * because the harness supplied by hand the one message production had no way
 * to produce.
 *
 * So it now builds the real thing: `createOakridgeRuntime` against a real
 * PostgreSQL, real repositories, the real HTTP surface listening on a real
 * port. The agent is the only fake, and a test drives it the way an agent
 * drives Oakridge — by calling the emit route over HTTP.
 *
 * Bun runs every test file in one process, so the executor adapter can be
 * registered exactly once. Tests swap behaviour behind it with `useScenario`.
 */
import { resolve } from "node:path";

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../../src/domain/execution";
import type { ExecutionId, JsonValue, UnitId } from "../../src/domain/primitives";
import type { WorkflowDefinition } from "../../src/domain/workflow";
import { createOakridgeRuntime, type OakridgeRuntime } from "../../src/runtime/compose";
import { applyMigrations } from "../../src/storage/migrate";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";
import { loadDevFlowV11 } from "../../src/seed/dev-flow-v11";

/**
 * How an execution behaves, for the scenario currently running.
 *
 * Exactly one adapter may be registered per process, so scenarios are swapped
 * behind a single adapter rather than registered per test.
 */
export interface ExecutionScenario {
  start_or_attach(request: ExecutionRequest, attempt_id: string): Promise<ExternalExecutionReference>;
  observe_terminal(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt>;
  cancel_or_fence(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void>;
  /** Sent when something asks this execution's agent to do more work. */
  deliver_input?(execution_id: ExecutionId, delivery_key: string, prompt: string): Promise<void>;
}

let currentScenario: ExecutionScenario | null = null;

/** Point the registered adapter at the scenario for the test about to run. */
export const useScenario = (scenario: ExecutionScenario): void => { currentScenario = scenario; };

const requireScenario = (): ExecutionScenario => {
  if (!currentScenario) throw new Error("no execution scenario is active — call useScenario() first");
  return currentScenario;
};

const RELEASED_AT_TEARDOWN: ExecutorObservationAttempt = { kind: "terminal", observation: { kind: "cancelled", detail: "released at teardown" } };

/**
 * A scenario that never finishes on its own: each execution stays running
 * until something fences it. This is the state a run is in when an operator
 * cancels it, so it is what the cancellation path must be tested against.
 */
export interface IdleScenario extends ExecutionScenario {
  /**
   * Resolve every still-waiting observation, and every one still to come. A
   * pending observation keeps the runtime's event loop alive, so a test that
   * leaves one hanging cannot shut DBOS down cleanly — this is the teardown for
   * that. It latches rather than draining once, because a run being torn down
   * can still start an execution after teardown begins, and that observation
   * would hang exactly like the ones the drain was written to catch.
   */
  releaseAll(): void;
}

export const neverFinishingScenario = (): IdleScenario => {
  const resolvers = new Map<ExecutionId, (attempt: ExecutorObservationAttempt) => void>();
  const cancelled = (detail: string): ExecutorObservationAttempt => ({ kind: "terminal", observation: { kind: "cancelled", detail } });
  let released = false;
  return {
    async start_or_attach() { return { kind: "none" }; },
    observe_terminal(execution_id) {
      if (released) return Promise.resolve(RELEASED_AT_TEARDOWN);
      return new Promise((resolve) => resolvers.set(execution_id, resolve));
    },
    async cancel_or_fence(execution_id) {
      resolvers.get(execution_id)?.(cancelled("fenced by test"));
      resolvers.delete(execution_id);
    },
    releaseAll() {
      released = true;
      for (const resolve of resolvers.values()) resolve(RELEASED_AT_TEARDOWN);
      resolvers.clear();
    },
  };
};

/**
 * An agent that does nothing until told to, and records what it was asked for.
 *
 * A driver reads `launched` to learn which executions exist and what each one
 * owes, emits those artifacts over the real HTTP surface, and then reports the
 * agent as having exited cleanly.
 */
export interface AgentDelivery {
  readonly execution_id: string;
  readonly delivery_key: string;
  readonly prompt: string;
}

export interface ScriptedAgentScenario extends ExecutionScenario {
  /** Execution workflow id → the request that started it, in launch order. */
  readonly launched: Map<string, ExecutionRequest>;
  /** Every follow-up the run has sent an agent — a revision request, say. */
  readonly deliveries: AgentDelivery[];
  /** Report this execution's agent as having exited cleanly. */
  succeed(execution_id: ExecutionId | string): void;
  releaseAll(): void;
}

export const scriptedAgentScenario = (): ScriptedAgentScenario => {
  const launched = new Map<string, ExecutionRequest>();
  const deliveries: AgentDelivery[] = [];
  const succeeded = new Set<string>();
  const waiters = new Map<string, (attempt: ExecutorObservationAttempt) => void>();
  const success: ExecutorObservationAttempt = { kind: "terminal", observation: { kind: "succeeded", metadata: {} } };
  let released = false;
  return {
    launched,
    deliveries,
    async deliver_input(execution_id, delivery_key, prompt) {
      deliveries.push({ execution_id: String(execution_id), delivery_key, prompt });
    },
    async start_or_attach(request, attempt_id) {
      // The attempt id is the execution's own workflow id, which is the handle
      // every other participant addresses this execution by.
      launched.set(attempt_id, request);
      return { kind: "none" };
    },
    observe_terminal(execution_id) {
      const id = String(execution_id);
      // The observation can be requested either side of the agent finishing;
      // both orders must terminate.
      if (succeeded.has(id)) return Promise.resolve(success);
      if (released) return Promise.resolve(RELEASED_AT_TEARDOWN);
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
      released = true;
      for (const resolve of waiters.values()) resolve(RELEASED_AT_TEARDOWN);
      waiters.clear();
    },
  };
};

export interface IntegrationRuntime {
  readonly runtime: OakridgeRuntime;
  /** Where the real HTTP surface is listening. */
  readonly base_url: string;
  readonly definition: WorkflowDefinition;
  readonly application_version: string;
  /**
   * Root workflows this file started, cancelled on teardown.
   *
   * A run left mid-flight keeps its executions parked in `recv`, and
   * `DBOS.shutdown()` waits on them — so a test that fails its assertion is
   * followed by a shutdown that times out, and the real failure scrolls away
   * behind a hook error. Cancelling first keeps the first failure the loudest.
   */
  readonly started_runs: string[];
  stop(): Promise<void>;
}

/**
 * Brings up the backend once for the whole file: schema, DBOS runtime, real
 * repositories, real routes on a real port.
 *
 * `applicationVersion` is unique per launch so a previous run's workflows are
 * never recovered into this one, and concurrent runs on a shared database stay
 * isolated.
 */
export const installIntegrationRuntime = async (databaseUrl: string): Promise<IntegrationRuntime> => {
  const migrationSql = PgPostgresExecutor.connect(databaseUrl);
  try { await applyMigrations(migrationSql); } finally { await migrationSql.close(); }

  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);

  const applicationVersion = `e2e-${crypto.randomUUID()}`;
  DBOS.setConfig({ name: "oakridge-dev-flow-e2e", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });

  const adapter: ExecutorAdapter = {
    executor_type: "delegated_session",
    start_or_attach: (request, attempt_id) => requireScenario().start_or_attach(request, attempt_id),
    observe_terminal: (execution_id, reference) => requireScenario().observe_terminal(execution_id, reference),
    async deliver_input(execution_id, delivery_key, prompt) { await requireScenario().deliver_input?.(execution_id, delivery_key, prompt); },
    cancel_or_fence: (execution_id, reference) => requireScenario().cancel_or_fence(execution_id, reference),
  };

  const runtime = await createOakridgeRuntime({
    database_url: databaseUrl,
    application_version: applicationVersion,
    executor_adapter: adapter,
    prompt_template_directory: resolve(import.meta.dir, "../../../oakridge-core/prompts"),
  });
  await runtime.seed_builtins();
  await DBOS.launch();

  const server = Bun.serve({ port: 0, idleTimeout: 60, fetch: runtime.app.fetch });
  const startedRuns: string[] = [];

  return {
    runtime,
    base_url: `http://127.0.0.1:${server.port}`,
    definition: loaded.value,
    application_version: applicationVersion,
    started_runs: startedRuns,
    async stop() {
      for (const rootWorkflowId of startedRuns) {
        await DBOS.cancelWorkflow(rootWorkflowId, { cancelChildren: true }).catch(() => undefined);
      }
      server.stop(true);
      await DBOS.shutdown();
      await runtime.close();
    },
  };
};

/** A canonical GitHub pull request URL per cohort, so reconciliation has an identity to check. */
export const cohortPullRequestUrl = (unitId: UnitId): string => `https://github.com/RankOneLabs/oakridge/pull/${unitId === "web" ? 2 : 1}`;
export const cohortHeadBranch = (unitId: UnitId): string => `cohort/${unitId}`;

/**
 * The body a faked agent would have produced for a given output.
 *
 * `revision` distinguishes a re-emission from a replay: a revision carries the
 * same identity and different content, which is exactly what the artifact
 * repository keys a new version on.
 */
export const artifactBody = (request: ExecutionRequest, unitId: UnitId, outputName: string, revision = 1): JsonValue => {
  const session = (request.resolved_config as { readonly session_name?: string }).session_name ?? "";
  if (session.startsWith("spec-analyzer-")) return { requirements: [{ id: "R1", description: `harness v${revision}` }] };
  if (session.startsWith("plan-writer-")) return { cohorts: [{ id: "foundation" }, { id: "web" }] };
  if (session.startsWith("brief-writer-")) {
    return { cohort_id: unitId, repository_key: "oakridge", title: String(unitId), goal: "harness", files_in_scope: [],
      next_action: "build", decisions_made: [], acceptance_criteria: ["passes"], depends_on: unitId === "web" ? ["foundation"] : [] };
  }
  if (session.startsWith("build-")) {
    // The two build outputs are genuinely different documents, and the pull
    // request reconciler reads one of them — so the harness has to emit the
    // right shape into the right slot rather than one body into both.
    if (outputName === "pr_summary") {
      return { pr_url: cohortPullRequestUrl(unitId), branch: cohortHeadBranch(unitId), summary: `built ${unitId} v${revision}`, review_status: "ready" };
    }
    return { repository_key: "oakridge", summary: `built ${unitId} v${revision}`, changed_files: [],
      tests: { passed: 1, failed: 0, output: "ok" }, delegated_session_metadata: null, known_issues: [] };
  }
  return { verdict: "pass", findings: [], recommended_next_actions: [], revision };
};

export const runContext = (oakridgeUrl: string) => ({
  brief_notes: "end-to-end harness",
  repositories: [{ key: "oakridge", path: "/tmp", epic_branch: "epic/harness", base_branch: "main" }],
  oakridge_url: oakridgeUrl,
  planner_runtime: "claude-code" as const, planner_model: null, planner_effort: null,
  worker_runtime: "claude-code" as const, worker_model: null, worker_effort: null,
});

/**
 * Polls a predicate to a deadline.
 *
 * `describe` may be a thunk so a caller can fold in whatever it last saw — a
 * timeout that only says "it did not happen" costs an entire debugging session
 * that the refusal it swallowed would have ended.
 */
export const awaitCondition = async <Value>(
  describe: string | (() => string),
  attempt: () => Promise<Value | null>,
  timeoutMs = 30_000,
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${typeof describe === "function" ? describe() : describe} did not happen within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
};
