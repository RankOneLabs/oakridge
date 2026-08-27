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
  HARNESS_INTEGRATION_BRANCH, HARNESS_BASE_BRANCH, awaitCondition, cohortPullRequestUrl, installIntegrationRuntime,
  neverFinishingScenario, runContext, scriptedAgentScenario, useScenario, type IntegrationRuntime, type ScriptedAgentScenario,
} from "./support/dev-flow-harness";
import type { OperatorRunSummary } from "../src/domain/operator-projections";
import {
  confirmCohortMerged, decideGate, emitDeclaredArtifacts, launchRun, mergedPullRequestObservation,
  observeCohortPullRequest, readArtifact, readReviewInbox, readRun, type EmittedArtifact,
} from "./support/dev-flow-driver";
import {
  createProbeDefinition, realKbblScenario, startKbblFixture,
  type KbblFixture, type StubbedRuntimeId,
} from "./support/kbbl-fixture";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { stageRerunStateKey, type StageRerunState } from "../src/domain/rerun";
import { stageCoordinatorWorkflowId } from "../src/domain/workflow-ids";

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
  /** Cohorts the inbox offered a merge confirmation for, on the last pass. */
  private offered = 0;
  /** Cohort ids whose merge this driver confirmed through the operator surface. */
  private readonly confirmed = new Set<string>();

  constructor(private readonly base: string, private readonly agent: ScriptedAgentScenario, private readonly rootId: string, private readonly runId?: OperatorRunSummary["id"]) {}

  /** Execution workflow ids this driver has already run the agent for. */
  get drivenExecutions(): ReadonlySet<string> { return this.driven; }
  /** Every output that went into a handoff, whether or not it has come out. */
  get parkedHandoffs(): readonly EmittedArtifact[] { return this.parked; }
  /** Cohort ids this driver closed through the operator's merge confirmation. */
  get confirmedMerges(): ReadonlySet<string> { return this.confirmed; }
  get diagnosis(): string { return `driven ${this.driven.size}, gates pending ${this.gated.length}, handoffs parked ${this.awaitingReview.length}, merges offered ${this.offered}, merges confirmed ${this.confirmed.size}, last refusal: ${this.lastRefusal}`; }

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
   * The cohorts come from the review inbox rather than from this driver's own
   * record of what it parked, because the inbox is the only place a real
   * operator can learn that a merge is owed — and the poller reads the same
   * projection to decide which pull requests to ask GitHub about. A cohort the
   * inbox does not offer is one that neither participant can close, so driving
   * from private bookkeeping would prove a path nobody can walk. The one that
   * shipped picked an arbitrary output per unit and lost the handoff whenever
   * the pick was not the output holding it, and this loop, reading its own
   * notes, sailed past that.
   *
   * The first cohort is closed by a polled observation and the rest by the
   * operator's confirm-merged button. Both are the same route and the same
   * checks — running one of each proves the fallback is not a second, weaker
   * path that only the tests exercise.
   *
   * Tries once per offered cohort. A handoff only becomes completable after the
   * downstream stage has approved it, and that stage is driven by this same
   * loop — so a refusal here means "not yet", and the attempt is retried on the
   * next pass rather than blocking the work that unblocks it.
   */
  async closeReadyReviews(): Promise<void> {
    const inbox = await readReviewInbox(this.base);
    const owed = inbox.items.filter((item) => item.kind === "pull_request_merge" && (this.runId === undefined || item.run_id === this.runId));
    this.offered = owed.length;
    for (const item of owed) {
      const cohortId = `${item.stage_instance_id}:${item.unit_id}`;
      // The operator is told which pull request they are confirming. A button
      // that cannot name its pull request is not one a person can act on when
      // an epic has several of them open at once.
      expect(item.pr_url).toBe(cohortPullRequestUrl(item.unit_id as UnitId));
      expect(item.resume_actions).toEqual(["confirm_merged"]);
      const attempt = this.closed === 0
        ? await observeCohortPullRequest(this.base, cohortId, mergedPullRequestObservation(item.unit_id as UnitId, HARNESS_BASE_BRANCH))
        : await confirmCohortMerged(this.base, cohortId);
      if (attempt.kind === "accepted" && attempt.outcome === "completed") { this.closed += 1; this.confirmed.add(cohortId); continue; }
      this.lastRefusal = `${cohortId}: ${attempt.kind === "accepted" ? attempt.outcome : attempt.detail}`;
    }
  }
}

