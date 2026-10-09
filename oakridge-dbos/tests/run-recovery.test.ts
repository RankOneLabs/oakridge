import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { serialChildrenRequestDeadlineMs } from "../src/runtime/advance-children";
import { DEFAULT_WORKFLOW_TIMING, ensureRunRecoveryFork, RunInfrastructureError, dispatchChild, ensureRunWorkflow, fenceOtherEngineWorkflows, forkStartStep, intentWorkflowId, registerWorkflowServices, resumeActiveRuns, runWorkflowId, wakeRun } from "../src/workflows/topology";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { sealEffectPayload } from "../src/storage/effect-secret";
import type { EffectPayload } from "../src/effects/intents";

test("a run boundary failure retains its run and operation in the diagnostic", () => {
  const error = new RunInfrastructureError("run-1", "advance", "database unavailable");
  expect(error.message).toContain("run run-1: advance: database unavailable");
});

test("run generation zero keeps the original address", () => {
  expect(runWorkflowId("run-1", 0)).toBe("run:run-1");
});

test("successor generations have distinct durable addresses", () => {
  expect(runWorkflowId("run-1", 1)).toBe("run:run-1:1");
});

test("a body failure replays its last durable step", () => {
  expect(forkStartStep([{ functionID: 4, error: null }])).toBe(4);
});

test("a failed step replays after its last successful predecessor", () => {
  expect(forkStartStep([{ functionID: 4, error: null }, { functionID: 5, error: new Error("lost db") }])).toBe(5);
});

test("serial child request time is bounded as scope count grows", () => {
  expect(serialChildrenRequestDeadlineMs(1, 60_000, 120_000)).toBe(60_000);
  expect(serialChildrenRequestDeadlineMs(100, 60_000, 120_000)).toBe(120_000);
});

test("a PENDING child is not dispatched again, while a missing child is started", async () => {
  const db = { query: async (sql: string) => {
    if (sql.includes("SELECT * FROM authority.effect_intent WHERE id=$1")) return [{ id: "intent-1", run_id: "run-1", scope_id: "scope-1",
      execution_id: null, effect_key: "key", status: "pending", dispatch_generation: 0, redispatch_failures: 0, deadline_epoch_ms: null,
      version: 0, payload: sealEffectPayload({ action: "start", handle: null,
        invocation: { id: "intent-1", execution_id: "execution-1", selection: {}, bytes: "pinned" } } as unknown as EffectPayload) }];
    if (sql.includes("SET deadline_epoch_ms=COALESCE")) return [{ deadline_epoch_ms: Date.now() + DEFAULT_WORKFLOW_TIMING.execution_deadline_ms }];
    return [];
  } } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db, timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const calls: unknown[][] = [];
  const start = spyOn(DBOS, "startWorkflow").mockImplementation(((_workflow: unknown, options: unknown) => {
    calls.push([options]);
    return async (...args: unknown[]) => { calls.push(args); return {} as never; };
  }) as never);
  try {
    await dispatchChild("run-1", "intent-1", "start");
    expect(calls).toEqual([]);
    status.mockImplementation(async () => null as never);
    await dispatchChild("run-1", "intent-1", "start");
    expect(calls).toEqual([[{ workflowID: intentWorkflowId("intent-1"), timeoutMS: expect.any(Number) }], ["intent-1"]]);
    const dispatched_timeout_ms = (calls[0]?.[0] as { timeoutMS: number }).timeoutMS;
    expect(Math.abs(dispatched_timeout_ms - DEFAULT_WORKFLOW_TIMING.execution_deadline_ms)).toBeLessThan(5_000);
  } finally { status.mockRestore(); start.mockRestore(); }
});

test("wake addresses the durable successor generation", async () => {
  const db = { query: async () => [{ current_generation: "2" }] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const send = spyOn(DBOS, "send").mockImplementation(async () => undefined as never);
  try {
    await wakeRun("run-1");
    expect(send).toHaveBeenCalledWith("run:run-1:2", null, "oakridge-run-wake");
  } finally { status.mockRestore(); send.mockRestore(); }
});

test("startup checks the current generation for an active run", async () => {
  const db = { query: async (sql: string) => sql.includes("SELECT r.id") ? [{ id: "run-1" }] : [{ current_generation: "3" }] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const list = spyOn(DBOS, "listWorkflows").mockImplementation(async () => [] as never);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
  try {
    expect(await resumeActiveRuns(db)).toBe(1);
    expect(status).toHaveBeenCalledWith("run:run-1:3");
    expect(fork).not.toHaveBeenCalled();
  } finally { list.mockRestore(); status.mockRestore(); fork.mockRestore(); }
});

test("a successor started after handover retains the pending scope cursor", async () => {
  const db = { query: async () => [{ current_generation: "4", current_cursor: "scope-256" }] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => null as never);
  const calls: unknown[][] = [];
  const start = spyOn(DBOS, "startWorkflow").mockImplementation(((_workflow: unknown, options: unknown) => {
    calls.push([options]);
    return async (...args: unknown[]) => { calls.push(args); return {} as never; };
  }) as never);
  try {
    await ensureRunWorkflow("run-1");
    expect(calls).toEqual([[{ workflowID: "run:run-1:4" }], ["run-1", "scope-256"]]);
  } finally { status.mockRestore(); start.mockRestore(); }
});

for (const scenario of ["fork committed before crash", "concurrent fork"] as const) {
  test(`ERROR recovery reconciles ${scenario}`, async () => {
    let successor_exists = scenario === "fork committed before crash";
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
      (successor_exists ? { status: "ENQUEUED", forkedFrom: "run:run-1" } : null) as never);
    const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => {
      successor_exists = true;
      throw new Error("duplicate key");
    });
    try {
      await ensureRunRecoveryFork({ workflow_id: "run:run-1", successor_id: "run:run-1:1",
        start_step: 0, application_version: "test" });
      expect(fork).toHaveBeenCalledTimes(scenario === "fork committed before crash" ? 0 : 1);
    } finally { status.mockRestore(); fork.mockRestore(); }
  });
}

