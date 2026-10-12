import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { currentRunGeneration, DEFAULT_WORKFLOW_TIMING, dispatchChild, ensureRunRecoveryFork, ensureRunWorkflow, fenceOtherEngineWorkflows, forkStartStep,
  cleanupWorkflowId, intentWorkflowId, registerWorkflowServices, RunInfrastructureError, runGenerationOf, runWorkflowId, wakeRun } from "../src/workflows/topology";

registerWorkflowServices({ timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
/** DBOS's own record of a run's workflows: the source of its current generation (D10). */
const runWorkflows = (...ids: string[]) => spyOn(DBOS, "listWorkflows").mockImplementation(async () => ids.map((workflowID) => ({ workflowID })) as never);
function recordStarts() {
  const calls: unknown[][] = [];
  const start = spyOn(DBOS, "startWorkflow").mockImplementation(((_workflow: unknown, options: unknown) => {
    calls.push([options]);
    return async (...args: unknown[]) => { calls.push(args); return {} as never; };
  }) as never);
  return { calls, restore: () => start.mockRestore() };
}

test("a run boundary failure retains its run and operation in the diagnostic", () => {
  expect(new RunInfrastructureError("run-1", "advance", "database unavailable").message).toContain("run run-1: advance: database unavailable");
});

test("generation zero keeps the original address and successors have distinct ones", () => {
  expect([runWorkflowId("run-1", 0), runWorkflowId("run-1", 2)]).toEqual(["run:run-1", "run:run-1:2"]);
});

test("a workflow id names its run's generation, and another run's id names none", () => {
  expect([runGenerationOf("run-1", "run:run-1"), runGenerationOf("run-1", "run:run-1:3"), runGenerationOf("run-1", "run:run-10"),
    runGenerationOf("run-1", "run:run-1:03")]).toEqual([0, 3, null, null]);
});

test("the current generation is the newest run workflow DBOS holds for the run", async () => {
  const list = runWorkflows("run:run-1", "run:run-1:2", "run:run-1:1", "run:run-10");
  try { expect([await currentRunGeneration("run-1"), await currentRunGeneration("run-2")]).toEqual([2, null]); }
  finally { list.mockRestore(); }
});

test("a failed step replays after its last successful predecessor; a body failure replays its last step", () => {
  expect([forkStartStep([{ functionID: 4, error: null }]),
    forkStartStep([{ functionID: 4, error: null }, { functionID: 5, error: new Error("lost db") }])]).toEqual([4, 5]);
});

test("an intent workflow is addressed by intent and engine version", () => {
  expect([intentWorkflowId("intent-1", "engine-a"), intentWorkflowId("intent-1", "engine-b")]).toEqual(["intent-1@engine-a", "intent-1@engine-b"]);
});

test("an intent's stop is carried under its own workflow id, apart from its start", async () => {
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => null as never);
  const starts = recordStarts();
  try {
    await dispatchChild("run-1", "intent-1", "stop");
    expect({ ids: starts.calls[0], distinct: cleanupWorkflowId("intent-1", "engine-a") !== intentWorkflowId("intent-1", "engine-a") })
      .toEqual({ ids: [{ workflowID: cleanupWorkflowId("intent-1") }], distinct: true });
  } finally { status.mockRestore(); starts.restore(); }
});

test("a PENDING carrier is not dispatched again, while a missing one is started", async () => {
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const starts = recordStarts();
  try {
    await dispatchChild("run-1", "intent-1", "start");
    const after_pending = [...starts.calls];
    status.mockImplementation(async () => null as never);
    await dispatchChild("run-1", "intent-1", "start");
    expect({ after_pending, after_missing: starts.calls }).toEqual({ after_pending: [],
      after_missing: [[{ workflowID: intentWorkflowId("intent-1") }], ["intent-1"]] });
  } finally { status.mockRestore(); starts.restore(); }
});

test("a run with no workflow yet starts generation zero", async () => {
  const list = runWorkflows();
  const starts = recordStarts();
  try {
    await ensureRunWorkflow("run-1");
    expect(starts.calls).toEqual([[{ workflowID: "run:run-1" }], ["run-1"]]);
  } finally { list.mockRestore(); starts.restore(); }
});

test("wake addresses the current generation", async () => {
  const list = runWorkflows("run:run-1", "run:run-1:2");
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const send = spyOn(DBOS, "send").mockImplementation(async () => undefined as never);
  try {
    await wakeRun("run-1");
    expect(send).toHaveBeenCalledWith("run:run-1:2", null, "oakridge-run-wake");
  } finally { list.mockRestore(); status.mockRestore(); send.mockRestore(); }
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
      await ensureRunRecoveryFork({ workflow_id: "run:run-1", successor_id: "run:run-1:1", start_step: 0, application_version: "test" });
      expect(fork).toHaveBeenCalledTimes(scenario === "fork committed before crash" ? 0 : 1);
    } finally { status.mockRestore(); fork.mockRestore(); }
  });
}

test("ERROR recovery refuses a successor belonging to a different predecessor", async () => {
  const list = runWorkflows("run:run-1");
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async (id) =>
    (id === "run:run-1" ? { status: "ERROR" } : { forkedFrom: "another-run" }) as never);
  const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [] as never);
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
  try {
    await expect(ensureRunWorkflow("run-1")).rejects.toThrow("is not a fork");
    expect(fork).not.toHaveBeenCalled();
  } finally { list.mockRestore(); status.mockRestore(); steps.mockRestore(); fork.mockRestore(); }
});

test("reconciling a parked successor resumes its workflow", async () => {
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "CANCELLED", forkedFrom: "run:run-1" }) as never);
  const resume = spyOn(DBOS, "resumeWorkflow").mockImplementation(async () => ({} as never));
  try {
    await ensureRunRecoveryFork({ workflow_id: "run:run-1", successor_id: "run:run-1:1", start_step: 0, application_version: "test" });
    expect(resume).toHaveBeenCalledWith("run:run-1:1");
  } finally { status.mockRestore(); resume.mockRestore(); }
});

for (const parked_status of ["CANCELLED", "ENQUEUED", "PENDING", "ERROR"] as const) {
  test(`a ${parked_status} run of another engine is carried on the next generation`, async () => {
    const list = runWorkflows("run:run-1", "run:run-1:2");
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: parked_status, applicationVersion: "previous-engine" }) as never);
    const cancel = spyOn(DBOS, "cancelWorkflow").mockImplementation(async () => undefined as never);
    const resume = spyOn(DBOS, "resumeWorkflow").mockImplementation(async () => ({} as never));
    const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
    const starts = recordStarts();
    try {
      await ensureRunWorkflow("run-1");
      expect({ calls: starts.calls, resumed: resume.mock.calls.length, forked: fork.mock.calls.length, cancelled: cancel.mock.calls.map((call) => call[0]) })
        .toEqual({ calls: [[{ workflowID: "run:run-1:3" }], ["run-1"]], resumed: 0, forked: 0,
          cancelled: parked_status === "PENDING" || parked_status === "ENQUEUED" ? ["run:run-1:2"] : [] });
    } finally { list.mockRestore(); status.mockRestore(); cancel.mockRestore(); resume.mockRestore(); fork.mockRestore(); starts.restore(); }
  });
}

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
