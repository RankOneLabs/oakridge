/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "@playwright/test";

import type { OperatorParkedGate } from "../src/domain/operator-projections";
import type { ArtifactId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { HARNESS_BASE_BRANCH, awaitCondition, installIntegrationRuntime, runContext,
  scriptedAgentScenario, useScenario, type CohortPlanEntry, type IntegrationRuntime } from "./support/dev-flow-harness";
import { decideGate, driveRun, launchRun, listRunGates, parsePromptPublication, readRun, readRunRecordFingerprint } from "./support/dev-flow-driver";
import { findTestDatabaseUrl } from "./support/durable-database";
import { attemptsAfterCancel, buildStageRow, buildUnitRows, cohortMachineState, cohortStateTrace,
  runOutcome,
  workflowRunState } from "./support/v15-run-queries";

const acceptanceEnabled = process.env.OAKRIDGE_ACCEPTANCE === "1";
let databaseUrl: string | null = null;
const e2e = acceptanceEnabled ? test : test.skip;
let oakridge: IntegrationRuntime;
let sql: PgPostgresExecutor;
let browser: Browser;

if (acceptanceEnabled) {
  beforeAll(async () => {
    databaseUrl = process.env.OAKRIDGE_TEST_DATABASE_URL ?? await findTestDatabaseUrl();
    if (databaseUrl === null) throw new Error("no PostgreSQL test database is available for the deterministic acceptance harness");
    oakridge = await installIntegrationRuntime(databaseUrl);
    sql = PgPostgresExecutor.connect(databaseUrl);
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    if (oakridge) await oakridge.stop();
    if (browser) await browser.close();
    if (sql) await sql.close();
  }, 60_000);
}

const countBuildUnits = async (runId: WorkflowRunId): Promise<number> => (await buildUnitRows(sql, runId)).length;

const launchBrowserRun = async (page: Page, title: string) => {
  const before = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly { readonly id: string }[];
  const beforeIds = new Set(before.map((run) => run.id));
  await page.goto(`${oakridge.kbbl_url}/#oakridge/new-run`);
  await page.getByLabel("Epic title").fill(title);
  await page.getByLabel("Repository 1 key").fill("oakridge");
  await page.getByLabel("Repository 1 GitHub owner").fill("RankOneLabs");
  await page.getByLabel("Repository 1 GitHub name").fill("oakridge");
  await page.getByLabel("Repository 1 path").fill(oakridge.repository.path);
  await page.getByRole("textbox", { name: "Brief notes", exact: true }).fill("browser acceptance");
  await page.getByRole("button", { name: "Start Run" }).click();
  const launched = await awaitCondition("browser launch to appear in the public API", async () => {
    const runs = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly {
      readonly id: string; readonly current_attempt_root_workflow_id: string }[];
    return runs.find((run) => !beforeIds.has(run.id)) ?? null;
  }, 30_000);
  oakridge.started_runs.push(launched.current_attempt_root_workflow_id);
  return { run_id: launched.id as WorkflowRunId, root_workflow_id: launched.current_attempt_root_workflow_id };
};

const waitForCohortState = (runId: WorkflowRunId, stageKey: string, cohortKey: string, state: string, timeoutMs = 30_000) =>
  awaitCondition(`${stageKey}/${cohortKey} to enter ${state}`, async () =>
    (await cohortMachineState(sql, runId, stageKey, cohortKey)) === state ? true : null, timeoutMs);

const assertCohortTrace = async (runId: WorkflowRunId, stageKey: string, cohortKey: string,
  expected: readonly { readonly event: string; readonly from: string; readonly to: string }[]): Promise<void> => {
  const trace = await cohortStateTrace(sql, runId, stageKey, cohortKey);
  expect(trace.length).toBeGreaterThan(0);
  for (const step of trace) {
    expect(step.event_kind).not.toBeNull();
    expect(step.from_state).not.toBeNull();
    expect(step.to_state).not.toBeNull();
  }
  let nextIndex = 0;
  for (const step of trace) {
    const next = expected[nextIndex];
    if (next && step.event_kind === next.event && step.from_state === next.from && step.to_state === next.to) nextIndex += 1;
  }
  expect(nextIndex).toBe(expected.length);
};

const launchAgentRun = async (agent: ReturnType<typeof scriptedAgentScenario>) => {
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  return launched;
};

const waitPublication = (agent: ReturnType<typeof scriptedAgentScenario>, output: string, index: number) =>
  awaitCondition(`${output} publication response ${index}`, async () =>
    agent.deliveries.find((delivery) => delivery.delivery_key.startsWith(`publication:${output}:`)
      && delivery.delivery_key.endsWith(`:${index}`)) ?? null, 60_000);

const attemptCount = async (cohortId: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM oakridge.attempt WHERE cohort_id=$1", [cohortId]);
  return Number(rows[0]?.count ?? 0);
};

const gateFirstArtifactId = (gate: OperatorParkedGate): ArtifactId => {
  const artifactId = (gate as unknown as { readonly artifact_revision_ids?: readonly ArtifactId[] }).artifact_revision_ids?.[0]
    ?? gate.artifact_revision_id;
  if (!artifactId) throw new Error(`gate ${gate.id} has no artifact`);
  return artifactId;
};

e2e("S22 browser launches a run and decides its first gate through kbbl", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const page = await browser.newPage();
  try {
    const launched = await launchBrowserRun(page, "Browser acceptance run");
    let lastDetail: unknown = null;
    let kbblSessions: unknown = null;
    const gate = await awaitCondition(() => `browser run's first gate; last run detail=${JSON.stringify(lastDetail)}; kbbl sessions=${JSON.stringify(kbblSessions)}; fake launches=${agent.launched.size}`, async () => {
      lastDetail = await readRun(oakridge.base_url, launched.run_id);
      kbblSessions = await fetch(`${oakridge.kbbl_url}/sessions`).then((response) => response.json()).catch((error) => String(error));
      return (await listRunGates(oakridge.base_url, launched.run_id))[0] ?? null;
    }, 30_000);

    await page.goto(`${oakridge.kbbl_url}/#oakridge/review-inbox`);
    await page.getByTestId("or-decision-approve").first().click();
    await awaitCondition("browser gate decision in the public API", async () =>
      (await listRunGates(oakridge.base_url, launched.run_id)).some((candidate) => candidate.id === gate.id) ? null : true, 30_000);

    await page.goto(`${oakridge.kbbl_url}/#oakridge/run/${launched.run_id}`);
    const activity = page.getByTestId("or-run-activity");
    await activity.getByText("Stage started").first().waitFor();
    await activity.getByText("Gate decided").first().waitFor();
    expect(await page.getByText("Run activity is unavailable.").count()).toBe(0);

    await assertCohortTrace(launched.run_id, "spec_analyzer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "review" },
      { event: "gate_decided", from: "review", to: "done" },
    ]);
    const buildGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (candidate) => candidate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((candidate) => candidate.stage_name === "build" && candidate.unit_id === "a") ?? null,
      timeout_ms: 120_000,
    });
    const artifacts = (buildGate.value as unknown as { readonly artifact_revision_ids?: readonly ArtifactId[] }).artifact_revision_ids;
    expect(artifacts).toHaveLength(2);
    await page.goto(`${oakridge.kbbl_url}/#oakridge/review-inbox`);
    const card = page.getByTestId("or-gate-card").filter({ hasText: "build" }).first();
    await card.waitFor();
    for (const artifactId of artifacts ?? []) expect(await card.textContent()).toContain(artifactId);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    await page.close();
    agent.releaseAll();
  }
}, 240_000);

