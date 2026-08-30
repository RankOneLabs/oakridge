/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { OperatorParkedGate } from "../src/domain/operator-projections";
import type { UnitId, WorkflowRunId } from "../src/domain/primitives";
import type { StageOutcome } from "../src/domain/workflow";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";
import { HARNESS_BASE_BRANCH, SEVEN_BRIEF_PLAN, awaitCondition, installIntegrationRuntime, runContext,
  scriptedAgentScenario, useScenario, type CohortPlanEntry, type IntegrationRuntime } from "./support/dev-flow-harness";
import { assertQuietAsk, decideGate, driveRun, launchRun, listRunGates, readReviewInbox, readRun, readRunRecordFingerprint } from "./support/dev-flow-driver";

const databaseUrl = await findTestDatabaseUrl();
if (!databaseUrl) console.warn("dev-flow e2e SKIPPED: no reachable PostgreSQL (set OAKRIDGE_TEST_DATABASE_URL)");
const e2e = databaseUrl ? test : test.skip;
let oakridge: IntegrationRuntime;
let sql: PgPostgresExecutor;
/**
 * A writable copy of `oakridge-core/prompts`, built once for the whole file.
 * Scenario 8 is the only one that ever mutates it (and always restores what
 * it removed); every other scenario reads it exactly as it would the real
 * tree, since it is a plain recursive copy.
 */
let promptTemplateDir: string | null = null;

beforeAll(async () => {
  if (databaseUrl) {
    promptTemplateDir = await mkdtemp(join(tmpdir(), "oakridge-e2e-prompts-"));
    await cp(resolve(import.meta.dir, "../../oakridge-core/prompts"), promptTemplateDir, { recursive: true });
    oakridge = await installIntegrationRuntime(databaseUrl, { prompt_template_directory: promptTemplateDir });
    sql = PgPostgresExecutor.connect(databaseUrl);
  }
}, 120_000);

afterAll(async () => {
  if (databaseUrl) {
    await oakridge.stop();
    await sql.close();
    if (promptTemplateDir) await rm(promptTemplateDir, { recursive: true, force: true });
  }
}, 60_000);

/** Every unit under one run's `build` stage: its unit id and current state. */
const buildUnitRows = async (runId: WorkflowRunId): Promise<readonly { readonly unit_id: string; readonly state: string }[]> =>
  sql.query<{ readonly unit_id: string; readonly state: string }>(
    `SELECT unit.unit_id, unit.state FROM oakridge.run_unit unit
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = 'build' ORDER BY unit.unit_id`, [runId]);

const countBuildUnits = async (runId: WorkflowRunId): Promise<number> => (await buildUnitRows(runId)).length;

const buildUnitState = async (runId: WorkflowRunId, unitId: string): Promise<string | null> =>
  (await buildUnitRows(runId)).find((row) => row.unit_id === unitId)?.state ?? null;

const countBuildOrdersInState = async (runId: WorkflowRunId, state: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM oakridge.work_order work
     JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = 'build' AND work.state = $2`, [runId, state]);
  return Number(rows[0]?.count ?? 0);
};

/** The record version at which one unit's transition of `operation` was committed — the run's own, race-free clock. */
const transitionVersion = async (runId: WorkflowRunId, operation: string, stageKey: string, unitId: string): Promise<number> => {
  const rows = await sql.query<{ readonly version: string }>(
    `SELECT transition.resulting_record_version::text AS version FROM oakridge.run_transition transition
     JOIN oakridge.run_unit unit ON unit.id = transition.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE transition.run_id = $1 AND transition.operation = $2 AND stage.stage_key = $3 AND unit.unit_id = $4
     ORDER BY transition.resulting_record_version LIMIT 1`, [runId, operation, stageKey, unitId]);
  if (!rows[0]) throw new Error(`no '${operation}' transition for ${stageKey}/${unitId} on run ${runId}`);
  return Number(rows[0].version);
};

/**
 * How many times a unit has had a transition of `operation` — a monotonic,
 * race-free fact unlike polling current state. `driveRun`'s review-inbox
 * pass confirms a cohort's pull request the moment it is in the inbox,
 * regardless of `decide`, so a build that has *started* can race straight
 * through to *satisfied* between one poll and the next; asking "did this
 * transition ever happen" is what a scenario that only cares about the
 * start, not the current instant, should ask instead.
 */
const transitionCountFor = async (runId: WorkflowRunId, operation: string, stageKey: string, unitId: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM oakridge.run_transition transition
     JOIN oakridge.run_unit unit ON unit.id = transition.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE transition.run_id = $1 AND transition.operation = $2 AND stage.stage_key = $3 AND unit.unit_id = $4`, [runId, operation, stageKey, unitId]);
  return Number(rows[0]?.count ?? 0);
};

