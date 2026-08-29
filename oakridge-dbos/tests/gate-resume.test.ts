import { expect, test } from "bun:test";

import type { ArtifactId, RunRecordVersion, WaitId, WorkflowRunId } from "../src/domain/primitives";
import { createGateResumeApp } from "../src/http/gate-resume";

const waitId = "99999999-9999-4999-8999-999999999999" as WaitId;
const runId = "88888888-8888-4888-8888-888888888888" as WorkflowRunId;
const request = (app: ReturnType<typeof createGateResumeApp>, body: unknown = { action: "approve", operator_comment: "ship it" }) =>
  app.request(`/gates/${waitId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the public gate route executes only the run-owned gate command", async () => {
  const actions: string[] = [];
  const app = createGateResumeApp({ records: { async decide_gate_wait(command) {
    actions.push(command.action);
    return { kind: "released", artifact_id: "77777777-7777-4777-8777-777777777777" as ArtifactId,
      run_id: runId, record_version: 8 as RunRecordVersion };
  } } });
  expect((await request(app)).status).toBe(202);
  expect(actions).toEqual(["approve"]);
});

test("gate command conflicts and missing waits remain typed HTTP outcomes", async () => {
  const conflict = createGateResumeApp({ records: { async decide_gate_wait() { return { kind: "wait_conflict" as const, detail: "already closed" }; } } });
  const missing = createGateResumeApp({ records: { async decide_gate_wait() { return { kind: "wait_not_found" as const, detail: "absent" }; } } });
  expect((await request(conflict)).status).toBe(409);
  expect((await request(missing)).status).toBe(404);
});

test("a gate id must be a run-owned wait id", async () => {
  const app = createGateResumeApp({ records: { async decide_gate_wait() { throw new Error("must not be called"); } } });
  expect((await app.request("/gates/legacy:unit/resume", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
});