e2e("S20 missing publication contract leaves the spec cohort lost", async () => {
  const agent = scriptedAgentScenario({ strip_publication_contract: true });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    const diagnosis = await awaitCondition("the run to record a failed agent attempt", async () => {
      const response = await fetch(`${oakridge.base_url}/runs/${launched.run_id}/diagnosis`);
      const value = await response.json() as { readonly sessions?: readonly { readonly status: string }[] };
      return value.sessions?.some((session) => session.status === "failed") ? value : null;
    }, 30_000);
    expect(diagnosis.sessions?.some((session) => session.status === "failed")).toBe(true);
    const refusedPrompt = agent.deliveries.find((delivery) => delivery.delivery_key.startsWith("missing-publication-contract"))?.prompt;
    expect(refusedPrompt).toBeDefined();
    expect(refusedPrompt).not.toContain("## Oakridge v2 artifact publication");
    const detail = await awaitCondition("failed publication attempt to block for operator retry", async () => {
      const run = await readRun(oakridge.base_url, launched.run_id);
      const unit = run.stages.find((stage) => stage.name === "spec_analyzer")?.units[0];
      return unit?.status === "blocked" && unit.blocked_reason === "retry" && unit.next_actor === "operator" ? run : null;
    }, 30_000);
    expect(detail.status).toBe("active");
    expect(await cohortMachineState(sql, launched.run_id, "spec_analyzer", "0")).toBe("lost");
    await assertCohortTrace(launched.run_id, "spec_analyzer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "session_ended", from: "working", to: "lost" },
    ]);
  } finally {
    agent.releaseAll();
  }
}, 60_000);


