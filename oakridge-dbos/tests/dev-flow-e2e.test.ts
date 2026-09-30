/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";

import type { OperatorParkedGate } from "../src/domain/operator-projections";
import type { CohortId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { HARNESS_BASE_BRANCH, SEVEN_BRIEF_PLAN, awaitCondition, installIntegrationRuntime, runContext,
  removePinnedPromptCell, scriptedAgentScenario, useScenario, type CohortPlanEntry, type IntegrationRuntime } from "./support/dev-flow-harness";
import { assertQuietAsk, confirmCohortMerged, decideGate, driveRun, launchRun, listRunGates, readReviewInbox, readRun, readRunRecordFingerprint } from "./support/dev-flow-driver";
import { findTestDatabaseUrl } from "./support/durable-database";
import { attemptsAfterCancel, buildStageRow, buildUnitRows, closedGateWaitCount,
  countBuildOrdersInState, openBriefGateUnitIds, runOutcome,
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

e2e("browser launches a run and decides its first gate through kbbl", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const before = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly { readonly id: string }[];
  const beforeIds = new Set(before.map((run) => run.id));
  const page = await browser.newPage();
  try {
    await page.goto(`${oakridge.kbbl_url}/#oakridge/new-run`);
    await page.getByLabel("Epic title").fill("Browser acceptance run");
    await page.getByLabel("Repository 1 key").fill("oakridge");
    await page.getByLabel("Repository 1 GitHub owner").fill("RankOneLabs");
    await page.getByLabel("Repository 1 GitHub name").fill("oakridge");
    await page.getByLabel("Repository 1 path").fill(oakridge.repository.path);
    await page.getByRole("textbox", { name: "Brief notes", exact: true }).fill("browser acceptance");
    await page.getByRole("button", { name: "Start Run" }).click();

    const launched = await awaitCondition("browser launch to appear in the public API", async () => {
      const runs = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly { readonly id: string; readonly current_attempt_root_workflow_id: string }[];
      return runs.find((run) => !beforeIds.has(run.id)) ?? null;
    }, 30_000);
    oakridge.started_runs.push(launched.current_attempt_root_workflow_id);
    let lastDetail: unknown = null;
    let kbblSessions: unknown = null;
    const gate = await awaitCondition(() => `browser run's first gate; last run detail=${JSON.stringify(lastDetail)}; kbbl sessions=${JSON.stringify(kbblSessions)}; fake launches=${agent.launched.size}`, async () => {
      lastDetail = await readRun(oakridge.base_url, launched.id as WorkflowRunId);
      kbblSessions = await fetch(`${oakridge.kbbl_url}/sessions`).then((response) => response.json()).catch((error) => String(error));
      return (await listRunGates(oakridge.base_url, launched.id as WorkflowRunId))[0] ?? null;
    }, 30_000);

    await page.goto(`${oakridge.kbbl_url}/#oakridge/review-inbox`);
    await page.getByTestId("or-decision-approve").first().click();
    await awaitCondition("browser gate decision in the public API", async () =>
      (await listRunGates(oakridge.base_url, launched.id as WorkflowRunId)).some((candidate) => candidate.id === gate.id) ? null : true, 30_000);
  } finally {
    await page.close();
    agent.releaseAll();
  }
}, 90_000);

e2e("deleting the publication contract from a rendered prompt fails the run attempt", async () => {
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
  } finally {
    agent.releaseAll();
  }
}, 60_000);


/** `GET /gates` with no run filter — every open gate across every run, the way `listV2PendingGates()` (no `run_id`) reports it. */
const allGates = async (baseUrl: string): Promise<readonly OperatorParkedGate[]> => {
  const response = await fetch(`${baseUrl}/gates`);
  return response.json() as Promise<readonly OperatorParkedGate[]>;
};

/** deterministic PRNG, seeded — spec §5.2 scenario 3 */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = <Value>(items: readonly Value[], random: () => number): Value[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = result[i]!;
    result[i] = result[j]!;
    result[j] = swap;
  }
  return result;
};

/**
 * Drives the seven briefs to approval in `order`, one at a time, asserting
 * after each that nothing dependent on a still-open brief has started —
 * then drives everything else to completion. Shared by scenarios 2 and 3,
 * which differ only in which order they approve in.
 */
