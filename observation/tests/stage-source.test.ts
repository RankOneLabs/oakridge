import { expect, test } from "bun:test";
import type { WorkflowUnit } from "../src/grading/task-stages";
import { createStageSource } from "../src/producers/oakridge/stage-source";
test("readiness reads the run's DBOS units and carries its control credential only to that boundary", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const units: readonly WorkflowUnit[] = [{ unit_id: "unit", stage: "custom", depends_on: [], status: { kind: "not_started" }, artifacts: [{ artifact_key: "report" }] }];
  const source = createStageSource({ base_url: "http://dbos/", token: "fixture-token", fetch: (async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(units);
  }) });
  expect(await source.read("run/1")).toEqual({ ok: true, value: units });
  expect(calls).toEqual([{ url: "http://dbos/api/runs/run%2F1/units", authorization: "Bearer fixture-token" }]);
});
test("unavailable readiness is an explicit error rather than a fabricated stage list", async () => {
  const source = createStageSource({ base_url: "http://dbos", fetch: (async () => Response.json({}, { status: 503 })) });
  expect(await source.read("run")).toEqual({ ok: false, error: { operation: "read_run_stages", entity_id: "run", detail: "DBOS readiness returned HTTP 503" } });
});