const workflowRunState = async (runId: WorkflowRunId): Promise<string> => {
  const rows = await sql.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [runId]);
  if (!rows[0]) throw new Error(`workflow run '${runId}' was not found`);
  return rows[0].state;
};

/** The `unit_id`s (collection keys, for a brief_writer gate) with an open gate wait against the `brief_writer` stage. */
const openBriefGateUnitIds = async (runId: WorkflowRunId): Promise<ReadonlySet<string>> => {
  const rows = await sql.query<{ readonly unit_id: string }>(
    `SELECT DISTINCT COALESCE(wait.collection_key, wait.unit_id) AS unit_id FROM oakridge.wait wait
     JOIN oakridge.run_unit unit ON unit.id = wait.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = 'brief_writer' AND wait.kind = 'gate' AND wait.status = 'open'`, [runId]);
  return new Set(rows.map((row) => row.unit_id));
};

/** Every build unit id with at least one `started` work order right now. */
const startedBuildUnitIds = async (runId: WorkflowRunId): Promise<readonly string[]> => {
  const rows = await sql.query<{ readonly unit_id: string }>(
    `SELECT DISTINCT unit.unit_id FROM oakridge.work_order work
     JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = 'build' AND work.state = 'started'`, [runId]);
  return rows.map((row) => row.unit_id);
};

/** A build unit's dependency ids, from `run_unit_dependency` — the persisted graph, not the plan value. */
const buildDependencies = async (runId: WorkflowRunId, unitId: string): Promise<readonly string[]> => {
  const rows = await sql.query<{ readonly depends_on_unit_id: string }>(
    `SELECT edge.depends_on_unit_id FROM oakridge.run_unit_dependency edge
     JOIN oakridge.stage_instance stage ON stage.id = edge.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = 'build' AND edge.unit_id = $2`, [runId, unitId]);
  return rows.map((row) => row.depends_on_unit_id);
};

/** Scenarios 2 and 3's per-step invariant: no build work order has started for a unit whose dependency's brief gate is still open. */
const assertNoStartedBuildDependsOnOpenBrief = async (runId: WorkflowRunId): Promise<void> => {
  const openBriefs = await openBriefGateUnitIds(runId);
  for (const unitId of await startedBuildUnitIds(runId)) {
    for (const dependency of await buildDependencies(runId, unitId)) expect(openBriefs.has(dependency)).toBe(false);
  }
};

const runOutcome = async (runId: WorkflowRunId): Promise<StageOutcome | null> => {
  const rows = await sql.query<{ readonly outcome: StageOutcome | null }>("SELECT outcome FROM oakridge.workflow_run WHERE id = $1", [runId]);
  return rows[0]?.outcome ?? null;
};

/** `run_transition` rows recording a materialization contradiction (`record_contradiction_tx`'s only pending transition). */
const materializationFailedTransitions = async (runId: WorkflowRunId): Promise<readonly { readonly detail: unknown }[]> =>
  sql.query<{ readonly detail: unknown }>("SELECT detail FROM oakridge.run_transition WHERE run_id = $1 AND operation = 'materialization_failed'", [runId]);

