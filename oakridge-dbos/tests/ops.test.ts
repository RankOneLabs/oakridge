import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runOps } from "../src/ops";

// Recovery forks onto the running engine version, which hashes the WASM module.

test("ops script exposes the workflow operator entry point", () => {
  const package_json = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(package_json.scripts.ops).toBe("bun run src/ops.ts");
});

test("ops lists, inspects and forks an errored workflow", async () => {
  const config = spyOn(DBOS, "setConfig").mockImplementation(() => undefined);
  const launch = spyOn(DBOS, "launch").mockImplementation(async () => undefined);
  const shutdown = spyOn(DBOS, "shutdown").mockImplementation(async () => undefined);
  const list = spyOn(DBOS, "listWorkflows").mockImplementation(async () => [{ workflowID: "effect-1", status: "PENDING" }] as never);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
    ({ workflowID: "effect-1", workflowName: "oakridgeEffectWorkflow", status: "ERROR" }) as never);
  const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () =>
    [{ functionID: 2, error: null }, { functionID: 3, error: new Error("lost db") }] as never);
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({ workflowID: "effect-fork" }) as never);
  try {
    expect(await runOps(["workflows", "list"], "postgres://test")).toEqual([{ workflowID: "effect-1", status: "PENDING" }]);
    expect(await runOps(["workflows", "inspect", "effect-1"], "postgres://test")).toMatchObject({ status: { status: "ERROR" } });
    expect(await runOps(["workflows", "recover", "effect-1"], "postgres://test")).toMatchObject({ workflowID: "effect-fork", startStep: 3 });
    expect(fork).toHaveBeenCalledWith("effect-1", 3, { applicationVersion: expect.any(String) });
    status.mockImplementation(async () => ({ workflowID: "effect-1", workflowName: "oakridgeEffectWorkflow",
      status: "ERROR", timeoutMS: 500 } as never));
    await runOps(["workflows", "recover", "effect-1"], "postgres://test");
    expect(fork).toHaveBeenLastCalledWith("effect-1", 3, expect.objectContaining({ timeoutMS: 500 }));
  } finally {
    config.mockRestore(); launch.mockRestore(); shutdown.mockRestore(); list.mockRestore(); status.mockRestore(); steps.mockRestore(); fork.mockRestore();
  }
});

/** Mocks DBOS for one ops call; a run's generations are the run workflows DBOS lists. */
function mockDbos(input: { readonly run_workflows: readonly string[]; readonly status: (id: string) => unknown }) {
  const spies = [
    spyOn(DBOS, "setConfig").mockImplementation(() => undefined),
    spyOn(DBOS, "launch").mockImplementation(async () => undefined),
    spyOn(DBOS, "shutdown").mockImplementation(async () => undefined),
    spyOn(DBOS, "listWorkflows").mockImplementation(async () => input.run_workflows.map((workflowID) => ({ workflowID })) as never),
    spyOn(DBOS, "getWorkflowStatus").mockImplementation(async (id) => input.status(id) as never),
    spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [] as never),
  ];
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({ workflowID: "run:run-1:1" }) as never);
  return { fork, restore: () => { for (const spy of [...spies, fork]) spy.mockRestore(); } };
}

test("ops forks an ERROR run workflow into its next generation", async () => {
  const dbos = mockDbos({ run_workflows: ["run:run-1"], status: (id) => id === "run:run-1"
    ? { workflowName: "oakridgeRunWorkflow", status: "ERROR", input: ["run-1"] } : null });
  try {
    expect(await runOps(["workflows", "recover", "run:run-1"], "postgres://test")).toMatchObject({ workflowID: "run:run-1:1", action: "forked" });
    expect(dbos.fork).toHaveBeenCalledWith("run:run-1", 0, expect.objectContaining({ newWorkflowID: "run:run-1:1" }));
  } finally { dbos.restore(); }
});

test("ops refuses an ERROR run workflow that is not the run's current generation", async () => {
  const dbos = mockDbos({ run_workflows: ["run:run-1", "run:run-1:1"], status: () => ({ workflowName: "oakridgeRunWorkflow", status: "ERROR", input: ["run-1"] }) });
  try {
    await expect(runOps(["workflows", "recover", "run:run-1"], "postgres://test")).rejects.toThrow("not the run's current generation");
    expect(dbos.fork).not.toHaveBeenCalled();
  } finally { dbos.restore(); }
});