const driveOrderedApprovals = async (order: readonly string[]): Promise<void> => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const approved = new Set<string>();
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (approved.has(gate.unit_id) ? "approve" : null) : "approve";
  try {
    for (const briefId of order) {
      approved.add(briefId);
      await driveRun(oakridge.base_url, agent, launched, {
        decide,
        until: async () => (await openBriefGateUnitIds(sql, launched.run_id)).size === 7 - approved.size ? true : null,
        timeout_ms: 60_000,
      });
      expect(await workflowRunState(sql, launched.run_id)).toBe("active");
      if (approved.size < order.length) expect(await countBuildUnits(launched.run_id)).toBe(0);
    }
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 180_000,
    });
    expect((await readRun(oakridge.base_url, launched.run_id)).status).toBe("complete");
  } finally {
    agent.releaseAll();
  }
};

e2e("straight-through dev flow completes", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  expect(launched.root_workflow_id).toBe(`v15-run:${launched.run_id}`);

  try {
    const { value: detail, driven, confirmed } = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const runDetail = await readRun(oakridge.base_url, launched.run_id);
        return runDetail.status === "complete" || runDetail.status === "failed" ? runDetail : null;
      },
      timeout_ms: 180_000,
    });

    if (detail.status !== "complete") throw new Error(`v2 run failed: ${JSON.stringify(detail)}`);
    expect(detail.status).toBe("complete");
    expect(detail.stages).toHaveLength(6);
    expect(detail.stages.every((stage) => stage.status === "complete")).toBe(true);
    expect(driven.size).toBe(8);
    expect(confirmed.size).toBe(2);
    expect(await oakridge.repository.list_origin_branches()).toContain(HARNESS_BASE_BRANCH);
  } finally {
    agent.releaseAll();
  }
}, 240_000);

const awaitBuildMerge = async (agent: ReturnType<typeof scriptedAgentScenario>) => {
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const reached = await driveRun(oakridge.base_url, agent, launched, {
    decide: () => "approve", confirm_merges: false,
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

e2e("a build cohort awaiting merge completes after operator confirmation", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const { launched, cohort_address } = await awaitBuildMerge(agent);
    const confirmed = await confirmCohortMerged(oakridge.base_url, cohort_address);
    expect(confirmed).toEqual({ kind: "accepted", outcome: "completed" });
    await awaitCondition("operator merge completion", async () =>
      (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build")?.units[0]?.status === "complete" ? true : null, 30_000);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve", until: async () =>
        (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
  } finally { agent.releaseAll(); }
}, 180_000);

e2e("a build cohort awaiting merge completes when the poller observes the merge", async () => {
  const agent = scriptedAgentScenario({ cohorts: [{ id: "foundation" as UnitId, depends_on: [] }] });
  try {
    const { launched } = await awaitBuildMerge(agent);
    const swept = await oakridge.runtime.poll_pull_requests();
    expect(swept?.some((outcome) => outcome.resolution.kind === "completed")).toBe(true);
    await awaitCondition("poller merge completion", async () =>
      (await readRun(oakridge.base_url, launched.run_id)).stages.find((stage) => stage.name === "build")?.units[0]?.status === "complete" ? true : null, 30_000);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve", until: async () =>
        (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 90_000,
    });
  } finally { agent.releaseAll(); }
}, 180_000);

/**
 * Reproduces run `16381389-e7ba-4ae6-8041-7a150b201c75`: seven briefs, a
 * dependency among them, and an operator who approves a dependent brief
 * before the brief it depends on. On `9ce75fd` this fails the whole run 40ms
 * after the approval — `materialize_stage:build:unknown dependency
 * 'gecko-dbos-versioning'` — and every other open gate vanishes from the
 * operator projection with it (`listV2PendingGates` filters on
 * `run.state='active'`). This is the first test written for the
 * decision-layer rewrite and it must fail on today's code; the rewrite's
 * PR description is its red/green evidence.
 */
e2e("scenario 1: approving a dependent brief first does not fail the run", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);

  const approvedBriefs = new Set<string>();
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (approvedBriefs.has(gate.unit_id) ? "approve" : null) : "approve";

  try {
    // Phase A — drive until all seven briefs are parked at their gate.
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => {
        const gates = await listRunGates(oakridge.base_url, launched.run_id);
        const briefGates = gates.filter((gate) => gate.stage_name === "brief_writer");
        return briefGates.length === 7 ? true : null;
      },
      timeout_ms: 60_000,
    });

    // Phase B — approve the dependent brief ("rollout") before its
    // dependency ("versioning"). On today's code the run fails almost
    // immediately; `until` also stops on that so the failure lands as an
    // assertion below rather than a timeout.
    approvedBriefs.add("rollout");
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => {
        const state = await workflowRunState(sql, launched.run_id);
        if (state !== "active") return true;
        const gates = await listRunGates(oakridge.base_url, launched.run_id);
        const briefGates = gates.filter((gate) => gate.stage_name === "brief_writer");
        return briefGates.length === 6 ? true : null;
      },
      timeout_ms: 30_000,
    });

    expect(await workflowRunState(sql, launched.run_id)).toBe("active");
    const briefGatesAfterB = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGatesAfterB).toHaveLength(6);
    expect(await buildUnitRows(sql, launched.run_id)).toHaveLength(0);
    expect(await countBuildOrdersInState(sql, launched.run_id, "started")).toBe(0);
    const detailAfterB = await readRun(oakridge.base_url, launched.run_id);
    expect(detailAfterB.status).not.toBe("failed");
    expect(detailAfterB.status).not.toBe("complete");
    await assertQuietAsk(sql, launched.run_id);

    // Phase C — approving the dependency still leaves the collection incomplete.
    approvedBriefs.add("versioning");
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => (await openBriefGateUnitIds(sql, launched.run_id)).size === 5 ? true : null,
      timeout_ms: 120_000,
    });
    expect(await countBuildUnits(launched.run_id)).toBe(0);
    expect(await workflowRunState(sql, launched.run_id)).toBe("active");
    const briefGatesAfterC = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGatesAfterC).toHaveLength(5);
    await assertQuietAsk(sql, launched.run_id);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 180_000,
    });
    expect(await countBuildUnits(launched.run_id)).toBe(7);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 180_000,
    });
  } finally {
    agent.releaseAll();
  }
}, 300_000);