/**
 * The whole flow: six stages, seven agent executions, every gate approved
 * through the operator's route and every handoff resolved by the stage that
 * owes the decision. Asserts the assessor's lineage as well as the outcome — a
 * run that finishes with the wrong inputs threaded through is not a pass.
 *
 * The sixth stage is `provision_refs`, which no agent drives: it runs real git
 * against the fixture repository and publishes the epic branch the cohorts cut
 * their worktrees from. Before it existed the branch was created by nobody, and
 * every run against a fresh epic died at its first build.
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

  const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id, run.run_id);

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
  expect(detail.stages).toHaveLength(6);
  expect(detail.stages.every((stage) => stage.status === "complete")).toBe(true);
  expect(driver.drivenExecutions.size).toBe(7);

  // Both cohorts' merges were confirmed through the operator surface, not from
  // the driver's own notes. An epic opens one pull request per cohort, and the
  // projection that offers them resolves each unit's handoff independently — so
  // a defect there does not fail the run, it silently drops a subset of the
  // cohorts out of the inbox and out of the poller's sweep at once. Asserting
  // the count is what makes "some of them appeared" a failure.
  expect(driver.confirmedMerges.size).toBe(2);
  const cohorts = (await readReviewInbox(oakridge.base_url)).cohorts.filter((cohort) => cohort.run_id === run.run_id);
  expect(cohorts).toHaveLength(2);
  expect(cohorts.every((cohort) => cohort.lifecycle === "complete")).toBe(true);
  // Every cohort names itself. Two rows reading `null / null / null` are two
  // rows an operator cannot tell apart, which is the state the inbox was in.
  expect(cohorts.map((cohort) => cohort.repository_key).sort()).toEqual(["oakridge", "oakridge"]);
  expect(cohorts.every((cohort) => cohort.title !== null && cohort.pr_url !== null)).toBe(true);
  expect(new Set(cohorts.map((cohort) => cohort.pr_url)).size).toBe(2);

  // The epic branch exists on origin because a stage put it there. This is the
  // assertion the whole change is for: no operator ran a git command, and no
  // launch gate refused the run for the branch's absence.
  expect(await oakridge.repository.list_origin_branches()).toContain(HARNESS_BASE_BRANCH);

  // Each cohort cut its worktree from the provisioned branch, resolved through
  // the artifact rather than a pointer into the run context.
  const builds = [...agent.launched.entries()].filter(([id]) => id.startsWith(`${run.root_workflow_id}:`) && id.includes(":stage:build:unit:"));
  expect(builds).toHaveLength(2);
  for (const [, request] of builds) {
    expect(request.inputs.map((input) => input.output_name).sort()).toEqual(["brief", "repository_refs"]);
    expect((request.resolved_config as { readonly worktree?: { readonly baseRef?: string } }).worktree?.baseRef).toBe(HARNESS_BASE_BRANCH);
    expect((request.resolved_config as { readonly workdir?: string }).workdir).toBe(oakridge.repository.path);
  }

  // Each assessor must see exactly its own cohort's build, in the workspace
  // that produced it — not a sibling's, and not both.
  const assessors = [...agent.launched.entries()].filter(([id]) => id.startsWith(`${run.root_workflow_id}:`) && id.includes(":stage:assessor:unit:"));
  expect(assessors).toHaveLength(2);
  for (const [, request] of assessors) {
    const buildResult = request.inputs.find((input) => input.output_name === "build_result");
    expect(request.workspace_source?.execution_id).toBe(buildResult?.producer_execution_id);
    // brief, build_result, and the provisioned refs the assessor now declares.
    expect(request.inputs.map((input) => input.output_name).sort()).toEqual(["brief", "build_result", "repository_refs"]);
    // The cohort-scoped inputs are one cohort's. The refs are the run's — keyed
    // by repository, produced once, and seen the same way by every unit — so
    // they are deliberately not part of that pairing.
    const cohortScoped = request.inputs.filter((input) => input.output_name !== "repository_refs");
    expect(new Set(cohortScoped.map((input) => input.unit_id)).size).toBe(1);
  }
}, 240_000);

/**
 * A second run over an epic branch that already exists, and has moved on.
 *
 * The branch is advanced past the base branch first, standing in for cohort
 * work merged by an earlier run. What the second run must report is that
 * advanced commit: reading it proves the branch was adopted where it actually
 * is, and that the final local fetch refreshed the tracking ref rather than
 * leaving `origin/<epic>` on whatever this working copy last saw. A stale
 * tracking ref is not a cosmetic problem — it is the ref every cohort's
 * worktree is cut from.
 */
