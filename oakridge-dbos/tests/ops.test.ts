import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_WORKFLOW_TIMING } from "../src/workflows/topology";
import { runOps } from "../src/ops";
import { PgPostgresExecutor } from "../src/storage/sql-executor";

// Recovery forks onto the running engine version, which hashes the core binary.
const core_dir = mkdtempSync(resolve(tmpdir(), "oakridge-ops-core-"));
const previous_core_binary = process.env.OAKRIDGE_CORE_BINARY;
beforeAll(() => {
  const core_binary = resolve(core_dir, "workflow-cli");
  writeFileSync(core_binary, "core");
  process.env.OAKRIDGE_CORE_BINARY = core_binary;
});
afterAll(() => {
  if (previous_core_binary === undefined) delete process.env.OAKRIDGE_CORE_BINARY;
  else process.env.OAKRIDGE_CORE_BINARY = previous_core_binary;
  rmSync(core_dir, { recursive: true, force: true });
});

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
    expect(fork).toHaveBeenCalledWith("effect-1", 3, expect.objectContaining({ applicationVersion: expect.any(String), timeoutMS: DEFAULT_WORKFLOW_TIMING.execution_deadline_ms }));
    status.mockImplementation(async () => ({ workflowID: "effect-1", workflowName: "oakridgeEffectWorkflow",
      status: "ERROR", timeoutMS: 500 } as never));
    await runOps(["workflows", "recover", "effect-1"], "postgres://test");
    expect(fork).toHaveBeenLastCalledWith("effect-1", 3, expect.objectContaining({ timeoutMS: 500 }));
  } finally {
    config.mockRestore(); launch.mockRestore(); shutdown.mockRestore(); list.mockRestore(); status.mockRestore(); steps.mockRestore(); fork.mockRestore();
  }
});

test("ops migrate may be repeated against the same authority baseline", async () => {
  let digest: string | null = null;
  let applied = 0;
  interface FakeMigrationDb {
    query(statement: string, parameters: readonly unknown[]): Promise<readonly object[]>;
    transaction<Value>(work: (tx: FakeMigrationDb) => Promise<Value>): Promise<Value>;
    close(): Promise<void>;
  }
  const db: FakeMigrationDb = {
    async query(statement: string, parameters: readonly unknown[]) {
      if (statement.includes("server_version_num")) return [{ server_version_num: "150000" }];
      if (statement.includes("to_regclass")) return [{ name: digest === null ? null : "authority.schema_baseline" }];
      if (statement.includes("SELECT digest FROM authority.schema_baseline")) {
        return [{ digest }];
      }
      if (statement.includes("information_schema.tables")) return [];
      if (statement.includes("INSERT INTO authority.schema_baseline")) { digest = parameters[0] as string; applied++; }
      return [];
    },
    async transaction<Value>(work: (tx: FakeMigrationDb) => Promise<Value>): Promise<Value> { return work(db); },
    async close() {},
  };
  const connect = spyOn(PgPostgresExecutor, "connect").mockImplementation(() => db as never);
  try {
    expect(await runOps(["migrate"], "postgres://test")).toEqual({ migrated: true });
    expect(await runOps(["migrate"], "postgres://test")).toEqual({ migrated: true });
    expect(applied).toBe(1);
  } finally { connect.mockRestore(); }
});

test("ops retries a fork committed before an authority handover failure", async () => {
  let generation = 0;
  let successor_exists = false;
  let should_fail_claim = true;
  const db = {
    async query(sql: string) {
      if (sql.includes("UPDATE authority.run")) {
        if (should_fail_claim) { should_fail_claim = false; throw new Error("authority unavailable"); }
        generation++;
      }
      return [{ current_generation: generation, current_cursor: null }];
    },
    async close() {},
  };
  const config = spyOn(DBOS, "setConfig").mockImplementation(() => undefined);
  const launch = spyOn(DBOS, "launch").mockImplementation(async () => undefined);
  const shutdown = spyOn(DBOS, "shutdown").mockImplementation(async () => undefined);
  const connect = spyOn(PgPostgresExecutor, "connect").mockImplementation(() => db as never);
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async (id) =>
    (id === "run:run-1" ? { workflowName: "oakridgeRunWorkflow", status: "ERROR", input: ["run-1"] }
      : successor_exists ? { status: "ENQUEUED", forkedFrom: "run:run-1" } : null) as never);
  const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [] as never);
  const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => {
    if (successor_exists) throw new Error("duplicate key");
    successor_exists = true;
    return { workflowID: "run:run-1:1" } as never;
  });
  try {
    await expect(runOps(["workflows", "recover", "run:run-1"], "postgres://test")).rejects.toThrow("authority unavailable");
    expect(await runOps(["workflows", "recover", "run:run-1"], "postgres://test"))
      .toMatchObject({ workflowID: "run:run-1:1", action: "forked" });
    expect(generation).toBe(1);
    expect(fork).toHaveBeenCalledTimes(1);
  } finally {
    config.mockRestore(); launch.mockRestore(); shutdown.mockRestore(); connect.mockRestore();
    status.mockRestore(); steps.mockRestore(); fork.mockRestore();
  }
});

for (const generation of [null, 2]) {
  test(`ops refuses an ERROR run outside its authority generation (${generation})`, async () => {
    const config = spyOn(DBOS, "setConfig").mockImplementation(() => undefined);
    const launch = spyOn(DBOS, "launch").mockImplementation(async () => undefined);
    const shutdown = spyOn(DBOS, "shutdown").mockImplementation(async () => undefined);
    const connect = spyOn(PgPostgresExecutor, "connect").mockImplementation(() => ({
      query: async () => generation === null ? [] : [{ current_generation: generation }], close: async () => {},
    }) as never);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ workflowName: "oakridgeRunWorkflow", status: "ERROR", input: ["run-1"] }) as never);
    const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [] as never);
    const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({} as never));
    try {
      await expect(runOps(["workflows", "recover", "run:run-1"], "postgres://test")).rejects.toThrow("not the current authority generation");
      expect(fork).not.toHaveBeenCalled();
    } finally {
      config.mockRestore(); launch.mockRestore(); shutdown.mockRestore(); connect.mockRestore();
      status.mockRestore(); steps.mockRestore(); fork.mockRestore();
    }
  });
}