/** How many wait rows closed for one stage — e.g. "exactly one closed brief gate" after one approval. */
const closedGateWaitCount = async (runId: WorkflowRunId, stageKey: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM oakridge.wait wait
     JOIN oakridge.run_unit unit ON unit.id = wait.run_unit_id
     JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
     WHERE stage.run_id = $1 AND stage.stage_key = $2 AND wait.kind = 'gate' AND wait.status = 'closed'`, [runId, stageKey]);
  return Number(rows[0]?.count ?? 0);
};

/** The `build` stage's own row, or null when it has never been materialized (spec §3.6: a stage with no work has no row). */
const buildStageRow = async (runId: WorkflowRunId): Promise<{ readonly state: string } | null> => {
  const rows = await sql.query<{ readonly state: string }>(
    "SELECT state FROM oakridge.stage_instance WHERE run_id = $1 AND stage_key = 'build' AND attempt_root_workflow_id IS NULL", [runId]);
  return rows[0] ?? null;
};

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
const driveOrderedApprovals = async (order: readonly string[], shouldAssertQuiet: (step: number) => boolean): Promise<void> => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const approved = new Set<string>();
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (approved.has(gate.unit_id) ? "approve" : null) : "approve";
  try {
    for (const [step, briefId] of order.entries()) {
      approved.add(briefId);
      await driveRun(oakridge.base_url, agent, launched, {
        decide,
        until: async () => (await openBriefGateUnitIds(launched.run_id)).size === 7 - approved.size ? true : null,
        timeout_ms: 60_000,
      });
      expect(await workflowRunState(launched.run_id)).toBe("active");
      await assertNoStartedBuildDependsOnOpenBrief(launched.run_id);
      if (shouldAssertQuiet(step)) await assertQuietAsk(sql, launched.run_id);
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
  expect(launched.root_workflow_id).toBe(`v2-run:${launched.run_id}`);

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
    expect(driven.size).toBe(7);
    expect(confirmed.size).toBe(2);
    expect(await oakridge.repository.list_origin_branches()).toContain(HARNESS_BASE_BRANCH);
  } finally {
    agent.releaseAll();
  }
}, 240_000);

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
        const state = await workflowRunState(launched.run_id);
        if (state !== "active") return true;
        const gates = await listRunGates(oakridge.base_url, launched.run_id);
        const briefGates = gates.filter((gate) => gate.stage_name === "brief_writer");
        const buildUnitCount = await countBuildUnits(launched.run_id);
        return briefGates.length === 6 && buildUnitCount === 1 ? true : null;
      },
      timeout_ms: 30_000,
    });

    expect(await workflowRunState(launched.run_id)).toBe("active");
    const briefGatesAfterB = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGatesAfterB).toHaveLength(6);
    const buildUnitsAfterB = await buildUnitRows(launched.run_id);
    expect(buildUnitsAfterB).toHaveLength(1);
    expect(buildUnitsAfterB[0]?.unit_id).toBe("rollout");
    expect(await countBuildOrdersInState(launched.run_id, "started")).toBe(0);
    const detailAfterB = await readRun(oakridge.base_url, launched.run_id);
    expect(detailAfterB.status).not.toBe("failed");
    expect(detailAfterB.status).not.toBe("complete");
    await assertQuietAsk(sql, launched.run_id);

    // Phase C — approve the dependency; the dependent brief's build starts
    // only once it is satisfied. `driveRun` drives every launched execution
    // to completion (rollout's build included, then its assessment and merge),
    // so the quiescent point to wait for is rollout *satisfied* — and the
    // ordering claim is read from the transition log, which cannot race.
    approvedBriefs.add("versioning");
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => (await buildUnitState(launched.run_id, "rollout")) === "satisfied" ? true : null,
      timeout_ms: 120_000,
    });

    expect(await buildUnitState(launched.run_id, "versioning")).toBe("satisfied");
    expect(await buildUnitState(launched.run_id, "rollout")).toBe("satisfied");
    const versioningSatisfiedAt = await transitionVersion(launched.run_id, "unit_satisfied", "build", "versioning");
    const rolloutStartedAt = await transitionVersion(launched.run_id, "work_started", "build", "rollout");
    expect(rolloutStartedAt).toBeGreaterThan(versioningSatisfiedAt);
    expect(await workflowRunState(launched.run_id)).toBe("active");
    const briefGatesAfterC = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGatesAfterC).toHaveLength(5);
    await assertQuietAsk(sql, launched.run_id);
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
  driveOrderedApprovals(["release", "ui", "api", "rollout", "docs", "schema", "versioning"], () => true), 300_000);

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
  e2e(`scenario 3: seeded permutation ${index} [${order.join(",")}]`, () => driveOrderedApprovals(order, (step) => step === 0), 300_000);
});

e2e("scenario 4: approving one brief starts exactly one build and closes exactly one gate", async () => {
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
      until: async () => (await transitionCountFor(launched.run_id, "work_started", "build", "docs")) > 0 ? true : null,
      timeout_ms: 60_000,
    });

    expect(await closedGateWaitCount(launched.run_id, "brief_writer")).toBe(1);
    expect(await transitionCountFor(launched.run_id, "work_started", "build", "docs")).toBe(1);
    const briefGates = (await listRunGates(oakridge.base_url, launched.run_id)).filter((gate) => gate.stage_name === "brief_writer");
    expect(briefGates).toHaveLength(6);
    await assertQuietAsk(sql, launched.run_id);
  } finally {
    agent.releaseAll();
  }
}, 120_000);

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
      until: async () => (await workflowRunState(launched.run_id)) !== "active" ? true : null,
      timeout_ms: 60_000,
    });

    expect(await workflowRunState(launched.run_id)).toBe("failed");
    const outcome = await runOutcome(launched.run_id);
    expect(outcome?.kind).toBe("failed");
    expect(outcome && "code" in outcome ? outcome.code : null).toBe("contradiction");

    const transitions = await materializationFailedTransitions(launched.run_id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.detail).toEqual({
      stage_key: "build",
      contradiction: { kind: "unknown_dependency_at_close", stage_key: "build", unit_id: "b", dependency: "never" },
    });

    // Nothing else was rewritten: "a" still has whatever state its own
    // build reached — never failed or cancelled by "b"'s contradiction.
    const aState = await buildUnitState(launched.run_id, "a");
    expect(aState).not.toBeNull();
    expect(aState).not.toBe("failed");
    expect(aState).not.toBe("cancelled");
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
      until: async () => (await workflowRunState(launched.run_id)) !== "active" ? true : null,
      timeout_ms: 60_000,
    });

    expect(await workflowRunState(launched.run_id)).toBe("failed");
    const outcome = await runOutcome(launched.run_id);
    expect(outcome?.kind).toBe("failed");
    expect(outcome && "code" in outcome ? outcome.code : null).toBe("contradiction");
    const transitions = await materializationFailedTransitions(launched.run_id);
    expect(transitions).toHaveLength(1);
    expect((transitions[0]?.detail as { readonly contradiction?: { readonly kind?: string } } | undefined)?.contradiction?.kind).toBe("dependency_cycle");

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
      until: async () => (await openBriefGateUnitIds(launched.run_id)).size === 7 ? true : null,
      timeout_ms: 60_000,
    });
    const cancelResponse = await fetch(`${oakridge.base_url}/workflow_runs/${launched.run_id}/cancel`, { method: "POST" });
    if (cancelResponse.status !== 202) {
      throw new Error(`scenario 6b stopped here: POST /workflow_runs/:id/cancel returned ${cancelResponse.status}: ${await cancelResponse.text()}`);
    }
    await awaitCondition("the run to be cancelled", async () => (await readRun(oakridge.base_url, launched.run_id)).status === "cancelled" ? true : null, 15_000);
    expect(await listRunGates(oakridge.base_url, launched.run_id)).toHaveLength(0);
    expect((await readRun(oakridge.base_url, launched.run_id)).status).toBe("cancelled");
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
e2e("scenario 7: rejecting one brief, retrying its unit, and approving the replacement completes the run", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const siblings = ["release", "ui", "api", "docs", "schema", "versioning"];
  const approvedBriefs = new Set<string>();
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (approvedBriefs.has(gate.unit_id) ? "approve" : null) : "approve";
  const briefWriterUnit = async (): Promise<{ readonly run_unit_id: string; readonly stage_instance_id: string }> => {
    const rows = await sql.query<{ readonly run_unit_id: string; readonly stage_instance_id: string }>(
      `SELECT unit.id::text AS run_unit_id, stage.id::text AS stage_instance_id FROM oakridge.run_unit unit
       JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
       WHERE stage.run_id = $1 AND stage.stage_key = 'brief_writer' AND unit.unit_id = '0'`, [launched.run_id]);
    if (!rows[0]) throw new Error("scenario 7 stopped here: brief_writer's run_unit row was not found");
    return rows[0];
  };
  const rolloutSlot = async (runUnitId: string): Promise<{ readonly state: string; readonly artifact_revision_id: string | null } | undefined> =>
    (await sql.query<{ readonly state: string; readonly artifact_revision_id: string | null }>(
      "SELECT state, artifact_revision_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = 'brief' AND collection_key = 'rollout'", [runUnitId]))[0];
  // The route kbbl's run detail calls: stage instance + unit id, no run-unit row id needed.
  const retry = (stageInstanceId: string, key: string): Promise<Response> =>
    fetch(`${oakridge.base_url}/stage_instances/${stageInstanceId}/units/0/retry`, { method: "PUT", headers: { "idempotency-key": key } });
  try {
    // Phase A — all seven briefs parked at their gates.
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => (await openBriefGateUnitIds(launched.run_id)).size === 7 ? true : null,
      timeout_ms: 60_000,
    });
    const unit = await briefWriterUnit();

    // Phase B — reject rollout's brief. Only its slot is invalidated, and the
    // rejection relaunches nothing: the replacement is the operator's retry.
    const rolloutGate = (await listRunGates(oakridge.base_url, launched.run_id)).find((gate) => gate.stage_name === "brief_writer" && gate.unit_id === "rollout");
    if (!rolloutGate?.artifact_revision_id) throw new Error("scenario 7 stopped here: rollout's brief gate was not open going into the revision");
    expect(rolloutGate.resume_actions).toContain("request_revision");
    const rejectedArtifactId = rolloutGate.artifact_revision_id;
    const launchedBeforeReject = agent.launched.size;
    await decideGate(oakridge.base_url, rejectedArtifactId, "request_revision");
    expect(await openBriefGateUnitIds(launched.run_id)).toEqual(new Set(siblings));
    expect(agent.launched.size).toBe(launchedBeforeReject);
    expect(await rolloutSlot(unit.run_unit_id)).toEqual({ state: "invalidated", artifact_revision_id: rejectedArtifactId });

    // Retry is refused while sibling gates are open — the documented limitation.
    const refused = await retry(unit.stage_instance_id, "scenario-7-retry-early");
    expect(refused.status).toBe(409);
    expect((await refused.json() as { readonly kind?: string }).kind).toBe("actionable_wait");

    // Phase C — decide the other six.
    for (const sibling of siblings) approvedBriefs.add(sibling);
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => (await openBriefGateUnitIds(launched.run_id)).size === 0 ? true : null,
      timeout_ms: 60_000,
    });
    expect(await workflowRunState(launched.run_id)).toBe("active");

    // Phase D — retry. Created once; the same key replays the same work order.
    const accepted = await retry(unit.stage_instance_id, "scenario-7-retry-1");
    expect(accepted.status).toBe(202);
    const retried = await accepted.json() as { readonly work_order: { readonly id: string } };
    const replayed = await retry(unit.stage_instance_id, "scenario-7-retry-1");
    expect(replayed.status).toBe(200);
    expect((await replayed.json() as { readonly work_order: { readonly id: string } }).work_order.id).toBe(retried.work_order.id);

    // Phase E — the relaunched agent publishes rollout's brief and nothing
    // else; the replacement is approved and the run completes.
    approvedBriefs.add("rollout");
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async (): Promise<boolean | null> => (await workflowRunState(launched.run_id)) === "succeeded" ? true : null,
      timeout_ms: 240_000,
    });
    expect(await workflowRunState(launched.run_id)).toBe("succeeded");

    const retryRequest = agent.launched.get(retried.work_order.id);
    if (!retryRequest) throw new Error("scenario 7 stopped here: the retry work order was never launched");
    expect(retryRequest.expected_artifacts).toEqual([{ unit_id: "rollout" as UnitId, output_name: "brief", artifact_type: expect.any(String) }]);
    expect((retryRequest.resolved_config as { readonly publication?: { readonly work_order_id?: string } }).publication?.work_order_id).toBe(retried.work_order.id);
    const retryArtifacts = await sql.query<{ readonly id: string; readonly collection_key: string | null; readonly version: number; readonly parent_artifact_id: string | null }>(
      "SELECT id::text, collection_key, version, parent_artifact_id::text FROM oakridge.artifact WHERE work_order_id = $1", [retried.work_order.id]);
    expect(retryArtifacts).toHaveLength(1);
    expect(retryArtifacts[0]).toEqual(expect.objectContaining({ collection_key: "rollout", version: 1, parent_artifact_id: null }));
    expect((await sql.query<{ readonly lifecycle_state: string }>("SELECT lifecycle_state FROM oakridge.artifact WHERE id = $1", [rejectedArtifactId]))[0]?.lifecycle_state).toBe("withdrawn");
    expect(await rolloutSlot(unit.run_unit_id)).toEqual({ state: "released", artifact_revision_id: retryArtifacts[0]!.id });
  } finally {
    agent.releaseAll();
  }
}, 420_000);

/**
 * The runtime's prompt root for this file is a writable temp copy (see
 * `beforeAll`) exactly so this scenario can remove one file from it and put
 * it back. Removing `build_v2.md` makes `resolveWorkOrder`'s
 * `load_prompt_template` throw inside `apply` — inside `decide_run`'s own
 * transaction, which is the operational-failure boundary spec §3.5 draws:
 * the step retries in place, exhausts, and the root sleeps and asks again,
 * never touching the record and never terminating.
 */
e2e("scenario 8: a missing prompt template stalls the ask, not the run", async () => {
  if (!promptTemplateDir) throw new Error("no writable prompt-template directory was set up for this file");
  const buildPromptPath = join(promptTemplateDir, "dev-flow", "build_v2.md");
  const buildPromptBackup = await readFile(buildPromptPath, "utf8");

  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    // Park all seven brief gates open, same as scenario 1's phase A — the
    // pre-brief_writer pipeline (spec_analyzer, plan_writer) is approved so
    // brief_writer is reached at all; no brief itself is approved yet.
    await driveRun(oakridge.base_url, agent, launched, {
      decide: (gate) => gate.stage_name === "brief_writer" ? null : "approve",
      until: async () => (await openBriefGateUnitIds(launched.run_id)).size === 7 ? true : null,
      timeout_ms: 60_000,
    });

    await rm(buildPromptPath);
    let restored = false;
    try {
      const versioningGate = (await listRunGates(oakridge.base_url, launched.run_id))
        .find((gate) => gate.stage_name === "brief_writer" && gate.unit_id === "versioning");
      if (!versioningGate?.artifact_revision_id) throw new Error("scenario 8 stopped here: versioning's brief gate was not open");
      await decideGate(oakridge.base_url, versioningGate.artifact_revision_id, "approve");

      const afterApproval = await readRunRecordFingerprint(sql, launched.run_id);
      await Bun.sleep(8_000);
      const afterWait = await readRunRecordFingerprint(sql, launched.run_id);
      expect(afterWait).toEqual(afterApproval);
      expect(await workflowRunState(launched.run_id)).toBe("active");
      const stage = await buildStageRow(launched.run_id);
      if (stage) expect(await countBuildUnits(launched.run_id)).toBe(0); // "no rows or no units"
      else expect(stage).toBeNull();

      await writeFile(buildPromptPath, buildPromptBackup);
      restored = true;

      // No wake, no operator action from here: `driveRun`'s own polling and
      // its "emit for launched executions" pass are read-only against the
      // root's recv/wake mechanism; recovery is the root's own backoff-retry
      // loop discovering the file is back. The transition log, not current
      // state, is the race-free way to catch "started": `driveRun`'s
      // review-inbox pass confirms a cohort's pull request unconditionally,
      // so versioning's build can race straight through "started" to
      // "satisfied" between one poll and the next.
      await driveRun(oakridge.base_url, agent, launched, {
        decide: () => null,
        until: async () => (await transitionCountFor(launched.run_id, "work_started", "build", "versioning")) > 0 ? true : null,
        timeout_ms: 120_000,
      });
      expect(await transitionCountFor(launched.run_id, "work_started", "build", "versioning")).toBe(1);
      expect(await workflowRunState(launched.run_id)).toBe("active");
    } finally {
      if (!restored) await writeFile(buildPromptPath, buildPromptBackup).catch(() => undefined);
    }
  } finally {
    agent.releaseAll();
  }
}, 150_000);

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
      until: async () => (await openBriefGateUnitIds(launched.run_id)).size >= 1 ? true : null,
      timeout_ms: 60_000,
    });

    const gate = (await listRunGates(oakridge.base_url, launched.run_id))
      .find((candidate) => candidate.stage_name === "brief_writer" && candidate.artifact_revision_id);
    if (!gate?.artifact_revision_id) throw new Error("scenario 9 stopped here: no brief_writer gate with an open artifact revision was found");

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