e2e("S1 straight-through browser run respects dependency merges", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const page = await browser.newPage();
  try {
    const launched = await launchBrowserRun(page, "S1 dependency merge run");
    expect(launched.root_workflow_id).toBe(`v15-run:${launched.run_id}`);
    const briefGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "brief_writer") ?? null,
      timeout_ms: 90_000,
    });
    expect((briefGate.value as unknown as { readonly artifact_revision_ids?: readonly ArtifactId[] }).artifact_revision_ids).toHaveLength(2);
    expect(await countBuildUnits(launched.run_id)).toBe(0);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await cohortMachineState(sql, launched.run_id, "build", "a")) === "awaiting_merge" ? true : null,
      timeout_ms: 120_000,
    });
    expect(await cohortMachineState(sql, launched.run_id, "build", "b")).toBe("pending");
    const mergeCommit = await agent.merge("a" as UnitId);
    await waitForCohortState(launched.run_id, "build", "a", "done");
    await waitForCohortState(launched.run_id, "build", "b", "building");
    const buildStage = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    const branch = `cohort/${buildStage?.stage_instance_id}/b`;
    const branchBase = await awaitCondition("b's branch to contain its build commit", async () => {
      const parent = await oakridge.repository.origin_branch_parent_sha(branch);
      return parent === mergeCommit ? parent : null;
    }, 30_000);
    expect(branchBase).toBe(mergeCommit);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await cohortMachineState(sql, launched.run_id, "build", "b")) === "awaiting_merge" ? true : null,
      timeout_ms: 120_000,
    });
    await agent.merge("b" as UnitId);
    await waitForCohortState(launched.run_id, "build", "b", "done");
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
    await assertCohortTrace(launched.run_id, "provision_repository_refs", "oakridge", [
      { event: "started", from: "pending", to: "provisioning" },
      { event: "artifact_published", from: "provisioning", to: "done" },
    ]);
    for (const stageKey of ["spec_analyzer", "plan_writer", "brief_writer"]) {
      await assertCohortTrace(launched.run_id, stageKey, "0", [
        { event: "started", from: "pending", to: "working" },
        { event: "artifact_published", from: "working", to: "review" },
        { event: "gate_decided", from: "review", to: "done" },
      ]);
    }
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "assessing" },
      { event: "artifact_published", from: "assessing", to: "assessment_review" },
      { event: "gate_decided", from: "assessment_review", to: "awaiting_merge" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
    await assertCohortTrace(launched.run_id, "build", "b", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "assessing" },
      { event: "artifact_published", from: "assessing", to: "assessment_review" },
      { event: "gate_decided", from: "assessment_review", to: "awaiting_merge" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
    await assertCohortTrace(launched.run_id, "final_integration", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "merge_review" },
      { event: "gate_decided", from: "merge_review", to: "done" },
    ]);
    expect(await oakridge.repository.list_origin_branches()).toContain(HARNESS_BASE_BRANCH);
  } finally {
    await page.close();
    agent.releaseAll();
  }
}, 360_000);

const awaitBuildMerge = async (agent: ReturnType<typeof scriptedAgentScenario>) => {
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const reached = await driveRun(oakridge.base_url, agent, launched, {
    decide: () => "approve",
    until: async () => {
      const detail = await readRun(oakridge.base_url, launched.run_id);
      const stage = detail.stages.find((candidate) => candidate.name === "build");
      const unit = stage?.units[0];
      const state = unit?.params as { readonly build_state?: { readonly phase?: string } } | null;
      return state?.build_state?.phase === "awaiting_merge" && stage && unit
        ? `${stage.stage_instance_id}:${unit.unit_id}` : null;
    },
    timeout_ms: 120_000,
  });
  return { launched, cohort_address: reached.value };
};

for (const [variant, check] of [["base", "base.ref"], ["head_ref", "head.ref"], ["head_sha", "head.sha"]] as const) {
  e2e(`S2 wrong PR ${variant} is refused at publish`, async () => {
    const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }], pr_summary_mismatch: variant });
    const launched = await launchAgentRun(agent);
    try {
      await driveRun(oakridge.base_url, agent, launched, {
        decide: (gate) => gate.stage_name === "build" ? null : "approve",
        until: async () => (await readRun(oakridge.base_url, launched.run_id)).stages
          .find((stage) => stage.name === "build")?.units.some((unit) => unit.unit_id === "a") ? true : null,
        timeout_ms: 90_000,
      });
      const refused = await waitPublication(agent, "pr_summary", 0);
      expect(refused.delivery_key).toContain(":409:");
      expect(refused.prompt).toContain("pr_mismatch");
      expect(refused.prompt).toContain(check);
      await driveRun(oakridge.base_url, agent, launched, {
        decide: (gate) => gate.stage_name === "build" ? null : "approve",
        until: async () => (await cohortMachineState(sql, launched.run_id, "build", "a")) === "build_review" ? true : null,
        timeout_ms: 90_000,
      });
      const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
      const cohort = build?.units.find((unit) => unit.unit_id === "a");
      expect(cohort).toBeDefined();
      expect(await attemptCount(cohort!.cohort_id)).toBe(1);
      await assertCohortTrace(launched.run_id, "build", "a", [
        { event: "started", from: "pending", to: "building" },
        { event: "artifact_published", from: "building", to: "build_review" },
      ]);
    } finally {
      await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
      agent.releaseAll();
    }
  }, 180_000);
}