e2e("a second run over an existing base branch adopts it where it now is", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const context = runContext(oakridge.base_url, oakridge.repository.path);
  const first = await launchRun(oakridge.base_url, oakridge.definition.id, context);
  oakridge.started_runs.push(first.root_workflow_id);
  try {
    await awaitCondition("the first run to provision its refs", async () =>
      (await oakridge.repository.list_origin_branches()).includes(HARNESS_BASE_BRANCH) ? true : null, 60_000);
    const advanced = await oakridge.repository.advance_origin_branch(HARNESS_BASE_BRANCH, "cohort work already merged into the epic");

    const second = await launchRun(oakridge.base_url, oakridge.definition.id, { ...context, brief_notes: "second run over the same epic" });
    oakridge.started_runs.push(second.root_workflow_id);
    const refs = await awaitCondition(() => `the second run to provision from the existing epic branch`, async () => {
      const state = await DBOS.getEvent<StageRerunState>(stageCoordinatorWorkflowId(second.root_workflow_id, "provision_refs"), stageRerunStateKey("oakridge" as UnitId), { timeoutSeconds: 0 });
      if (state?.status === "waiting") throw new Error(`provisioning failed: ${state.code} ${state.detail}`);
      const detail = await readRun(oakridge.base_url, second.run_id);
      const stage = detail.stages.find((candidate) => candidate.name === "provision_refs");
      return stage?.artifacts[0] ?? null;
    }, 60_000);

    const artifact = await readArtifact(oakridge.base_url, refs.id);
    expect(artifact.revisions[0]?.body).toEqual({ repository_key: "oakridge", repository_path: oakridge.repository.path,
      integration_branch: HARNESS_INTEGRATION_BRANCH, base_branch: HARNESS_BASE_BRANCH, base_head_sha: advanced });
    expect(await oakridge.repository.origin_branch_sha(HARNESS_BASE_BRANCH)).toBe(advanced);
  } finally {
    agent.releaseAll();
  }
}, 180_000);

/**
 * The real failure path, at the stage that owns the requirement.
 *
 * A repository that is not a git repository used to be refused at launch, by
 * the one participant that could only ever say no. It is now a stage outcome:
 * the unit parks with the reason, an operator can see it and retry it, and
 * nothing about the rest of the graph is special-cased around it.
 */
