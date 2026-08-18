/**
 * The seeded dev flow, run end to end against the backend the process runs.
 *
 * Every other file in this suite stubs its collaborators one layer inside the
 * code under test. That catches a wrong implementation and is structurally
 * blind to a wrong *contract*: both sides of a seam assert against their own
 * mocks, and neither ever runs the other. Every regression this project has
 * shipped has been at such a seam.
 *
 * These tests run the real thing — the composition `main.ts` builds, real
 * PostgreSQL repositories, the real HTTP routes on a real port, real workflows,
 * real gates and handoffs, real artifact-contract evaluation, real
 * cancellation. The agent is the only fake, and it is driven the way an agent
 * drives Oakridge: by calling the emit route. Every operator action goes
 * through the operator's own routes.
 *
 * Requires PostgreSQL; skipped when none is reachable. See
 * `tests/support/durable-database.ts`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";

import { KbblExecutorAdapter } from "../src/adapters/kbbl";
import type { ExecutionId, UnitId } from "../src/domain/primitives";
import { mountSessionsRoutes } from "../../kbbl/core/server/handlers/sessions";
import type { SessionManager } from "../../kbbl/core/session/session-manager";
import { findTestDatabaseUrl } from "./support/durable-database";
import {
  awaitCondition, installIntegrationRuntime, neverFinishingScenario, scriptedAgentScenario, useScenario,
  type IntegrationRuntime, type ScriptedAgentScenario,
} from "./support/dev-flow-harness";
import {
  attemptGateDecision, confirmCohortMerged, decideGate, emitDeclaredArtifacts, launchRun, mergedPullRequestObservation,
  observeCohortPullRequest, readReviewInbox, readRun, type EmittedArtifact,
} from "./support/dev-flow-driver";

/** The epic branch the harness's run context declares its cohorts target. */
const HARNESS_EPIC_BRANCH = "epic/harness";

const databaseUrl = await findTestDatabaseUrl();
/**
 * A skipped e2e is indistinguishable from a passing one, which is the exact
 * failure this layer exists to prevent — so say so loudly.
 */
if (!databaseUrl) console.warn("dev-flow e2e SKIPPED: no reachable PostgreSQL (set OAKRIDGE_TEST_DATABASE_URL)");
const e2e = databaseUrl ? test : test.skip;

let oakridge: IntegrationRuntime;

beforeAll(async () => {
  if (!databaseUrl) return;
  oakridge = await installIntegrationRuntime(databaseUrl);
}, 120_000);

afterAll(async () => {
  if (databaseUrl) await oakridge.stop();
}, 60_000);

/**
 * Everything the operator and the outside world owe a run, done as soon as it
 * is owed.
 *
 * A gate is approved when it appears. A build result parked in a handoff is
 * left alone — the assessor's approval is what resolves it, and supplying that
 * decision here is precisely the shortcut that let the deadlock ship. Its
 * `github_review` wait is closed the way an operator closes it, by confirming
 * the merge through the cohort pull request route.
 */
/** An output in a handoff, with the cohort id the operator surface addresses it by. */
interface ParkedCohort extends EmittedArtifact { readonly cohort_id: string }

class RunDriver {
  private readonly driven = new Set<string>();
  private readonly gated: EmittedArtifact[] = [];
  private readonly awaitingReview: ParkedCohort[] = [];
  private readonly parked: ParkedCohort[] = [];
  /** The last thing a route refused, so a timeout says what it was blocked on. */
  private lastRefusal = "nothing refused yet";
  /** How many external reviews have been closed, which picks the next one's path. */
  private closed = 0;

  constructor(private readonly base: string, private readonly agent: ScriptedAgentScenario, private readonly rootId: string) {}

  /** Execution workflow ids this driver has already run the agent for. */
  get drivenExecutions(): ReadonlySet<string> { return this.driven; }
  /** Every output that went into a handoff, whether or not it has come out. */
  get parkedHandoffs(): readonly EmittedArtifact[] { return this.parked; }
  get diagnosis(): string { return `driven ${this.driven.size}, gates pending ${this.gated.length}, handoffs open ${this.awaitingReview.length}, last refusal: ${this.lastRefusal}`; }

