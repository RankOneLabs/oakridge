/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";

import type { OperatorParkedGate } from "../src/domain/operator-projections";
import type { WorkflowRunId } from "../src/domain/primitives";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";
import { HARNESS_BASE_BRANCH, SEVEN_BRIEF_PLAN, installIntegrationRuntime, runContext,
  scriptedAgentScenario, useScenario, type IntegrationRuntime } from "./support/dev-flow-harness";
import { assertQuietAsk, driveRun, launchRun, listRunGates, readRun } from "./support/dev-flow-driver";

const databaseUrl = await findTestDatabaseUrl();
if (!databaseUrl) console.warn("dev-flow e2e SKIPPED: no reachable PostgreSQL (set OAKRIDGE_TEST_DATABASE_URL)");
const e2e = databaseUrl ? test : test.skip;
let oakridge: IntegrationRuntime;
let sql: PgPostgresExecutor;

beforeAll(async () => {
  if (databaseUrl) {
    oakridge = await installIntegrationRuntime(databaseUrl);
    sql = PgPostgresExecutor.connect(databaseUrl);
  }
}, 120_000);

afterAll(async () => {
  if (databaseUrl) {
    await oakridge.stop();
    await sql.close();
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

const workflowRunState = async (runId: WorkflowRunId): Promise<string> => {
  const rows = await sql.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [runId]);
  if (!rows[0]) throw new Error(`workflow run '${runId}' was not found`);
  return rows[0].state;
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