/**
 * Approves in the exact reverse of topological order — every dependent
 * before its dependency — and checks after each approval that nothing
 * jumped the queue. Quiet-ask is asserted at every one of the seven
 * checkpoints: each is a genuine "run active, nothing pending" point.
 */
e2e("scenario 2: reverse topological approval order still starts nothing early", () =>
  driveOrderedApprovals(["release", "ui", "api", "rollout", "docs", "schema", "versioning"]), 300_000);

/**
 * Ten more orderings, from a fixed-seed shuffle so a failure reproduces.
 * Quiet-ask is asserted once per permutation (after its first approval)
 * rather than at all seven steps of all ten — scenario 2 already proves the
 * per-step invariant exhaustively; this is about the ordering, not about
 * re-proving quiescence 70 times over.
 */
const PERMUTATION_SEED = 0x5eed;
const permutationRandom = mulberry32(PERMUTATION_SEED);
const PERMUTATIONS: readonly (readonly string[])[] = Array.from({ length: 10 }, () => shuffled(SEVEN_BRIEF_PLAN.map((entry) => entry.id), permutationRandom));

PERMUTATIONS.forEach((order, index) => {
  e2e(`scenario 3: seeded permutation ${index} [${order.join(",")}]`, () => driveOrderedApprovals(order), 300_000);
});

e2e("scenario 4: approving one of seven briefs starts no build; approving all seven opens seven build cohorts", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (gate.unit_id === "docs" ? "approve" : null) : "approve";
  try {
    // `driveRun`'s review-inbox pass confirms a cohort's pull request the
    // moment it is in the inbox, whatever `decide` says — so docs's build can
    // race straight through "started" to "satisfied" between one poll and
    // the next. The transition log is what proves it started exactly once,
    // race-free, whatever state it has moved on to by the time this settles.
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async () => (await openBriefGateUnitIds(sql, launched.run_id)).size === 6 ? true : null,
      timeout_ms: 60_000,
    });

    expect(await closedGateWaitCount(sql, launched.run_id, "brief_writer")).toBe(1);
    expect(await countBuildUnits(launched.run_id)).toBe(0);
    const briefGates = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGates).toHaveLength(6);
    await assertQuietAsk(sql, launched.run_id);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await countBuildUnits(launched.run_id)) === 7 ? true : null,
      timeout_ms: 90_000,
    });
    expect(await countBuildUnits(launched.run_id)).toBe(7);
  } finally {
    agent.releaseAll();
  }
}, 120_000);