e2e("a repository that is not a git repository fails at provisioning, with the reason", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const context = runContext(oakridge.base_url, oakridge.repository.path);
  const brokenContext = { ...context, brief_notes: "unprovisionable repository",
    repositories: [{ ...context.repositories[0]!, path: `${oakridge.repository.path}/not-a-repository` }] };
  const run = await launchRun(oakridge.base_url, oakridge.definition.id, brokenContext);
  oakridge.started_runs.push(run.root_workflow_id);

  try {
    const parked = await awaitCondition("the provisioning unit to park with its reason", async () =>
      DBOS.getEvent<StageRerunState>(stageCoordinatorWorkflowId(run.root_workflow_id, "provision_refs"), stageRerunStateKey("oakridge" as UnitId), { timeoutSeconds: 0 }), 60_000);
    expect(parked.status).toBe("waiting");
    expect(parked.status === "waiting" ? parked.code : null).toBe("not_a_git_repository");
    expect(parked.status === "waiting" ? parked.detail : null).toContain("is not a git repository");
    // The failure belongs to provisioning alone: nothing downstream of it ran.
    expect([...agent.launched.keys()].some((id) => id.startsWith(`${run.root_workflow_id}:stage:build`))).toBe(false);
  } finally {
    await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    agent.releaseAll();
  }
}, 120_000);

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

  const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
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
 * A cohort is read through the output that declares the handoff.
 *
 * A build unit emits more than one artifact and only one of them is released
 * through a handoff, whose workflow is named after that artifact. The
 * projection used to take whichever of the unit's revisions sorted first by
 * version, with no filter on the output name — so which artifact a cohort was
 * read through came down to where two rows happened to land in the heap. When
 * it came down wrong the handoff workflow named after the other artifact did
 * not exist, `handoff_status` read NULL, and the cohort reported `building`
 * forever.
 *
 * That single field is what *both* participants who can close the wait read:
 * the inbox offers `confirm_merged` only for a cohort in `github_review`, and
 * the poller's sweep selects the cohorts it asks GitHub about the same way. A
 * cohort that loses the coin flip is therefore not slow, it is unreachable —
 * and it takes the whole run's completion with it, because the build unit is
 * never accepted.
 *
 * Emission order does not pin this. The suite passed for months on those two
 * rows landing in the order that happened to work, and a run against the
 * operator's own database landed them the other way and stalled. So the losing
 * side is forced: `pr_summary` is given the higher version — the key the old
 * ordering sorted on — and the cohort has to still be reachable through it.
 */
e2e("a cohort stays reachable when a sibling output outranks its handoff", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id, run.run_id);
  const sql = PgPostgresExecutor.connect(databaseUrl!);

  try {
    // Driven only as far as the first cohort's merge being owed. Reviews are
    // deliberately not closed here: this test is about the offer surviving.
    const owed = await awaitCondition(() => `a merge to be owed (${driver.diagnosis})`, async () => {
      await driver.driveNewExecutions();
      await driver.approvePendingGates();
      const inbox = await readReviewInbox(oakridge.base_url);
      return inbox.items.find((item) => item.kind === "pull_request_merge" && item.run_id === run.run_id) ?? null;
    }, 180_000);

    // The sibling output is promoted above the handoff's on the key the broken
    // ordering used. Nothing else about the run changes.
    const promoted = await sql.query<{ readonly id: string }>(
      `UPDATE oakridge.artifact SET version = 9
       WHERE stage_instance_id = $1 AND unit_id = $2 AND artifact_type = $3 RETURNING id::text`,
      [owed.stage_instance_id, owed.unit_id, "dev.pr_summary"]);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).not.toBe(owed.artifact_revision_id);

    const after = (await readReviewInbox(oakridge.base_url)).items
      .filter((item) => item.kind === "pull_request_merge" && item.run_id === run.run_id);
    expect(after).toHaveLength(1);
    expect(after[0]!.artifact_revision_id).toBe(owed.artifact_revision_id);
    expect(after[0]!.pr_url).toBe(cohortPullRequestUrl(owed.unit_id as UnitId));

    // Still reachable is the claim, so it is closed through the offer.
    const attempt = await confirmCohortMerged(oakridge.base_url, `${owed.stage_instance_id}:${owed.unit_id}`);
    expect(attempt).toEqual({ kind: "accepted", outcome: "completed" });
  } finally {
    try {
      await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    } finally {
      agent.releaseAll();
      await sql.close();
    }
  }
}, 240_000);