e2e("S3 unreadable GitHub returns two 503s before publication succeeds", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  agent.fail("a" as UnitId, 503, 2);
  const launched = await launchAgentRun(agent);
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).stages
        .find((stage) => stage.name === "build")?.units.some((unit) => unit.unit_id === "a") ? true : null,
      timeout_ms: 90_000,
    });
    const first = await waitPublication(agent, "pr_summary", 0);
    expect(Number(first.delivery_key.split(":")[2])).toBe(503);
    const second = await waitPublication(agent, "pr_summary", 1);
    const third = await waitPublication(agent, "pr_summary", 2);
    expect(Number(second.delivery_key.split(":")[2])).toBe(503);
    expect(Number(third.delivery_key.split(":")[2])).toBeGreaterThanOrEqual(200);
    expect(Number(third.delivery_key.split(":")[2])).toBeLessThan(300);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await cohortMachineState(sql, launched.run_id, "build", "a")) === "build_review" ? true : null,
      timeout_ms: 90_000,
    });
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S2 replacement PR number is refused while the approved PR remains bound", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  const launched = await launchAgentRun(agent);
  try {
    const firstGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build") ?? null,
      timeout_ms: 90_000,
    });
    const responsesBefore = agent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:pr_summary:")).length;
    agent.pr_summary_mismatch = "number";
    await decideGate(oakridge.base_url, gateFirstArtifactId(firstGate.value), "request_revision");
    const refused = await awaitCondition("replacement PR number refusal", async () =>
      agent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:pr_summary:"))[responsesBefore] ?? null, 60_000);
    expect(refused.delivery_key).toContain(":409:");
    expect(refused.prompt).toContain("pr_mismatch");
    expect(refused.prompt).toContain("pr.number");
    const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    const cohort = build?.units.find((unit) => unit.unit_id === "a");
    expect(cohort).toBeDefined();
    expect(await attemptCount(cohort!.cohort_id)).toBe(2);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S9 browser Confirm merged refreshes GitHub and reports done", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  const page = await browser.newPage();
  let resumePolling: (() => void) | null = null;
  try {
    const { launched, cohort_address } = await awaitBuildMerge(agent);
    resumePolling = await oakridge.runtime.pause_pull_request_polling();
    expect(oakridge.runtime.is_pull_request_poll_running()).toBe(false);
    await agent.merge("foundation" as UnitId);
    await page.goto(`${oakridge.kbbl_url}/#oakridge/run/${launched.run_id}`);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/cohorts/${encodeURIComponent(cohort_address)}/pull_request/refresh`));
    await page.getByTestId("or-confirm-cohort-merged-btn").first().click();
    const refreshed = await (await responsePromise).json() as { readonly state: string };
    expect(refreshed).toEqual({ state: "done" });
    await awaitCondition("operator merge completion", async () =>
      (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build")?.units[0]?.status === "complete" ? true : null, 30_000);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve", until: async () =>
        (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
    await assertCohortTrace(launched.run_id, "build", "foundation", [
      { event: "started", from: "pending", to: "building" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
  } finally {
    resumePolling?.();
    await page.close();
    agent.releaseAll();
  }
}, 180_000);

e2e("S8 watcher observes a real merge on its timer", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const { launched } = await awaitBuildMerge(agent);
    await agent.merge("foundation" as UnitId);
    await awaitCondition("poller merge completion within one interval", async () =>
      (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build")?.units[0]?.status === "complete" ? true : null, 1_500);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve", until: async () =>
        (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
    const closures = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count
      FROM oakridge.pull_request_merge_closure closure
      JOIN oakridge.cohort cohort ON cohort.id=closure.cohort_id
      WHERE cohort.run_id=$1 AND cohort.cohort_key='foundation'`, [launched.run_id]);
    expect(Number(closures[0]?.count ?? 0)).toBeGreaterThan(0);
    await assertCohortTrace(launched.run_id, "build", "foundation", [
      { event: "started", from: "pending", to: "building" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
  } finally { agent.releaseAll(); }
}, 180_000);

e2e("S10 closed PR reopens, merges, or starts a replacement PR", async () => {
  const firstAgent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const first = await awaitBuildMerge(firstAgent);
    firstAgent.close("foundation" as UnitId);
    await waitForCohortState(first.launched.run_id, "build", "foundation", "pr_closed");
    firstAgent.reopen("foundation" as UnitId);
    await waitForCohortState(first.launched.run_id, "build", "foundation", "awaiting_merge");
    await firstAgent.merge("foundation" as UnitId);
    await waitForCohortState(first.launched.run_id, "build", "foundation", "done");
    await assertCohortTrace(first.launched.run_id, "build", "foundation", [
      { event: "started", from: "pending", to: "building" },
      { event: "external_observed", from: "awaiting_merge", to: "pr_closed" },
      { event: "external_observed", from: "pr_closed", to: "awaiting_merge" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
    await driveRun(oakridge.base_url, firstAgent, first.launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, first.launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
  } finally { firstAgent.releaseAll(); }

  const replacementAgent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const second = await awaitBuildMerge(replacementAgent);
    replacementAgent.close("foundation" as UnitId);
    await waitForCohortState(second.launched.run_id, "build", "foundation", "pr_closed");
    replacementAgent.pr_url_number = 99;
    const build = (await readRun(oakridge.base_url, second.launched.run_id)).stages.find((stage) => stage.name === "build");
    const cohort = build?.units.find((unit) => unit.unit_id === "foundation");
    if (!cohort) throw new Error("replacement cohort missing");
    const responsesBefore = replacementAgent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:pr_summary:")).length;
    const response = await fetch(`${oakridge.base_url}/run-units/${cohort.cohort_id}/retry`, {
      method: "PUT", headers: { "idempotency-key": "s10-replacement" },
    });
    expect(response.status).toBe(202);
    const replacementPublish = await awaitCondition("replacement PR publication", async () =>
      replacementAgent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:pr_summary:"))[responsesBefore] ?? null, 60_000);
    expect(Number(replacementPublish.delivery_key.split(":")[2])).toBeGreaterThanOrEqual(200);
    expect(Number(replacementPublish.delivery_key.split(":")[2])).toBeLessThan(300);
    const bound = await sql.query<{ readonly forge_pull_request_id: string }>(`SELECT pr.forge_pull_request_id::text
      FROM oakridge.dev_flow_build_cohort build
      JOIN oakridge.pull_request_verification verification ON verification.id=build.current_verified_pull_request_id
      JOIN oakridge.pull_request pr ON pr.id=verification.pull_request_id
      WHERE build.cohort_id=$1`, [cohort.cohort_id]);
    expect(bound[0]?.forge_pull_request_id).toBe("99");
    const prompt = [...replacementAgent.launched.values()].map((launch) =>
      (launch.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt ?? "")
      .find((value) => value.includes("replacement_pr"));
    expect(prompt).toBeDefined();
    await assertCohortTrace(second.launched.run_id, "build", "foundation", [
      { event: "started", from: "pending", to: "building" },
      { event: "external_observed", from: "awaiting_merge", to: "pr_closed" },
      { event: "operator_retry", from: "pr_closed", to: "building" },
    ]);
  } finally { replacementAgent.releaseAll(); }
}, 360_000);

e2e("S11 merged PR at a moved head records merge drift", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const { launched } = await awaitBuildMerge(agent);
    await agent.move_head("foundation" as UnitId);
    await agent.merge("foundation" as UnitId);
    await waitForCohortState(launched.run_id, "build", "foundation", "done");
    const diagnosis = await fetch(`${oakridge.base_url}/runs/${launched.run_id}/diagnosis`).then((response) => response.json()) as {
      readonly run: { readonly stages: readonly { readonly name: string; readonly units: readonly {
        readonly unit_id: string; readonly merge_head_drift?: { readonly accepted_head_sha: string; readonly merged_head_sha: string } }[] }[] } };
    const drift = diagnosis.run.stages.find((stage) => stage.name === "build")?.units
      .find((unit) => unit.unit_id === "foundation")?.merge_head_drift;
    expect(drift).toBeDefined();
    expect(drift?.accepted_head_sha).not.toBe(drift?.merged_head_sha);
    await assertCohortTrace(launched.run_id, "build", "foundation", [
      { event: "started", from: "pending", to: "building" },
      { event: "external_observed", from: "awaiting_merge", to: "done" },
    ]);
  } finally { agent.releaseAll(); }
}, 180_000);

e2e("S4 build review revision starts round two with a fresh gate", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  const launched = await launchAgentRun(agent);
  try {
    const first = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build") ?? null,
      timeout_ms: 90_000,
    });
    expect((first.value as unknown as { readonly artifact_revision_ids?: readonly ArtifactId[] }).artifact_revision_ids).toHaveLength(2);
    await decideGate(oakridge.base_url, gateFirstArtifactId(first.value), "request_revision");
    const second = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build" && gate.id !== first.value.id) ?? null,
      timeout_ms: 90_000,
    });
    expect((second.value as unknown as { readonly artifact_revision_ids?: readonly ArtifactId[] }).artifact_revision_ids).toHaveLength(2);
    const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    const cohort = build?.units.find((unit) => unit.unit_id === "a");
    expect(cohort).toBeDefined();
    const rounds = await sql.query<{ readonly round: string | null }>(
      "SELECT to_jsonb(cohort)->>'round' AS round FROM oakridge.cohort WHERE id=$1", [cohort!.cohort_id]);
    expect(rounds[0]?.round).toBe("2");
    expect(await attemptCount(cohort!.cohort_id)).toBe(2);
    const revisionPrompt = [...agent.launched.values()].map((launch) =>
      (launch.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt ?? "")
      .find((prompt) => prompt.includes("revision_after_build_review"));
    expect(revisionPrompt).toContain("integration test request_revision");
    const fenced = await sql.query<{ readonly fenced_at: string | null }>(`SELECT session.fenced_at::text
      FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
      WHERE attempt.cohort_id=$1 AND attempt.attempt_number=1`, [cohort!.cohort_id]);
    expect(fenced[0]?.fenced_at).not.toBeNull();
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 210_000);

e2e("S5 assessment revision launches a builder with assessment feedback", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  const launched = await launchAgentRun(agent);
  try {
    const buildGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build") ?? null,
      timeout_ms: 90_000,
    });
    await decideGate(oakridge.base_url, gateFirstArtifactId(buildGate.value), "approve");
    const assessmentGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build" && gate.id !== buildGate.value.id) ?? null,
      timeout_ms: 90_000,
    });
    const assessmentArtifactId = gateFirstArtifactId(assessmentGate.value);
    await decideGate(oakridge.base_url, assessmentArtifactId, "request_revision");
    const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    const cohort = build?.units.find((unit) => unit.unit_id === "a");
    expect(cohort).toBeDefined();
    await awaitCondition("assessment revision builder attempt", async () =>
      (await attemptCount(cohort!.cohort_id)) === 3 ? true : null, 30_000);
    const prompt = [...agent.launched.values()].map((launch) =>
      (launch.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt ?? "")
      .find((value) => value.includes("revision_after_assessment"));
    expect(prompt).toContain(assessmentArtifactId);
    expect(prompt).toContain("integration test request_revision");
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "assessing" },
      { event: "artifact_published", from: "assessing", to: "assessment_review" },
      { event: "gate_decided", from: "assessment_review", to: "building" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 210_000);