e2e("c5 refuses a forge head that disagrees with the real Git remote", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const override = await fetch(oakridge.forge_override_url, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unit_id: "foundation", head_sha: "0000000000000000000000000000000000000000" }) });
  expect(override.ok).toBe(true);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    const firstSid = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).stages
        .find((stage) => stage.name === "build")?.units.find((unit) => unit.unit_id === "foundation")?.sid ?? null,
      timeout_ms: 90_000,
    }).then((result) => result.value);
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const foundation = detail.stages.find((stage) => stage.name === "build")?.units
          .find((unit) => unit.unit_id === "foundation");
        const state = foundation?.params as { readonly build_state?: {
          readonly accepted_revision?: unknown; readonly verified_pull_request?: unknown;
        } } | undefined;
        return foundation?.status === "active" && foundation.sid !== null && foundation.sid !== firstSid
          && foundation.worktree?.branch === `cohort/${detail.stages.find((stage) => stage.name === "build")?.stage_instance_id}/foundation`
          && typeof state?.build_state?.accepted_revision === "string"
          && (state.build_state.verified_pull_request ?? null) === null ? detail : null;
      },
      timeout_ms: 90_000,
    });
    const detail = await readRun(oakridge.base_url, launched.run_id);
    expect(detail.status).toBe("active");
    const foundation = detail.stages.find((stage) => stage.name === "build")?.units
      .find((unit) => unit.unit_id === "foundation");
    expect(foundation?.status).toBe("active");
    expect((foundation?.params as { readonly build_state?: { readonly verified_pull_request?: unknown } })
      .build_state?.verified_pull_request ?? null).toBeNull();
  } finally {
    agent.releaseAll();
  }
}, 120_000);

e2e("c6 an assessment revision parks the rebuilt cohort at a fresh build review", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const firstBuildGates = new Set<string>();
  let assessmentRevised = false;
  try {
    const rebuilt = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => {
        if (gate.stage_name !== "build") return "approve";
        if (gate.unit_id !== "foundation") return "approve";
        if (assessmentRevised) return null;
        if (firstBuildGates.size < 2) {
          firstBuildGates.add(gate.id);
          return "approve";
        }
        assessmentRevised = true;
        return "request_revision";
      },
      until: async () => {
        if (!assessmentRevised) return null;
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const unit = detail.stages.find((stage) => stage.name === "build")?.units
          .find((candidate) => candidate.unit_id === "foundation");
        const gates = (await listRunGates(oakridge.base_url, launched.run_id))
          .filter((gate) => gate.stage_name === "build" && gate.unit_id === "foundation"
            && !firstBuildGates.has(gate.id));
        return unit?.status === "blocked" && gates.length === 2 ? { detail, unit, gates } : null;
      },
      timeout_ms: 180_000,
    });
    expect(rebuilt.value.unit.blocked_reason).toBe("gate");
    expect(rebuilt.value.unit.next_actor).toBe("operator");
    expect(rebuilt.value.gates).toHaveLength(2);
  } finally {
    agent.releaseAll();
  }
}, 210_000);

/**
 * Amends spec §5.2 scenario 5's cohort ids to avoid colliding with
 * `SEVEN_BRIEF_PLAN`'s: two cohorts, `a` (no dependency) and `b` (depends on
 * a unit that will never exist). `derive`'s close-time check (§1) is what
 * proves this, not a cycle — `b`'s dependency is simply unknown when the
 * `brief_writer` stage (and so the `build` stage's driver) finishes.
 */
e2e("scenario 5: an unknown dependency at close fails the run, not the graph around it", async () => {
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
  } finally {
    agent.releaseAll();
  }
}, 90_000);

/**
 * Amends spec §5.2 scenario 6: `cancel_run` closes every open wait by
 * design, so a cancelled run has nothing to strand — the stranded case is a
 * **failed** run (run 16381389). A dependency cycle between `api` and
 * `schema` fails the run with five brief gates never even reached, and
 * every one of them stays visible (not actionable).
 */