/**
 * A rejected build revises, and its assessment is decided again.
 *
 * The assessor's gate declares `revision_target: "upstream_handoff"`: a
 * rejection asks the *build* for changes, not the assessor. Every step of that
 * round trip is driven here through the real routes, because each one was
 * broken in a different way and none of them had ever run:
 *
 * - the rejection reaches the build's agent and only the build's agent;
 * - the build's revision becomes available to the assessor, which is asked to
 *   look again rather than left holding a superseded artifact;
 * - the assessor's re-emitted assessment opens a fresh gate;
 * - approving *that* resolves the handoff on the revised build result, which
 *   used to fail because the assessor's recorded input still named revision one.
 */
e2e("a rejected build revises, and the reassessment releases it", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
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
    const buildInput = assessorRequest.inputs.find((input) => input.output_name === "build_result");
    const buildExecutionWorkflowId = [...driver.drivenExecutions].find((id) => id.includes(":stage:build:unit:"));
    const buildRequest = buildExecutionWorkflowId ? agent.launched.get(buildExecutionWorkflowId) : undefined;
    if (!buildRequest || !buildInput) throw new Error("the build under assessment disappeared");

    const [firstAssessment] = await emitDeclaredArtifacts(oakridge.base_url, assessorRequest);
    if (!firstAssessment) throw new Error("the assessor emitted nothing");
    await decideGate(oakridge.base_url, firstAssessment.artifact_id, "request_revision");

    // The build is sent back to work, and nobody else is.
    const rejection = await awaitCondition(() => `the build to be asked for a revision (delivered: ${JSON.stringify(agent.deliveries)})`,
      async () => (agent.deliveries.length > 0 ? [...agent.deliveries] : null), 30_000);
    expect(rejection.map((delivery) => delivery.execution_id)).toEqual([String(buildRequest.execution_id)]);

    // The build revises. Its new build_result supersedes the one the assessor
    // reviewed, and the assessor is asked to review the replacement.
    const revisedBuild = await emitDeclaredArtifacts(oakridge.base_url, buildRequest, { revision: 2, outputs: ["build_result"] });
    const revisedResult = revisedBuild.find((artifact) => artifact.output_name === "build_result");
    expect(revisedResult?.release).toBe("waiting_handoff");
    expect(revisedResult?.artifact_id).not.toBe(buildInput.artifact_id);

    const reReview = await awaitCondition(() => `the assessor to be asked to review the revision (delivered: ${JSON.stringify(agent.deliveries)})`,
      async () => agent.deliveries.find((delivery) => delivery.execution_id === String(assessorRequest.execution_id)) ?? null, 30_000);
    expect(reReview.delivery_key).toContain(revisedResult?.artifact_id ?? "missing");

    // The reassessment opens its own gate, and approving it releases the
    // revised build result rather than the superseded one.
    const [secondAssessment] = await emitDeclaredArtifacts(oakridge.base_url, assessorRequest, { revision: 2 });
    expect(secondAssessment?.artifact_id).not.toBe(firstAssessment.artifact_id);
    await decideGate(oakridge.base_url, secondAssessment!.artifact_id, "approve");

    const cohortId = `${buildRequest.stage_instance_id}:${buildInput.unit_id}`;
    await awaitCondition(`the revised build result to reach its external review`, async () => {
      const attempt = await confirmCohortMerged(oakridge.base_url, cohortId);
      return attempt.kind === "accepted" && attempt.outcome === "completed" ? true : null;
    }, 60_000);
  } finally {
    await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    agent.releaseAll();
  }
}, 240_000);

/**
 * A build revised after its assessment was already approved.
 *
 * This is the operator's review-round flow, and it is ordinary: the pull
 * request picks up comments after the assessment is approved, the build agent
 * applies them, and emits again. That revision supersedes an artifact the
 * assessor has *already accepted*, and the assessor's execution returned at the
 * moment it accepted it.
 *
 * The coordinator delivered a revision only to a consumer still running, so
 * this one went nowhere. The build's replacement opened a fresh handoff wait
 * with no decider, no gate opened, and the review inbox — which is built from
 * open gates — offered nothing. The cohort read `assessing` with no participant
 * able to advance it, and every cohort admitted behind it stayed blocked.
 */