  /**
   * Runs the agent for every execution launched since the last call.
   *
   * `accept` narrows which executions the agent answers, so a test can leave a
   * stage deliberately unserved and observe what the rest of the run does
   * without it.
   */
  async driveNewExecutions(accept: (executionWorkflowId: string) => boolean = () => true): Promise<void> {
    for (const [executionWorkflowId, request] of this.agent.launched) {
      if (!executionWorkflowId.startsWith(`${this.rootId}:`) || this.driven.has(executionWorkflowId) || !accept(executionWorkflowId)) continue;
      this.driven.add(executionWorkflowId);
      const emitted = await emitDeclaredArtifacts(this.base, request);
      for (const artifact of emitted) {
        if (artifact.release === "waiting_gate") this.gated.push(artifact);
        if (artifact.release === "waiting_handoff") {
          // A cohort is addressed the way a gate is, and that is what the
          // operator surface hands out for the confirm-merged action.
          const cohort = { ...artifact, cohort_id: `${request.stage_instance_id}:${artifact.unit_id}` };
          this.awaitingReview.push(cohort);
          this.parked.push(cohort);
        }
      }
      this.agent.succeed(request.execution_id);
    }
  }

  /** Approves every gate this driver has seen an artifact park in. */
  async approvePendingGates(): Promise<void> {
    while (this.gated.length > 0) {
      const artifact = this.gated.shift();
      if (artifact) await decideGate(this.base, artifact.artifact_id, "approve");
    }
  }

  /**
   * Closing each cohort's `github_review` wait, once there is a wait to close.
   *
   * The first cohort is closed by a polled observation and the rest by the
   * operator's confirm-merged button. Both are the same route and the same
   * checks — running one of each proves the fallback is not a second, weaker
   * path that only the tests exercise.
   *
   * Tries once per open handoff. A handoff only becomes completable after the
   * downstream stage has approved it, and that stage is driven by this same
   * loop — so a refusal here means "not yet", and the attempt is retried on the
   * next pass rather than blocking the work that unblocks it.
   */
  async closeReadyReviews(): Promise<void> {
    const stillOpen: ParkedCohort[] = [];
    for (const cohort of this.awaitingReview) {
      const attempt = this.closed === 0
        ? await observeCohortPullRequest(this.base, cohort.cohort_id, mergedPullRequestObservation(cohort.unit_id as UnitId, HARNESS_EPIC_BRANCH))
        : await confirmCohortMerged(this.base, cohort.cohort_id);
      if (attempt.kind === "accepted" && attempt.outcome === "completed") { this.closed += 1; continue; }
      this.lastRefusal = `${cohort.cohort_id}: ${attempt.kind === "accepted" ? attempt.outcome : attempt.detail}`;
      stillOpen.push(cohort);
    }
    this.awaitingReview.length = 0;
    this.awaitingReview.push(...stillOpen);
  }
}

/**
 * The whole flow: five stages, seven executions, every gate approved through
 * the operator's route and every handoff resolved by the stage that owes the
 * decision. Asserts the assessor's lineage as well as the outcome — a run that
 * finishes with the wrong inputs threaded through is not a pass.
 *
 * This is also the test that would have caught the deadlock. `build_result`
 * releases through a handoff to the `assessment` role, so the assessor decides
 * it; the run workflow used to learn of an artifact only once it was released,
 * and used that same record both to decide a downstream stage was ready and to
 * feed it. The assessor waited on a released build result and the build result
 * waited on the assessor, and every run stopped at its first build unit with a
 * pull request open and nothing left that could move.
 */