e2e("S6 builder loss waits for an idempotent operator retry", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }], skip_first_publication_role: "build" });
  const launched = await launchAgentRun(agent);
  try {
    const lost = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const unit = detail.stages.find((stage) => stage.name === "build")?.units.find((candidate) => candidate.unit_id === "a");
        return unit?.status === "blocked" && unit.blocked_reason === "retry" ? unit : null;
      },
      timeout_ms: 90_000,
    });
    expect(lost.value.next_actor).toBe("operator");
    expect(await cohortMachineState(sql, launched.run_id, "build", "a")).toBe("build_lost");
    const before = await attemptCount(lost.value.cohort_id);
    await Bun.sleep(10_000);
    expect(await attemptCount(lost.value.cohort_id)).toBe(before);
    const retry = (key: string) => fetch(`${oakridge.base_url}/run-units/${lost.value.cohort_id}/retry`, {
      method: "PUT", headers: { "idempotency-key": key },
    });
    const concurrent = await Promise.all([retry("s6-retry-one"), retry("s6-retry-two")]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([202, 409]);
    const winner = concurrent.find((response) => response.status === 202)!;
    const acceptedKey = concurrent[0]?.status === 202 ? "s6-retry-one" : "s6-retry-two";
    const created = await winner.json() as { readonly attempt_id: string };
    const replay = await retry(acceptedKey);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { readonly attempt_id: string }).attempt_id).toBe(created.attempt_id);
    expect(await attemptCount(lost.value.cohort_id)).toBe(before + 1);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "session_ended", from: "building", to: "build_lost" },
      { event: "operator_retry", from: "build_lost", to: "building" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S7 assessor loss retries into assessing", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }], skip_first_publication_role: "assess" });
  const launched = await launchAgentRun(agent);
  try {
    const lost = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const unit = detail.stages.find((stage) => stage.name === "build")?.units.find((candidate) => candidate.unit_id === "a");
        return unit?.status === "blocked" && unit.blocked_reason === "retry" ? unit : null;
      },
      timeout_ms: 90_000,
    });
    expect(await cohortMachineState(sql, launched.run_id, "build", "a")).toBe("assess_lost");
    const response = await fetch(`${oakridge.base_url}/run-units/${lost.value.cohort_id}/retry`, {
      method: "PUT", headers: { "idempotency-key": "s7-assessor-retry" },
    });
    expect(response.status).toBe(202);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "assessing" },
      { event: "session_ended", from: "assessing", to: "assess_lost" },
      { event: "operator_retry", from: "assess_lost", to: "assessing" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S19 unknown brief dependency fails the roster without opening build cohorts", async () => {
  const plan: readonly CohortPlanEntry[] = [{ id: "a" as UnitId, depends_on: [] }, { id: "b" as UnitId, depends_on: ["never" as UnitId] }];
  const agent = scriptedAgentScenario({ cohorts: plan });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await workflowRunState(sql, launched.run_id)) !== "active" ? true : null,
      timeout_ms: 60_000,
    });

    expect(await workflowRunState(sql, launched.run_id)).toBe("failed");
    const outcome = await runOutcome(sql, launched.run_id);
    expect(outcome?.kind).toBe("failed");
    expect(outcome && "code" in outcome ? outcome.code : null).toBe("roster_failed");
    expect((await buildStageRow(sql, launched.run_id))?.state).toBe("failed");
    expect(await countBuildUnits(launched.run_id)).toBe(0);
    await assertCohortTrace(launched.run_id, "brief_writer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "review" },
      { event: "gate_decided", from: "review", to: "done" },
    ]);
  } finally {
    agent.releaseAll();
  }
}, 90_000);

