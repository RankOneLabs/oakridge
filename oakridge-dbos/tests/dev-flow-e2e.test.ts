/** Public v2 proof: real runtime, repositories, routes, workflows, gates and handoffs; only the agent is scripted. */
import { afterAll, beforeAll, expect, test } from "bun:test";

import type { ArtifactId, UnitId } from "../src/domain/primitives";
import { findTestDatabaseUrl } from "./support/durable-database";
import { HARNESS_BASE_BRANCH, awaitCondition, cohortPullRequestUrl, installIntegrationRuntime, runContext,
  scriptedAgentScenario, useScenario, type IntegrationRuntime } from "./support/dev-flow-harness";
import { confirmCohortMerged, decideGate, emitDeclaredArtifacts, launchRun, readReviewInbox, readRun } from "./support/dev-flow-driver";

const databaseUrl = await findTestDatabaseUrl();
if (!databaseUrl) console.warn("dev-flow e2e SKIPPED: no reachable PostgreSQL (set OAKRIDGE_TEST_DATABASE_URL)");
const e2e = databaseUrl ? test : test.skip;
let oakridge: IntegrationRuntime;

beforeAll(async () => {
  if (databaseUrl) oakridge = await installIntegrationRuntime(databaseUrl);
}, 120_000);

afterAll(async () => {
  if (databaseUrl) await oakridge.stop();
}, 60_000);

e2e("the public dev flow runs solely on run-owned v2 workflows", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  expect(launched.root_workflow_id).toBe(`v2-run:${launched.run_id}`);

  const driven = new Set<string>();
  const gates: ArtifactId[] = [];
  const confirmed = new Set<string>();
  try {
    await awaitCondition("the public v2 dev flow to complete", async () => {
      for (const [workflowId, request] of agent.launched) {
        if (driven.has(workflowId)) continue;
        driven.add(workflowId);
        const publication = (request.resolved_config as { readonly publication?: { readonly work_order_id: string } }).publication;
        expect(publication?.work_order_id).toBe(workflowId);
        for (const artifact of await emitDeclaredArtifacts(oakridge.base_url, request)) {
          if (artifact.release === "waiting_gate") gates.push(artifact.artifact_id);
        }
        agent.succeed(request.execution_id);
      }
      while (gates.length > 0) await decideGate(oakridge.base_url, gates.shift()!, "approve");

      const inbox = await readReviewInbox(oakridge.base_url);
      for (const item of inbox.items) {
        if (item.kind !== "pull_request_merge" || item.run_id !== launched.run_id) continue;
        const cohortId = `${item.stage_instance_id}:${item.unit_id}`;
        expect(item.pr_url).toBe(cohortPullRequestUrl(item.unit_id as UnitId));
        const result = await confirmCohortMerged(oakridge.base_url, cohortId);
        if (result.kind === "accepted" && result.outcome === "completed") confirmed.add(cohortId);
      }
      const detail = await readRun(oakridge.base_url, launched.run_id);
      return detail.status === "complete" || detail.status === "failed" ? detail : null;
    }, 180_000);

    const detail = await readRun(oakridge.base_url, launched.run_id);
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