e2e("the seeded dev flow runs to completion through gates and handoffs", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id);
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id);

  try {
    await awaitCondition(() => `the dev flow to finish (${driver.diagnosis})`, async () => {
      await driver.driveNewExecutions();
      await driver.approvePendingGates();
      await driver.closeReadyReviews();
      const detail = await readRun(oakridge.base_url, run.run_id);
      return detail.status === "complete" || detail.status === "failed" ? detail : null;
    }, 180_000);
  } finally {
    agent.releaseAll();
  }

  const detail = await readRun(oakridge.base_url, run.run_id);
  expect(detail.status).toBe("complete");
  expect(detail.stages).toHaveLength(5);
  expect(detail.stages.every((stage) => stage.status === "complete")).toBe(true);
  expect(driver.drivenExecutions.size).toBe(7);

  // Each assessor must see exactly its own cohort's build, in the workspace
  // that produced it — not a sibling's, and not both.
  const assessors = [...agent.launched.entries()].filter(([id]) => id.startsWith(`${run.root_workflow_id}:`) && id.includes(":stage:assessor:unit:"));
  expect(assessors).toHaveLength(2);
  for (const [, request] of assessors) {
    const buildResult = request.inputs.find((input) => input.output_name === "build_result");
    expect(request.workspace_source?.execution_id).toBe(buildResult?.producer_execution_id);
    expect(request.inputs).toHaveLength(2);
    expect(new Set(request.inputs.map((input) => input.unit_id)).size).toBe(1);
  }
}, 240_000);

/**
 * Availability and acceptance, held apart.
 *
 * The assessor has to start on a build result that is still parked in its
 * handoff, because the assessor is what resolves that handoff. Nothing here
 * stands in for it: the build's `github_review` is never completed, so the
 * build unit is never accepted, and the assessor still runs — on the artifact,
 * in the workspace that produced it.
 *
 * The second cohort declares `depends_on` the first, and a dependency is
 * satisfied by acceptance rather than availability, so exactly one build runs
 * and one assessor follows it while that first handoff is still open. Both
 * halves of the distinction are asserted at once.
 */
e2e("the assessor starts on a build result still parked in its handoff", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id);
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id);
  const isAssessor = (id: string): boolean => id.includes(":stage:assessor:unit:");

  try {
    // The assessor is deliberately left unserved: this test is about it having
    // been *started*, on an artifact whose unit is not accepted and will not be
    // while the test watches.
    const assessorId = await awaitCondition(() => `an assessor to start (${driver.diagnosis})`, async () => {
      await driver.driveNewExecutions((id) => !isAssessor(id));
      await driver.approvePendingGates();
      return [...agent.launched.keys()].find((id) => id.startsWith(`${run.root_workflow_id}:`) && isAssessor(id)) ?? null;
    }, 120_000);

    // spec_analyzer, plan_writer, brief_writer, and exactly one build.
    expect(driver.drivenExecutions.size).toBe(4);
    expect(driver.parkedHandoffs).toHaveLength(1);

    const request = agent.launched.get(assessorId);
    const buildResult = request?.inputs.find((input) => input.output_name === "build_result");
    expect(buildResult).toBeDefined();
    expect(buildResult?.artifact_id).toBe(driver.parkedHandoffs[0]!.artifact_id);
    // The assessor reviews in the workspace that produced what it is reviewing.
    expect(request?.workspace_source?.execution_id).toBe(buildResult?.producer_execution_id);

    // Available downstream, and still unaccepted: the operator surface reports
    // the cohort as under assessment rather than complete.
    const inbox = await readReviewInbox(oakridge.base_url);
    const cohort = inbox.cohorts.find((candidate) => candidate.run_id === run.run_id);
    expect(cohort?.lifecycle).toBe("assessing");
  } finally {
    // This run is deliberately left mid-flight — a build parked in its handoff,
    // an assessor just started — so it has to be torn down rather than awaited.
    await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    agent.releaseAll();
  }
}, 180_000);

/**
 * A revision request the run cannot honour is refused, not accepted.
 *
 * The assessor's gate declares `revision_target: "upstream_handoff"`: a
 * rejection is meant to send the *build* back to work. Nothing in the workflow
 * layer reads that field — `gateRelayWorkflow` dispositions on the action alone
 * — so accepting the decision wakes the build through the handoff *and* the
 * assessor's own agent, and the approval of the revised assessment is then
 * refused against a superseded handoff. The operator would have pressed a
 * button and watched the run stop for no reason they could see.
 *
 * Until the revision loop exists, the route says so. This asserts the refusal
 * and that no agent was woken by it; when the loop lands, this test becomes the
 * one that drives the round trip.
 */