e2e("S12 cancel closes build gates and fences live sessions in one transaction", async () => {
  const plan: readonly CohortPlanEntry[] = [
    { id: "a" as UnitId, depends_on: [] }, { id: "b" as UnitId, depends_on: [] },
  ];
  const agent = scriptedAgentScenario({ cohorts: plan, pause_before_publication_unit: "b" as UnitId });
  const launched = await launchAgentRun(agent);
  try {
    const openGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build" && gate.unit_id === "a") ?? null,
      timeout_ms: 90_000,
    });
    expect(openGate.value.id).toBeTruthy();
    await waitForCohortState(launched.run_id, "build", "b", "building");
    const response = await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    const detail = await readRun(oakridge.base_url, launched.run_id);
    expect(detail.status).toBe("cancelled");
    expect(detail.stages.find((stage) => stage.name === "build")?.status).toBe("cancelled");
    const build = detail.stages.find((stage) => stage.name === "build");
    expect(build?.units.map((unit) => `${unit.unit_id}:${unit.status}`).sort()).toEqual(["a:cancelled", "b:cancelled"]);
    const open = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count
      FROM oakridge.wait_gate WHERE run_id=$1 AND status='open'`, [launched.run_id]);
    expect(Number(open[0]?.count ?? 0)).toBe(0);
    await awaitCondition("build sessions to be fenced", async () => {
      const unfenced = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count
        FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
        JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
        WHERE attempt.run_id=$1 AND stage.stage_key='build' AND session.fenced_at IS NULL`, [launched.run_id]);
      return Number(unfenced[0]?.count ?? 0) === 0 ? true : null;
    }, 30_000);
    expect(await attemptsAfterCancel(sql, launched.run_id)).toBe(0);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "cancel", from: "build_review", to: "cancelled" },
    ]);
    await assertCohortTrace(launched.run_id, "build", "b", [
      { event: "started", from: "pending", to: "building" },
      { event: "cancel", from: "building", to: "cancelled" },
    ]);
  } finally { agent.releaseAll(); }
}, 180_000);

