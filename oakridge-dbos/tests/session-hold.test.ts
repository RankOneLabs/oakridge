import { expect, test } from "bun:test";
import { Hono } from "hono";

import { createDomainReadApp } from "../src/http/domain-reads";
import type { SessionHold } from "../src/domain/session-hold";
import type { SessionHoldRepository } from "../src/storage/repositories";
import { PostgresSessionHoldRepository } from "../src/storage/postgres-domain";
import type { SqlExecutor } from "../src/storage/sql-executor";

const hold: SessionHold = {
  session_id: "session-1", execution_id: "stage-1:0" as SessionHold["execution_id"],
  execution_workflow_id: "root:stage:plan_writer:unit:0", run_id: "run-1" as SessionHold["run_id"],
  stage_instance_id: "stage-1" as SessionHold["stage_instance_id"], stage_key: "plan_writer",
  unit_id: "0" as SessionHold["unit_id"],
};

const appWith = (session_holds: SessionHoldRepository) => new Hono().route("/", createDomainReadApp({
  stages: {} as never, artifacts: {} as never, session_holds,
}));

test("a session a live execution still needs is reported as held", async () => {
  const response = await appWith({ async find_session_hold() { return hold; } }).request("/session_holds/session-1");
  expect(await response.json()).toEqual({ held: true, hold });
});

test("a session nothing depends on is reported free", async () => {
  const response = await appWith({ async find_session_hold() { return null; } }).request("/session_holds/session-1");
  expect(await response.json()).toEqual({ held: false, hold: null });
});

/**
 * Session ids are kbbl's, not uuid-shaped domain ids, so the route must pass
 * them through as given rather than rejecting them the way run ids are.
 */
test("a session id is passed through without uuid validation", async () => {
  let asked = "";
  const response = await appWith({ async find_session_hold(id) { asked = id; return null; } }).request("/session_holds/not-a-uuid");
  expect(response.status).toBe(200);
  expect(asked).toBe("not-a-uuid");
});

/**
 * A workflow that has returned — success, failure or cancellation — has stopped
 * waiting on its session, so closing it can no longer strand anything. Only a
 * PENDING execution holds.
 */
test("the query holds only while the execution workflow is still running", async () => {
  let sql = "";
  const executor: SqlExecutor = { query: async <Row>(statement: string) => { sql = statement; return [] as Row[]; } };
  await new PostgresSessionHoldRepository(executor, "v2").find_session_hold("session-1");
  expect(sql).toContain("external_reference->>'session_id' = $1");
  expect(sql).toContain("execution.status = 'PENDING'");
});

const holderRow = (application_version: string | null) => ({
  execution_id: hold.execution_id, execution_workflow_id: hold.execution_workflow_id,
  run_id: hold.run_id, stage_instance_id: hold.stage_instance_id, stage_key: hold.stage_key,
  unit_id: hold.unit_id, application_version,
});

const repositoryReturning = (application_version: string | null, executor_version: string) => {
  const executor: SqlExecutor = {
    query: async <Row>() => [holderRow(application_version)] as unknown as Row[],
  };
  return new PostgresSessionHoldRepository(executor, executor_version);
};

test("a pending workflow this executor serves still holds its session", async () => {
  expect(await repositoryReturning("v2", "v2").find_session_hold("session-1")).toEqual(hold);
});

/**
 * The bug this guards: DBOS recovers only workflows matching the executor's
 * application version, so one left PENDING by an earlier version never resumes
 * and never terminalizes. Read as a live hold it made the session permanently
 * unclosable — a claim no run would ever release.
 */
test("a pending workflow stranded at another version holds nothing", async () => {
  expect(await repositoryReturning("v1", "v2").find_session_hold("session-1")).toBeNull();
});

/**
 * Rows written before workflows carried a version are not evidence of
 * abandonment, so they keep the guard rather than losing it.
 */
test("a holder with no recorded version is still honoured", async () => {
  expect(await repositoryReturning(null, "v2").find_session_hold("session-1")).toEqual(hold);
});
