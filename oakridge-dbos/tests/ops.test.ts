import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runOps } from "../src/ops";
import { PgPostgresExecutor } from "../src/storage/sql-executor";

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
    expect(fork).toHaveBeenCalledWith("effect-1", 3, expect.objectContaining({ applicationVersion: expect.any(String) }));
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
      if (statement.includes("SELECT digest FROM authority.schema_baseline")) {
        if (digest === null) throw Object.assign(new Error("relation missing"), { code: "42P01" });
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