e2e("S13 cancel racing roster opening leaves no build attempt", async () => {
  const agent = scriptedAgentScenario();
  const launched = await launchAgentRun(agent);
  try {
    const brief = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "brief_writer") ?? null,
      timeout_ms: 90_000,
    });
    const gateArtifactId = gateFirstArtifactId(brief.value);
    const approval = decideGate(oakridge.base_url, gateArtifactId, "approve").catch(() => null);
    const cancellation = fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    const [approved, cancelled] = await Promise.all([approval, cancellation]);
    expect(cancelled.status).toBe(202);
    expect(approved === null || approved.id === brief.value.id).toBe(true);
    const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    expect(build?.units.every((unit) => unit.status === "pending")).toBe(true);
    const attempts = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count FROM oakridge.attempt attempt
      JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
      WHERE attempt.run_id=$1 AND stage.stage_key='build'`, [launched.run_id]);
    expect(Number(attempts[0]?.count ?? 0)).toBe(0);
    await assertCohortTrace(launched.run_id, "brief_writer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "review" },
    ]);
  } finally { agent.releaseAll(); }
}, 150_000);

e2e("S14 kbbl outage preserves one active build attempt through restart", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }],
    pause_before_publication_role: "build" });
  const launched = await launchAgentRun(agent);
  try {
    const building = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const unit = detail.stages.find((stage) => stage.name === "build")?.units.find((candidate) => candidate.unit_id === "a");
        return unit?.status === "active" && unit.sid ? unit : null;
      },
      timeout_ms: 90_000,
    });
    expect(await cohortMachineState(sql, launched.run_id, "build", "a")).toBe("building");
    const attemptsBefore = await attemptCount(building.value.cohort_id);
    const kbblPid = oakridge.kbbl_pid;
    process.kill(kbblPid);
    await Bun.sleep(30_000);
    expect(await cohortMachineState(sql, launched.run_id, "build", "a")).toBe("building");
    expect(await attemptCount(building.value.cohort_id)).toBe(attemptsBefore);
    await oakridge.restart_kbbl();
    agent.pause_before_publication_role = null;
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await cohortMachineState(sql, launched.run_id, "build", "a")) === "build_review" ? true : null,
      timeout_ms: 90_000,
    });
    expect(await attemptCount(building.value.cohort_id)).toBe(attemptsBefore);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    agent.pause_before_publication_role = null;
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 240_000);

e2e("S15 publish while awaiting build review returns 409 without writing", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  const launched = await launchAgentRun(agent);
  try {
    const parked = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build") ?? null,
      timeout_ms: 90_000,
    });
    const build = (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build");
    const cohort = build?.units.find((unit) => unit.unit_id === "a");
    if (!cohort) throw new Error("build cohort missing");
    const launch = [...agent.launched.values()].find((item) =>
      (item.resolved_config as { readonly session_identity?: { readonly operator_role?: string } }).session_identity?.operator_role === "build");
    const prompt = (launch?.resolved_config as { readonly rendered_prompt?: string } | undefined)?.rendered_prompt ?? "";
    const publication = parsePromptPublication(prompt);
    if (!publication) throw new Error("build publication contract missing");
    const before = await sql.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM oakridge.artifact_owner WHERE cohort_id=$1", [cohort.cohort_id]);
    const response = await fetch(`${oakridge.base_url}/work-orders/${publication.work_order_id}/emit/pr_summary`, {
      method: "PUT", headers: { "content-type": "application/json", "work-order-capability": publication.capability,
        "idempotency-key": "s15-publish-in-review" },
      body: JSON.stringify({ pr_url: "https://github.com/RankOneLabs/oakridge/pull/1", branch: publication.head_branch,
        base_branch: publication.base_branch, repository_key: "oakridge", summary: "late update" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { readonly code: string }).code).toBe("awaiting_review");
    const after = await sql.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM oakridge.artifact_owner WHERE cohort_id=$1", [cohort.cohort_id]);
    expect(after[0]?.count).toBe(before[0]?.count);
    expect(parked.value.id).toBeTruthy();
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S16 deciding an already-decided gate returns already_decided", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }] });
  const launched = await launchAgentRun(agent);
  try {
    const parked = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "build" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "build") ?? null,
      timeout_ms: 90_000,
    });
    const artifactId = gateFirstArtifactId(parked.value);
    await decideGate(oakridge.base_url, artifactId, "approve");
    const repeated = await fetch(`${oakridge.base_url}/gates/${parked.value.id}/resume`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: "s16-second-decision", artifact_revision_id: artifactId,
        gate_step: parked.value.gate_step, action: "approve", actor: "operator", operator_comment: "again" }),
    });
    expect(repeated.status).toBe(409);
    expect((await repeated.json() as { readonly code: string }).code).toBe("already_decided");
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "artifact_published", from: "building", to: "build_review" },
      { event: "gate_decided", from: "build_review", to: "assessing" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 180_000);

e2e("S17 abandoning a live cohort fails its stage and run", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "a" as UnitId, depends_on: [] }],
    pause_before_publication_role: "build" });
  const launched = await launchAgentRun(agent);
  try {
    const building = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        return detail.stages.find((stage) => stage.name === "build")?.units.find((unit) => unit.unit_id === "a" && unit.status === "active") ?? null;
      },
      timeout_ms: 90_000,
    });
    const response = await fetch(`${oakridge.base_url}/cohorts/${building.value.cohort_id}/abandon`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail: "operator abandons S17" }),
    });
    expect(response.ok).toBe(true);
    await awaitCondition("abandoned run to fail", async () =>
      (await readRun(oakridge.base_url, launched.run_id)).status === "failed" ? true : null, 30_000);
    expect(await cohortMachineState(sql, launched.run_id, "build", "a")).toBe("abandoned");
    await awaitCondition("abandoned cohort sessions to be fenced", async () => {
      const fenced = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count
        FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
        WHERE attempt.cohort_id=$1 AND session.fenced_at IS NULL`, [building.value.cohort_id]);
      return Number(fenced[0]?.count ?? 0) === 0 ? true : null;
    }, 30_000);
    await assertCohortTrace(launched.run_id, "build", "a", [
      { event: "started", from: "pending", to: "building" },
      { event: "operator_abandon", from: "building", to: "abandoned" },
    ]);
  } finally { agent.pause_before_publication_role = null; agent.releaseAll(); }
}, 180_000);