e2e("a build revised after its assessment was approved is reassessed, not stranded", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);

  const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(run.root_workflow_id);
  const driver = new RunDriver(oakridge.base_url, agent, run.root_workflow_id, run.run_id);
  const isAssessor = (id: string): boolean => id.includes(":stage:assessor:unit:");

  try {
    const assessorId = await awaitCondition(() => `an assessor to start (${driver.diagnosis})`, async () => {
      await driver.driveNewExecutions((id) => !isAssessor(id));
      await driver.approvePendingGates();
      return [...agent.launched.keys()].find((id) => id.startsWith(`${run.root_workflow_id}:`) && isAssessor(id)) ?? null;
    }, 120_000);

    const assessorRequest = agent.launched.get(assessorId);
    if (!assessorRequest) throw new Error("the assessor request disappeared");
    const buildInput = assessorRequest.inputs.find((input) => input.output_name === "build_result");
    const buildExecutionWorkflowId = [...driver.drivenExecutions].find((id) => id.includes(":stage:build:unit:"));
    const buildRequest = buildExecutionWorkflowId ? agent.launched.get(buildExecutionWorkflowId) : undefined;
    if (!buildRequest || !buildInput) throw new Error("the build under assessment disappeared");

    // Approved, not rejected: the build result is accepted and the cohort is
    // waiting on nothing but its pull request. This is the state the revision
    // has to arrive into.
    const [assessment] = await emitDeclaredArtifacts(oakridge.base_url, assessorRequest);
    if (!assessment) throw new Error("the assessor emitted nothing");
    agent.succeed(assessorRequest.execution_id);
    await decideGate(oakridge.base_url, assessment.artifact_id, "approve");

    const cohortId = `${buildRequest.stage_instance_id}:${buildInput.unit_id}`;
    await awaitCondition(() => `the cohort to be offered a merge (${driver.diagnosis})`, async () => {
      const inbox = await readReviewInbox(oakridge.base_url);
      return inbox.items.find((item) => item.kind === "pull_request_merge" && item.unit_id === buildInput.unit_id) ?? null;
    }, 60_000);

    // The review-round fix. The accepted revision is superseded and the cohort
    // owes an assessment again — of an assessor that has already finished.
    const revised = await emitDeclaredArtifacts(oakridge.base_url, buildRequest, { revision: 2, outputs: ["build_result"] });
    const revisedResult = revised.find((artifact) => artifact.output_name === "build_result");
    expect(revisedResult?.release).toBe("waiting_handoff");
    expect(revisedResult?.artifact_id).not.toBe(buildInput.artifact_id);

    // The assessor is put back to work under an execution named off the
    // revising artifact — its ordinary id would be deduplicated onto the run
    // that already returned.
    const relaunchedId = await awaitCondition(() => `the assessor to be relaunched (launched ${agent.launched.size})`,
      async () => [...agent.launched.keys()].find((id) => id.includes(`:revision:${revisedResult?.artifact_id}`)) ?? null, 60_000);
    const relaunched = agent.launched.get(relaunchedId);
    if (!relaunched) throw new Error("the relaunched assessor disappeared");
    expect(relaunched.inputs.some((input) => input.artifact_id === revisedResult?.artifact_id)).toBe(true);

    // And it carries the cohort the rest of the way, through the same routes.
    const [reassessment] = await emitDeclaredArtifacts(oakridge.base_url, relaunched, { revision: 2 });
    expect(reassessment?.artifact_id).not.toBe(assessment.artifact_id);
    agent.succeed(relaunched.execution_id);
    await decideGate(oakridge.base_url, reassessment!.artifact_id, "approve");

    await awaitCondition(`the revised build result to reach its external review`, async () => {
      const attempt = await confirmCohortMerged(oakridge.base_url, cohortId);
      return attempt.kind === "accepted" && attempt.outcome === "completed" ? true : null;
    }, 60_000);
  } finally {
    await DBOS.cancelWorkflow(run.root_workflow_id, { cancelChildren: true });
    agent.releaseAll();
  }
}, 240_000);

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

    const run = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
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
    //
    // Two executions are contained, not one: the run's first stages are the
    // spec analyzer and the repository provisioner, and containment does not
    // special-case the deterministic one. Fencing it is a no-op — there is no
    // process to stop — but it is reached through the same path as any other,
    // which is what keeps cancellation free of executor-specific branches.
    const result = await cancellation.getResult();
    expect(result.fenced_execution_count).toBe(2);
    expect(closed).toEqual([SESSION_ID]);
    expect(refusals).toEqual([]);
  } finally {
    idle.releaseAll();
    kbblServer.stop(true);
    oakridgeServer.stop(true);
  }
}, 180_000);

