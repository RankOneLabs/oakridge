/**
 * The seeded dev flow, run end to end against a real DBOS runtime.
 *
 * Every other file in this suite stubs its collaborators one layer inside the
 * code under test. That catches a wrong implementation and is structurally
 * blind to a wrong *contract*: both sides of a seam assert against their own
 * mocks, and neither ever runs the other. Every regression this project has
 * shipped has been at such a seam.
 *
 * These tests run the real thing — real workflows, real gates and handoffs,
 * real artifact-contract evaluation, real cancellation — and fake only the
 * agent, which a test cannot spawn. The second test additionally drives the
 * real kbbl HTTP routes, because the fence crossing that boundary is where a
 * run once deadlocked against itself.
 *
 * Requires PostgreSQL; skipped when none is reachable. See
 * `tests/support/durable-database.ts`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";

import { KbblExecutorAdapter } from "../src/adapters/kbbl";
import type { ExecutionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { mountSessionsRoutes } from "../../kbbl/core/server/handlers/sessions";
import type { SessionManager } from "../../kbbl/core/session/session-manager";
import { findTestDatabaseUrl } from "./support/durable-database";
import {
  awaitLaunched, completableScenario, completeExecution, installHarness, neverFinishingScenario, runContext,
  useCancellationTargets, useScenario, type HarnessArtifacts,
} from "./support/dev-flow-harness";

const databaseUrl = await findTestDatabaseUrl();
/**
 * A skipped e2e is indistinguishable from a passing one, which is the exact
 * failure this layer exists to prevent — so say so loudly.
 */
if (!databaseUrl) console.warn("dev-flow e2e SKIPPED: no reachable PostgreSQL (set OAKRIDGE_TEST_DATABASE_URL)");
const e2e = databaseUrl ? test : test.skip;

let artifacts: HarnessArtifacts;
let definition: WorkflowDefinition;

beforeAll(async () => {
  if (!databaseUrl) return;
  const installed = await installHarness();
  definition = installed.definition;
  artifacts = installed.artifacts;
  DBOS.setConfig({
    name: "oakridge-dev-flow-e2e",
    systemDatabaseUrl: databaseUrl,
    // Unique per run so a previous run's workflows are never recovered into
    // this one, and concurrent runs on a shared database stay isolated.
    applicationVersion: `e2e-${crypto.randomUUID()}`,
    logLevel: "warn",
  });
  await DBOS.launch();
});

afterAll(async () => {
  if (databaseUrl) await DBOS.shutdown();
}, 60_000);

const startRun = async (rootId: string) => {
  const { productionRunWorkflow } = await import("../src/workflows/production-topology");
  return DBOS.startWorkflow(productionRunWorkflow, { workflowID: rootId })({
    run_id: crypto.randomUUID() as WorkflowRunId,
    workflow_definition_id: definition.id,
    workflow_definition_version: definition.version,
    context: runContext(),
  });
};

/**
 * The whole flow: five stages, seven executions, every gate approved and every
 * handoff completed. Asserts the assessor's lineage as well as the outcome —
 * a run that finishes with the wrong inputs threaded through is not a pass.
 */
e2e("the seeded dev flow runs to completion through gates and handoffs", async () => {
  const agents = completableScenario();
  useScenario(agents);

  const rootId = `e2e-complete-${crypto.randomUUID()}`;
  const handle = await startRun(rootId);

  const driven = new Set<string>();
  const deadline = Date.now() + 60_000;
  try {
    while (driven.size < 7) {
      if (Date.now() > deadline) throw new Error(`dev flow stalled after driving ${driven.size}/7 executions`);
      for (const executionWorkflowId of [...artifacts.launched.keys()].filter((id) => id.startsWith(`${rootId}:`))) {
        if (driven.has(executionWorkflowId)) continue;
        driven.add(executionWorkflowId);
        await completeExecution(databaseUrl!, artifacts, executionWorkflowId);
        agents.succeed(artifacts.launched.get(executionWorkflowId)!.execution_id);
      }
      await Bun.sleep(25);
    }
  } finally {
    agents.releaseAll();
  }

  const result = await handle.getResult();
  expect(result.outcome.kind).toBe("succeeded");
  expect(Object.keys(result.stage_workflow_ids)).toHaveLength(5);
  expect(driven.size).toBe(7);

  // Each assessor must see exactly its own cohort's build, in the workspace
  // that produced it — not a sibling's, and not both.
  const assessors = [...artifacts.launched.entries()].filter(([id]) => id.startsWith(`${rootId}:`) && id.includes(":stage:assessor:unit:"));
  expect(assessors).toHaveLength(2);
  for (const [, request] of assessors) {
    const buildResult = request.inputs.find((input) => input.output_name === "build_result");
    expect(request.workspace_source?.execution_id).toBe(buildResult?.producer_execution_id);
    expect(request.inputs).toHaveLength(2);
    expect(new Set(request.inputs.map((input) => input.unit_id)).size).toBe(1);
  }
}, 90_000);