e2e("S18 cyclic briefs refuse the completing publish without opening a gate", async () => {
  const plan: readonly CohortPlanEntry[] = [
    { id: "a" as UnitId, depends_on: ["b" as UnitId] },
    { id: "b" as UnitId, depends_on: ["a" as UnitId] },
  ];
  const agent = scriptedAgentScenario({ cohorts: plan, pause_after_refusal_output: "brief" });
  const launched = await launchAgentRun(agent);
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => agent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:brief:")).length >= 2 ? true : null,
      timeout_ms: 90_000,
    });
    const refused = agent.deliveries.filter((delivery) => delivery.delivery_key.startsWith("publication:brief:"))[1]!;
    expect(refused.delivery_key).toContain(":409:");
    expect(refused.prompt).toContain("brief_dependency_cycle");
    expect(await cohortMachineState(sql, launched.run_id, "brief_writer", "0")).toBe("working");
    expect((await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer")).toHaveLength(0);
    await assertCohortTrace(launched.run_id, "brief_writer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "working" },
    ]);
  } finally {
    agent.pause_after_refusal_output = null;
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 150_000);

e2e("S21 operator edit on a gated artifact is refused through the route", async () => {
  const agent = scriptedAgentScenario();
  const launched = await launchAgentRun(agent);
  try {
    const parked = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "brief_writer") ?? null,
      timeout_ms: 90_000,
    });
    const artifactId = gateFirstArtifactId(parked.value);
    const before = await readRunRecordFingerprint(sql, launched.run_id);
    const response = await fetch(`${oakridge.base_url}/artifacts/${artifactId}/edits`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "/goal", prev_value: "x", new_value: "y", author: "operator" }),
    });
    expect(response.status).toBe(501);
    expect((await response.json() as { readonly code: string }).code).toBe("revision_unsupported");
    expect(await readRunRecordFingerprint(sql, launched.run_id)).toEqual(before);
    expect((await listRunGates(oakridge.base_url, launched.run_id)).some((gate) => gate.id === parked.value.id)).toBe(true);
    await assertCohortTrace(launched.run_id, "brief_writer", "0", [
      { event: "started", from: "pending", to: "working" },
      { event: "artifact_published", from: "working", to: "review" },
    ]);
  } finally {
    await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    agent.releaseAll();
  }
}, 150_000);
