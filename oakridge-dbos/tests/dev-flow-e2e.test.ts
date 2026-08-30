/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { OperatorParkedGate } from "../src/domain/operator-projections";
import type { WorkflowRunId } from "../src/domain/primitives";
import type { StageOutcome } from "../src/domain/workflow";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";
import { HARNESS_BASE_BRANCH, SEVEN_BRIEF_PLAN, awaitCondition, installIntegrationRuntime, runContext,
  scriptedAgentScenario, useScenario, type CohortPlanEntry, type IntegrationRuntime } from "./support/dev-flow-harness";
import { assertQuietAsk, decideGate, driveRun, emitDeclaredArtifacts, launchRun, listRunGates, readReviewInbox, readRun, readRunRecordFingerprint } from "./support/dev-flow-driver";

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
  const plan: readonly CohortPlanEntry[] = [{ id: "a", depends_on: [] }, { id: "b", depends_on: ["never"] }];
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
  const cyclePlan: readonly CohortPlanEntry[] = SEVEN_BRIEF_PLAN.map((entry) => entry.id === "schema" ? { id: "schema", depends_on: ["api"] } : entry);
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
 * `request_revision` on a v2 gate is a storage-level fact only (invalidate
 * the slot, abandon the work order) — nothing relaunches or delivers to the
 * brief_writer's agent, which this test confirms via `agent.launched` /
 * `agent.deliveries` rather than assuming it.
 *
 * This is the one scenario that does not reach its terminal assertions: the
 * re-emission path does not work through the driver, for a structural
 * reason worth recording rather than routing around. `brief_writer` is one
 * `artifact_collection` unit (`unit_id="0"`) whose single work order
 * published all seven briefs; invalidating *any one* collection member's
 * slot (`closeOutputWaitTransaction`'s invalidate branch) abandons that
 * *whole* work order (`slot.updated_by_work_order_id`), not just the
 * revised member — so re-emitting "rollout" through the same
 * already-launched request fails with `work_abandoned` (409). The
 * documented recovery for an abandoned work order, `PUT
 * /run-units/:runUnitId/retry` (`retry_unit`), is also refused here —
 * `actionable_wait`, 409 — because it requires *no* open wait anywhere on
 * the unit, and six of this unit's seven collection members (every brief but
 * `versioning`) are deliberately still open gates. There is no HTTP path
 * that revises one collection member of a still-open `artifact_collection`
 * stage without touching the rest; forcing one (hand-writing SQL, or
 * approving every other brief first, which would no longer be *this*
 * scenario) is not something this package does under its brief.
 */
e2e("scenario 7: a mid-graph revision rebuilds only the revised unit", async () => {
  const agent = scriptedAgentScenario({ cohorts: SEVEN_BRIEF_PLAN });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  const decide = (gate: OperatorParkedGate): string | null =>
    gate.stage_name === "brief_writer" ? (gate.unit_id === "versioning" ? "approve" : null) : "approve";
  try {
    await driveRun(oakridge.base_url, agent, launched, {
      decide,
      until: async () => (await buildUnitState(launched.run_id, "versioning")) === "satisfied" ? true : null,
      timeout_ms: 120_000,
    });
    expect(await workflowRunState(launched.run_id)).toBe("active");
    await assertQuietAsk(sql, launched.run_id);

    const rolloutGate = (await listRunGates(oakridge.base_url, launched.run_id))
      .find((gate) => gate.stage_name === "brief_writer" && gate.unit_id === "rollout");
    if (!rolloutGate?.artifact_revision_id) throw new Error("scenario 7 stopped here: rollout's brief gate was not open going into the revision");
    if (!rolloutGate.resume_actions.includes("request_revision")) {
      throw new Error(`scenario 7 stopped here: rollout's brief gate does not offer 'request_revision' (offers: ${rolloutGate.resume_actions.join(", ")})`);
    }

    const launchedBefore = agent.launched.size;
    const deliveriesBefore = agent.deliveries.length;
    await decideGate(oakridge.base_url, rolloutGate.artifact_revision_id, "request_revision");
    // Confirmed, not assumed: the v2 layer does not relaunch or deliver on a
    // gate revision — the agent side of a revision is the harness's own move.
    expect(agent.launched.size).toBe(launchedBefore);
    expect(agent.deliveries.length).toBe(deliveriesBefore);

    const briefWriterRequest = [...agent.launched.values()]
      .find((request) => (request.resolved_config as { readonly session_name?: string }).session_name?.startsWith("brief-writer-"));
    if (!briefWriterRequest) throw new Error("scenario 7 stopped here: no brief_writer execution request is on record to re-emit from");

    let reEmitFailure: string | null = null;
    try {
      await emitDeclaredArtifacts(oakridge.base_url, briefWriterRequest, { revision: 2, outputs: ["brief"], unit_ids: ["rollout"] });
    } catch (error) {
      reEmitFailure = error instanceof Error ? error.message : String(error);
    }
    if (!reEmitFailure) throw new Error("scenario 7 did not stop where expected: re-emitting rollout's brief through the original request unexpectedly succeeded");
    expect(reEmitFailure).toContain("work_abandoned");

    // The documented recovery for an abandoned work order is also refused,
    // for the reason in this test's own doc comment: the unit has other open
    // waits (the six brief gates never approved).
    const runUnitRows = await sql.query<{ readonly id: string }>(
      `SELECT unit.id::text FROM oakridge.run_unit unit JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
       WHERE stage.run_id = $1 AND stage.stage_key = 'brief_writer' AND unit.unit_id = '0'`, [launched.run_id]);
    const briefWriterRunUnitId = runUnitRows[0]?.id;
    if (!briefWriterRunUnitId) throw new Error("scenario 7 stopped here: brief_writer's run_unit row was not found");
    const retryAttempt = await fetch(`${oakridge.base_url}/run-units/${briefWriterRunUnitId}/retry`, {
      method: "PUT", headers: { "idempotency-key": "scenario-7-retry-1" },
    });
    expect(retryAttempt.status).toBe(409);
    const retryError = await retryAttempt.json() as { readonly kind?: string };
    expect(retryError.kind).toBe("actionable_wait");
  } finally {
    agent.releaseAll();
  }
}, 180_000);

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