e2e("a revision request that would be routed upstream is refused rather than stranding the run", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id);
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id);
  const isAssessor = (id: string): boolean => id.includes(":stage:assessor:unit:");

  try {
    const assessorId = await awaitCondition(() => `an assessor to start (${driver.diagnosis})`, async () => {
      await driver.driveNewExecutions((id) => !isAssessor(id));
      await driver.approvePendingGates();
      return [...agent.launched.keys()].find((id) => id.startsWith(`${run.root_workflow_id}:`) && isAssessor(id)) ?? null;
    }, 120_000);

    const assessorRequest = agent.launched.get(assessorId);
    if (!assessorRequest) throw new Error("the assessor request disappeared");
    const [assessment] = await emitDeclaredArtifacts(oakridge.base_url, assessorRequest);
    if (!assessment) throw new Error("the assessor emitted nothing");
    expect(assessment.release).toBe("waiting_gate");

    const refusal = await attemptGateDecision(oakridge.base_url, assessment.artifact_id, "request_revision");
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe("upstream_revision_unsupported");

    // Nothing was woken: not the build, and not the assessor either. A refusal
    // that had already sent one of them back to work would be worse than none.
    await Bun.sleep(500);
    expect(agent.deliveries).toEqual([]);
  } finally {
    await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    agent.releaseAll();
  }
}, 180_000);

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
 * Both packages are real here, and so is the cancellation target projection
 * the run reads to find what to fence. Only the agent process and the hold's
 * storage are faked.
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
  const launched = new Map<string, { readonly execution_id: ExecutionId }>();
  try {
    const kbblAdapter = new KbblExecutorAdapter({ base_url: `http://127.0.0.1:${kbblServer.port}`, executor_function_identity: "e2e" });
    useScenario({
      // The session exists in kbbl already; the run attaches to it.
      async start_or_attach(request, attempt_id) {
        launched.set(attempt_id, { execution_id: request.execution_id });
        heldByExecution = String(request.execution_id);
        return { kind: "kbbl_session", session_id: SESSION_ID };
      },
      observe_terminal: (id, reference) => idle.observe_terminal(id, reference),
      // The real adapter, over real HTTP, into the real route.
      cancel_or_fence: (id, reference) => kbblAdapter.cancel_or_fence(id, reference),
    });

    const run = await launchRun(oakridge.base_url, oakridge.definition.id);
    oakridge.started_runs.push(run.root_workflow_id);
  oakridge.started_runs.push(run.root_workflow_id);
    // Cancel once the first stage is genuinely running an execution — and once
    // its external reference has been projected, since that projection is what
    // cancellation reads to find the session to fence.
    await awaitCondition("the first execution to start", async () =>
      [...launched.keys()].some((id) => id.startsWith(`${run.root_workflow_id}:`)) ? true : null);
    await awaitCondition("the execution's session hold to be projected", async () => {
      const detail = await readRun(oakridge.base_url, run.run_id);
      return detail.stages.some((stage) => stage.delegated_kbbl_sid === SESSION_ID) ? true : null;
    });

    const { cancellationControlWorkflow } = await import("../src/workflows/cancellation");
    const cancellation = await DBOS.startWorkflow(cancellationControlWorkflow, { workflowID: `oakridge-cancel:${run.root_workflow_id}` })({
      root_workflow_id: run.root_workflow_id, reason: "e2e cancellation", requested_at: new Date().toISOString(),
    });

    // The assertion: cancellation completes. Before the fix this rejected,
    // because the fence exhausted its retries against a 409.
    const result = await cancellation.getResult();
    expect(result.fenced_execution_count).toBe(1);
    expect(closed).toEqual([SESSION_ID]);
    expect(refusals).toEqual([]);
  } finally {
    idle.releaseAll();
    kbblServer.stop(true);
    oakridgeServer.stop(true);
  }
}, 180_000);