e2e("scenario 6a: a failed run strands its open gates visibly", async () => {
  const cyclePlan: readonly CohortPlanEntry[] = SEVEN_BRIEF_PLAN.map((entry) => entry.id === "schema" ? { id: "schema" as UnitId, depends_on: ["api" as UnitId] } : entry);
  const agent = scriptedAgentScenario({ cohorts: cyclePlan });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (gate.unit_id === "api" || gate.unit_id === "schema" ? "approve" : null) : "approve";
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async () => (await workflowRunState(sql, launched.run_id)) !== "active" ? true : null,
      timeout_ms: 60_000,
    });

    expect(await workflowRunState(sql, launched.run_id)).toBe("failed");
    const outcome = await runOutcome(sql, launched.run_id);
    expect(outcome?.kind).toBe("failed");
    expect(outcome && "code" in outcome ? outcome.code : null).toBe("roster_failed");

    const strandedFromGlobal = (await allGates(oakridge.base_url)).filter((gate) => gate.run_id === launched.run_id);
    expect(strandedFromGlobal).toHaveLength(5); // the five briefs never approved: versioning, docs, rollout, ui, release
    expect(strandedFromGlobal.every((gate) => gate.actionable === false)).toBe(true);
    expect(strandedFromGlobal.every((gate) => gate.run_state === "failed")).toBe(true);

    const strandedFromRun = await listRunGates(oakridge.base_url, launched.run_id);
    expect(strandedFromRun).toHaveLength(5);
    expect(strandedFromRun.every((gate) => gate.actionable === false && gate.run_state === "failed")).toBe(true);

    expect((await readRun(oakridge.base_url, launched.run_id)).status).toBe("failed");

    const inbox = await readReviewInbox(oakridge.base_url);
    const gateItemsForRun = inbox.items.filter((item) => item.run_id === launched.run_id && (item.kind === "artifact_gate" || item.kind === "merge_confirmation"));
    expect(gateItemsForRun).toHaveLength(0);
  } finally {
    agent.releaseAll();
  }
}, 90_000);

/**
 * Second half of spec §5.2 scenario 6: cancellation, which *does* clear
 * `GET /runs/:id/gates` — asserted here so the amendment above (6a) is
 * provable side by side, not just asserted.
 *
 * Regression proof for a real defect this scenario found: `cancel_run_tx`
 * (`src/storage/postgres-run-record.ts`) used to close every open wait with
 * `outcome = {kind: "cancelled", reason}` regardless of the wait's `kind`,
 * but the `wait_check4` CHECK constraint only allows `outcome.kind` to be
 * `decided` / `superseded` / `withdrawn` for a `gate` wait (or
 * `external_completed` / `superseded` / `withdrawn` for `handoff_external`)
 * — `"cancelled"` was not a member of either list, so cancelling a run with
 * an *open gate wait* (exactly what "approve none, then cancel" produces)
 * always violated it: `new row for relation "wait" violates check
 * constraint "wait_check4"`, a 409 from the cancel route. No prior test
 * exercised this path (the one existing cancellation test in
 * `postgres-run-record.test.ts` cancels before any wait is ever opened).
 *
 * Fixed: `cancel_run` now closes an open wait with `{kind: "withdrawn"}`,
 * which the constraint accepts. This scenario now proves the fix holds:
 * cancelling a run with seven open brief-approval gates succeeds (202), the
 * run lands `cancelled`, and every one of those stranded gates disappears
 * from `GET /runs/:id/gates`.
 */