/**
 * The regression this harness was built for.
 *
 * Cancelling a run fences its executions, and for a delegated session that
 * means closing it in kbbl — over HTTP, through the route that refuses closes
 * which would abandon a live unit. When the fence did not identify itself,
 * that guard refused the run's own teardown: `containAttempt` awaits every
 * fence's result, so the refusal propagated and cancellation never completed.
 * The run could not be cancelled while active and stayed active because its
 * session would not close.
 *
 * Both packages are real here. Only the agent process and the hold's storage
 * are faked.
 */
e2e("cancelling a run fences its delegated session through the real kbbl route", async () => {
  const SESSION_ID = "db26174d-21e2-40f4-af40-fc359c4e9604";
  const closed: string[] = [];
  const refusals: string[] = [];

  // A kbbl whose Oakridge reports the session as held by the execution that
  // is about to be fenced — the state that produced the deadlock.
  const manager = {
    get: (sid: string) => ({ markEndReason: () => {}, abort: async () => { closed.push(sid); return 0; } }),
  } as unknown as SessionManager;

  let heldByExecution = "";
  const oakridgeStub = new Hono();
  oakridgeStub.get("/session_holds/:sid", (c) => c.json({
    held: true,
    hold: { session_id: SESSION_ID, execution_id: heldByExecution, execution_workflow_id: "unused",
      run_id: "unused", stage_instance_id: "unused", stage_key: "spec_analyzer", unit_id: "0" },
  }));
  const oakridgeServer = Bun.serve({ port: 0, fetch: oakridgeStub.fetch });

  const kbbl = new Hono();
  kbbl.use("*", async (c, next) => {
    await next();
    if (c.res.status === 409) refusals.push(c.req.url);
  });
  mountSessionsRoutes(kbbl, {
    manager, defaultWorkdir: "/tmp/oakridge-e2e", sessionsDir: "/tmp/oakridge-e2e",
    oakridgeBaseUrl: `http://127.0.0.1:${oakridgeServer.port}`,
  });
  const kbblServer = Bun.serve({ port: 0, fetch: kbbl.fetch });

  const idle = neverFinishingScenario();
  try {
    const kbblAdapter = new KbblExecutorAdapter({ base_url: `http://127.0.0.1:${kbblServer.port}`, executor_function_identity: "e2e" });
    useScenario({
      // The session exists in kbbl already; the run attaches to it.
      async start_or_attach() { return { kind: "kbbl_session", session_id: SESSION_ID }; },
      observe_terminal: (id, reference) => idle.observe_terminal(id, reference),
      // The real adapter, over real HTTP, into the real route.
      cancel_or_fence: (id, reference) => kbblAdapter.cancel_or_fence(id, reference),
    });

    const rootId = `e2e-cancel-${crypto.randomUUID()}`;
    const handle = await startRun(rootId);

    // Cancel once the first stage is genuinely running an execution.
    const [executionWorkflowId] = await awaitLaunched(artifacts, rootId, (ids) => ids.length > 0);
    const request = artifacts.launched.get(executionWorkflowId!)!;
    heldByExecution = String(request.execution_id);
    useCancellationTargets([{
      execution_id: request.execution_id as ExecutionId,
      executor_type: "delegated_session",
      external_reference: { kind: "kbbl_session", session_id: SESSION_ID },
    }]);

    const { cancellationControlWorkflow } = await import("../src/workflows/cancellation");
    const cancellation = await DBOS.startWorkflow(cancellationControlWorkflow, { workflowID: `oakridge-cancel:${rootId}` })({
      root_workflow_id: rootId, reason: "e2e cancellation", requested_at: new Date().toISOString(),
    });

    // The assertion: cancellation completes. Before the fix this rejected,
    // because the fence exhausted its retries against a 409.
    const result = await cancellation.getResult();
    expect(result.fenced_execution_count).toBe(1);
    expect(closed).toEqual([SESSION_ID]);
    expect(refusals).toEqual([]);

    await expect(handle.getResult()).rejects.toThrow();
  } finally {
    idle.releaseAll();
    kbblServer.stop(true);
    oakridgeServer.stop(true);
    useCancellationTargets([]);
  }
}, 90_000);