test("ERROR recovery refuses a successor belonging to a different predecessor", async () => {
  const db = { query: async () => [{ current_generation: 0 }] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async (id) =>
    (id === "run:run-1" ? { status: "ERROR" } : { forkedFrom: "another-run" }) as never);
  const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [] as never);
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
  try {
    await expect(ensureRunWorkflow("run-1")).rejects.toThrow("is not a fork");
    expect(fork).not.toHaveBeenCalled();
  } finally { status.mockRestore(); steps.mockRestore(); fork.mockRestore(); }
});

test("reconciling a parked successor resumes its workflow", async () => {
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
    ({ status: "CANCELLED", forkedFrom: "run:run-1" }) as never);
  const resume = spyOn(DBOS, "resumeWorkflow").mockImplementation(async () => ({} as never));
  try {
    await ensureRunRecoveryFork({ workflow_id: "run:run-1", successor_id: "run:run-1:1",
      start_step: 0, application_version: "test" });
    expect(resume).toHaveBeenCalledWith("run:run-1:1");
  } finally { status.mockRestore(); resume.mockRestore(); }
});

for (const has_work of [false, true]) {
  test(`a SUCCESS run starts a successor only when work remains (${has_work})`, async () => {
    let claimed = false;
    const db = { query: async (sql: string) => {
      if (sql.includes("AS has_work")) return [{ has_work }];
      if (sql.includes("UPDATE authority.run")) { claimed = true; return [{ current_generation: 1 }]; }
      return [{ current_generation: 0, current_cursor: null }];
    } } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "SUCCESS" }) as never);
    const start = spyOn(DBOS, "startWorkflow").mockImplementation((() => async () => ({})) as never);
    try {
      await ensureRunWorkflow("run-1");
      expect(claimed).toBe(has_work);
      expect(start).toHaveBeenCalledTimes(has_work ? 1 : 0);
    } finally { status.mockRestore(); start.mockRestore(); }
  });
}

test("an intent workflow is addressed by intent and engine version", () => {
  expect(intentWorkflowId("intent-1", "engine-a")).toBe("intent-1@engine-a");
  expect(intentWorkflowId("intent-1", "engine-b")).not.toBe(intentWorkflowId("intent-1", "engine-a"));
});

for (const parked_status of ["CANCELLED", "ENQUEUED", "PENDING", "ERROR"] as const) {
  test(`a ${parked_status} run of another engine is carried on a new generation from the authority`, async () => {
    const db = { query: async (sql: string) => sql.includes("UPDATE authority.run")
      ? [{ current_generation: 3, current_cursor: "scope-9" }] : [{ current_generation: 2, current_cursor: "scope-9" }] } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
      ({ status: parked_status, applicationVersion: "previous-engine" }) as never);
    const cancel = spyOn(DBOS, "cancelWorkflow").mockImplementation(async () => undefined as never);
    const resume = spyOn(DBOS, "resumeWorkflow").mockImplementation(async () => ({} as never));
    const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
    const calls: unknown[][] = [];
    const start = spyOn(DBOS, "startWorkflow").mockImplementation(((_workflow: unknown, options: unknown) => {
      calls.push([options]);
      return async (...args: unknown[]) => { calls.push(args); return {} as never; };
    }) as never);
    try {
      await ensureRunWorkflow("run-1");
      expect({ calls, resumed: resume.mock.calls.length, forked: fork.mock.calls.length,
        cancelled: cancel.mock.calls.map((call) => call[0]) }).toEqual({
        calls: [[{ workflowID: "run:run-1:3" }], ["run-1", "scope-9"]], resumed: 0, forked: 0,
        cancelled: parked_status === "PENDING" || parked_status === "ENQUEUED" ? ["run:run-1:2"] : [] });
    } finally { status.mockRestore(); cancel.mockRestore(); resume.mockRestore(); fork.mockRestore(); start.mockRestore(); }
  });
}

test("a finished run of another engine is left as history", async () => {
  const db = { query: async (sql: string) => sql.includes("AS has_work") ? [{ has_work: false }] : [{ current_generation: 0, current_cursor: null }] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
    ({ status: "SUCCESS", applicationVersion: "previous-engine" }) as never);
  const start = spyOn(DBOS, "startWorkflow").mockImplementation((() => async () => ({})) as never);
  try {
    await ensureRunWorkflow("run-1");
    expect(start).not.toHaveBeenCalled();
  } finally { status.mockRestore(); start.mockRestore(); }
});

test("boot fences live workflows of another engine and leaves this engine's alone", async () => {
  const list = spyOn(DBOS, "listWorkflows").mockImplementation(async () => [
    { workflowID: "run:run-1", applicationVersion: "previous-engine" },
    { workflowID: "run:run-2", applicationVersion: DBOS.applicationVersion },
  ] as never);
  const cancel = spyOn(DBOS, "cancelWorkflows").mockImplementation(async () => undefined as never);
  try {
    expect(await fenceOtherEngineWorkflows()).toBe(1);
    expect(cancel).toHaveBeenCalledWith(["run:run-1"]);
  } finally { list.mockRestore(); cancel.mockRestore(); }
});

test("boot resumes only this engine's parked intent workflows", async () => {
  const db = { query: async () => [] } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
  const list = spyOn(DBOS, "listWorkflows").mockImplementation(async () => [] as never);
  try {
    await resumeActiveRuns(db);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELLED", applicationVersion: DBOS.applicationVersion }));
  } finally { list.mockRestore(); }
});