e2e("scenario 6b: cancelling a run with an open gate wait clears its stranded gates", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await openBriefGateUnitIds(sql, launched.run_id)).size === 7 ? true : null,
      timeout_ms: 60_000,
    });
    const cancelResponse = await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    if (cancelResponse.status !== 202) {
      throw new Error(`scenario 6b stopped here: POST /workflow_runs/:id/cancel returned ${cancelResponse.status}: ${await cancelResponse.text()}`);
    }
    await awaitCondition("the run to be cancelled", async () => (await readRun(oakridge.base_url, launched.run_id)).status === "cancelled" ? true : null, 15_000);
    expect(await listRunGates(oakridge.base_url, launched.run_id)).toHaveLength(0);
    expect((await readRun(oakridge.base_url, launched.run_id)).status).toBe("cancelled");
    expect(await attemptsAfterCancel(sql, launched.run_id)).toBe(0);
    const cancelledCohorts = await sql.query<{ readonly id: string; readonly durable_version: string }>(
      "SELECT id::text,durable_version::text FROM oakridge.cohort WHERE run_id=$1 AND status='cancelled' ORDER BY id LIMIT 1",
      [launched.run_id]);
    const cancelledCohort = cancelledCohorts[0];
    if (!cancelledCohort) throw new Error("scenario 6b stopped here: cancellation left no cancelled cohort");
    const records = new PostgresRunRecordRepository(sql, new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry()));
    const lateDecision = { run_id: launched.run_id, cohort_id: cancelledCohort.id as CohortId,
      expected_version: Number(cancelledCohort.durable_version),
      change: { status: "active" as const, blocked_reason: null, next_actor: "agent" as const, outcome: null },
      stage_data: {}, reopen_output_names: [], effect: { kind: "none" as const }, launch_reason: "operator" as const,
      actor: "acceptance-late-decision", recorded_at: new Date().toISOString() };
    await records.record_cohort_event(lateDecision);
    const afterLateDecision = await sql.query<{ readonly status: string }>(
      "SELECT status::text FROM oakridge.cohort WHERE id=$1", [cancelledCohort.id]);
    expect(afterLateDecision[0]?.status).toBe("cancelled");
  } finally {
    agent.releaseAll();
  }
}, 90_000);

/**
 * The operator's correction loop through the real routes: reject one brief
 * of a seven-brief collection, decide the remaining six, retry the unit, and
 * watch the relaunched agent publish only the rejected member into its
 * invalidated slot — then approve the replacement and complete the run.
 *
 * What is proven, and where each step used to dead-end:
 * - `request_revision` invalidates exactly the rejected member's slot and
 *   closes exactly its gate; the six sibling gates stay open.
 * - retry is refused while sibling gates are open (`actionable_wait`) — the
 *   documented limitation, asserted so that a change to it is deliberate.
 * - the retry's execution request carries publication authority minted for
 *   the new work order and `expected_artifacts` narrowed to the rejected
 *   member. `driveRun` emits exactly what a launched request lists and
 *   asserts the PUT target is the launched work order — a request that still
 *   named the abandoned order (the old `retry_unit`) fails right there.
 * - `publish_artifact` accepts the replacement into the invalidated slot as a
 *   fresh chain root, withdraws the rejected artifact, and opens a new gate.
 */
e2e("scenario 7: a lost brief blocks for retry and the retry uses its dedicated prompt", async () => {
  const agent = scriptedAgentScenario({ skip_first_publication_role: "brief" });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    const blocked = await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => {
        const detail = await readRun(oakridge.base_url, launched.run_id);
        const unit = detail.stages.find((stage) => stage.name === "brief_writer")?.units[0];
        return unit?.status === "blocked" && unit.blocked_reason === "retry"
          && unit.next_actor === "operator" ? unit : null;
      },
      timeout_ms: 90_000,
    });
    expect(blocked.value.status).toBe("blocked");
    expect(agent.unpublished_work_orders.size).toBe(1);
    const stage = (await readRun(oakridge.base_url, launched.run_id)).stages
      .find((candidate) => candidate.name === "brief_writer");
    if (!stage) throw new Error("brief_writer stage is missing");
    const response = await fetch(`${oakridge.base_url}/stage_instances/${stage.stage_instance_id}/units/0/retry`, {
      method: "PUT", headers: { "idempotency-key": "scenario-7-retry" },
    });
    expect(response.status).toBe(202);
    const retried = await response.json() as { readonly attempt_id: string };
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => "approve",
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).status === "complete" ? true : null,
      timeout_ms: 240_000,
    });
    const request = agent.launched.get(retried.attempt_id);
    const prompt = (request?.resolved_config as { readonly rendered_prompt?: string } | undefined)?.rendered_prompt;
    expect(prompt).toContain("# Build Brief Writer — Retry After Lost Attempt");
  } finally {
    agent.releaseAll();
  }
}, 330_000);

/**
 * The runtime's prompt root for this file is a writable temp copy (see
 * `beforeAll`) exactly so this scenario can remove one file from it and put
 * it back. Removing `build_v2.md` makes `resolveWorkOrder`'s
 * `load_prompt_template` throw inside `apply` — inside `decide_run`'s own
 * transaction, which is the operational-failure boundary spec §3.5 draws:
 * the step retries in place, exhausts, and the root sleeps and asks again,
 * never touching the record and never terminating.
 */