/**
 * The seam every other test in this file still fakes.
 *
 * Above, the agent is a scripted scenario: `start_or_attach` resolves a promise
 * and `observe_terminal` returns whatever the test says. Real runs do not work
 * that way. Oakridge calls kbbl over HTTP, kbbl cuts a worktree and spawns a
 * process, the prompt reaches that process over a transport, and the artifact
 * comes back through the emit route. None of that was covered, and every stall
 * this project has shipped has lived in it.
 *
 * These run it for real and substitute only the model. Both runtimes are
 * exercised because they share nothing: claude-code pushes its prompt over an
 * MCP channel to a per-session process and finishes by exiting, while codex
 * calls `turn/start` on a shared app-server and finishes with a notification.
 */
const probeArtifact = async (runtime: StubbedRuntimeId, definitionName: string, kbbl: KbblFixture) => {
  useScenario(realKbblScenario(kbbl.base_url, oakridge.application_version));
  const definitionId = await createProbeDefinition(oakridge.base_url, runtime, definitionName);
  const run = await launchRun(oakridge.base_url, definitionId as Parameters<typeof launchRun>[1],
    runContext(oakridge.base_url, oakridge.repository.path) as never);
  oakridge.started_runs.push(run.root_workflow_id);
  return awaitCondition(
    () => `an artifact from the ${runtime} probe`,
    async () => {
      const detail = await readRun(oakridge.base_url, run.run_id);
      return detail.stages[0]?.artifacts[0] ?? null;
    },
    90_000,
  );
};

e2e("a prompt reaches a real claude-code process and its artifact comes back", async () => {
  const kbbl = await startKbblFixture({ runtimes: ["claude-code"], stub_timeout_ms: 15_000 });
  try {
    const artifact = await probeArtifact("claude-code", "real-transport-probe-claude-code", kbbl);
    expect(artifact.type_id).toBe("dev.spec_analysis");

    // The stub only ever PUTs to a URL the rendered template told it to, so an
    // artifact arriving is proof the template's emit instruction and the route
    // that serves it still agree.
    const log = await awaitCondition(
      () => "the claude-code stub to finish its artifact emission",
      async () => {
        const contents = await kbbl.stub_log();
        return contents.includes("emitted 1 artifact(s)") ? contents : null;
      },
      5_000,
    );
    expect(log).toContain("notifications/initialized");
    expect(log).toContain("emitted 1 artifact(s)");
  } finally {
    await kbbl.stop();
  }
}, 180_000);

e2e("a prompt reaches a real codex app-server and its artifact comes back", async () => {
  const kbbl = await startKbblFixture({ runtimes: ["codex"], stub_timeout_ms: 15_000 });
  try {
    const artifact = await probeArtifact("codex", "real-transport-probe-codex", kbbl);
    expect(artifact.type_id).toBe("dev.spec_analysis");

    const log = await kbbl.stub_log();
    expect(log).toContain("turn/start");
    expect(log).toContain("reporting turn complete");
  } finally {
    await kbbl.stop();
  }
}, 180_000);