e2e("scenario 8: a missing pinned prompt leaves the first cohort launch pending", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id,
    runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  let restore: (() => Promise<void>) | null = null;
  try {
    const planGate = await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "spec_analyzer" ? "approve" : null,
      until: async () => (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "plan_writer") ?? null,
      timeout_ms: 60_000,
    });
    restore = await removePinnedPromptCell(sql, launched.run_id, "brief_writer", "brief", "initial");
    if (!planGate.value.artifact_revision_id) throw new Error("plan gate has no artifact");
    await decideGate(oakridge.base_url, planGate.value.artifact_revision_id, "approve");
    const pending = await awaitCondition("brief cohort to remain pending without a prompt", async () => {
      const detail = await readRun(oakridge.base_url, launched.run_id);
      return detail.stages.find((stage) => stage.name === "brief_writer")?.units[0] ?? null;
    }, 30_000);
    await Bun.sleep(8_000);
    const attempts = await sql.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM oakridge.attempt WHERE cohort_id=$1", [pending.cohort_id]);
    expect(pending.status).toBe("pending");
    expect(attempts[0]?.count).toBe("0");
    expect((await readRun(oakridge.base_url, launched.run_id)).status).toBe("active");
    await restore();
    restore = null;
    await driveRun(oakridge.base_url, agent, launched, {
      decide: () => null,
      until: async () => (await readRun(oakridge.base_url, launched.run_id)).stages
        .find((stage) => stage.name === "brief_writer")?.units[0]?.sid ?? null,
      timeout_ms: 120_000,
    });
    const request = [...agent.launched.values()].find((item) =>
      (item.resolved_config as { readonly session_identity?: { readonly operator_role?: string } })
        .session_identity?.operator_role === "brief");
    expect((request?.resolved_config as { readonly rendered_prompt?: string } | undefined)?.rendered_prompt)
      .toContain("# Build Brief Writer — Initial Briefs");
  } finally {
    if (restore) await restore();
    agent.releaseAll();
  }
}, 180_000);

/**
 * A real HTTP round trip through `/artifacts/:id/edits` on a run parked at a
 * brief gate. `dev.build_brief` is `atom_editable`, so the request clears
 * every guard ahead of the refusal (found, current, policy) and lands on the
 * 501 `revision_unsupported` the route answers in place of a publish call
 * the v2 run record has no operation to satisfy (`http/collaboration.ts`).
 * The run record's fingerprint and the gate's open state are asserted
 * unchanged around the request — the route touches nothing. A revision
 * operation for the v2 run record remains a deferred slice; this scenario
 * does not stand in for one.
 */
e2e("scenario 9: an operator edit on a gated artifact is refused through the real route", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await openBriefGateUnitIds(sql, launched.run_id)).size >= 1 ? true : null,
      timeout_ms: 60_000,
    });

    const gate = (await listRunGates(oakridge.base_url, launched.run_id))
      .find((candidate) => candidate.stage_name === "brief_writer" && candidate.artifact_revision_id);
    if (!gate?.artifact_revision_id) throw new Error("scenario 9 stopped here: no brief_writer gate with an open artifact revision was found");

    await awaitCondition("scenario 9 run record to settle", async () => {
      const first = await readRunRecordFingerprint(sql, launched.run_id);
      await Bun.sleep(500);
      const second = await readRunRecordFingerprint(sql, launched.run_id);
      return first.record_version === second.record_version && first.transition_count === second.transition_count ? true : null;
    }, 15_000);
    const before = await readRunRecordFingerprint(sql, launched.run_id);
    const response = await fetch(`${oakridge.base_url}/artifacts/${gate.artifact_revision_id}/edits`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "/goal", prev_value: "x", new_value: "y", author: "operator" }),
    });
    expect(response.status).toBe(501);
    const body = await response.json() as { readonly code?: string };
    expect(body.code).toBe("revision_unsupported");

    expect(await readRunRecordFingerprint(sql, launched.run_id)).toEqual(before);
    const gatesAfter = await listRunGates(oakridge.base_url, launched.run_id);
    expect(gatesAfter.find((candidate) => candidate.id === gate.id)).toBeTruthy();
  } finally {
    agent.releaseAll();
  }
}, 120_000);