/**
 * An agent that never receives its prompt parks with a reason.
 *
 * This is the near neighbour of the incident that motivated the harness: the
 * channel handshake never completed, so the prompt sat buffered in the outbox
 * while kbbl reported the session live and non-terminal.
 *
 * What it proves is the second half of that story — once the agent process
 * exits non-zero, oakridge turns it into a named, parked failure an operator
 * can rerun, rather than a run that waits forever.
 *
 * What it does NOT prove is the first half. The stub gives up on its own
 * deadline; the real agent did not, and sat idle for hours. That case has its
 * own bound and its own test — see the silent-agent test below.
 */
e2e("an agent that never receives its prompt parks the unit with a reason", async () => {
  const kbbl = await startKbblFixture({ runtimes: ["claude-code"], stub_mode: "never_initialize", stub_timeout_ms: 5_000 });
  try {
    useScenario(realKbblScenario(kbbl.base_url, oakridge.application_version));
    const definitionId = await createProbeDefinition(oakridge.base_url, "claude-code", "real-transport-probe-undelivered");
    const run = await launchRun(oakridge.base_url, definitionId as Parameters<typeof launchRun>[1],
      runContext(oakridge.base_url, oakridge.repository.path) as never);
    oakridge.started_runs.push(run.root_workflow_id);

    // A failed unit parks for rerun rather than failing its stage, so the stage
    // stays in flight and the rerun state is where the reason lives.
    const parked = await awaitCondition("the probe unit to park with its reason", async () =>
      DBOS.getEvent<StageRerunState>(stageCoordinatorWorkflowId(run.root_workflow_id, "probe"),
        stageRerunStateKey("0" as UnitId), { timeoutSeconds: 0 }), 90_000);
    expect(parked.status).toBe("waiting");
    expect(parked.status === "waiting" ? parked.code : null).toBe("executor_exit_nonzero");
    expect(await kbbl.stub_log()).toContain("no prompt arrived within");
  } finally {
    await kbbl.stop();
  }
}, 180_000);

/**
 * The incident itself: an agent that is alive, and never does anything.
 *
 * The real session started, was handed a prompt it never processed, and simply
 * sat there. kbbl answered "not terminal" — truthfully — on every one of the
 * four hundred polls oakridge made, because the session genuinely had not
 * ended. Nothing on either side bounded that, so the run stayed "running"
 * indefinitely and the only signal was an operator noticing.
 *
 * The stub reproduces it exactly: it takes the prompt and then holds, without
 * exiting. What must happen now is that the silence itself becomes the
 * failure, with a code naming what went wrong.
 */
e2e("an agent that goes silent fails the unit instead of being polled forever", async () => {
  const kbbl = await startKbblFixture({ runtimes: ["claude-code"], stub_mode: "silent" });
  try {
    useScenario(realKbblScenario(kbbl.base_url, oakridge.application_version, { max_silent_ms: 2_000 }));
    const definitionId = await createProbeDefinition(oakridge.base_url, "claude-code", "real-transport-probe-silent");
    const run = await launchRun(oakridge.base_url, definitionId as Parameters<typeof launchRun>[1],
      runContext(oakridge.base_url, oakridge.repository.path) as never);
    oakridge.started_runs.push(run.root_workflow_id);

    const parked = await awaitCondition("the silent unit to park with its reason", async () =>
      DBOS.getEvent<StageRerunState>(stageCoordinatorWorkflowId(run.root_workflow_id, "probe"),
        stageRerunStateKey("0" as UnitId), { timeoutSeconds: 0 }), 90_000);
    expect(parked.status).toBe("waiting");
    expect(parked.status === "waiting" ? parked.code : null).toBe("executor_silent_timeout");
    expect(parked.status === "waiting" ? parked.detail : null).toContain("reported no activity");

    // The agent really did receive its prompt — this is a silent agent, not an
    // undelivered one. Distinguishing them is the whole point of the code.
    expect(await kbbl.stub_log()).toContain("received the prompt, emitting nothing");
  } finally {
    await kbbl.stop();
  }
}, 180_000);
