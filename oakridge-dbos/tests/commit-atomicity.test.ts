import { expect, test } from "bun:test";
import { Hono } from "hono";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { commitEvent } from "../src/storage/commit";
import type { CoreClient } from "../src/core-client/client";
import type { Incoming, ScopedSnapshot, StepResult } from "../src/core-client/core-types";
import { readRunInspect } from "../src/projections/run-view";
import { installDefinitionApi } from "../src/http/app";
import { controlTokenMiddleware } from "../src/http/control-auth";

function fakeCore(): CoreClient {
  return { request: async (_operation: string, input: { snapshot: ScopedSnapshot; incoming: Incoming }) => {
    const before = input.snapshot;
    const snapshot: ScopedSnapshot = input.incoming.event.kind === "launched"
      ? { ...before, run: { ...before.run, input: input.incoming.event.input, status: { kind: "active" } },
        units: [{ id: before.run.root, parent: null, declaration: "$root", stage: null, pool: null,
          input: input.incoming.event.input, status: { kind: "active" }, after: [] }] }
      : { ...before, run: { ...before.run, status: { kind: "cancelled" } },
        units: before.units.map((unit) => ({ ...unit, status: { kind: "cancelled" } })) };
    const value: StepResult = { snapshot, statuses: snapshot.units.map((unit) => [unit.id, unit.status]), wanted: [] };
    return { ok: true, value: { kind: "stepped", value } };
  } } as unknown as CoreClient;
}

test("event, writer, snapshot delta and receipt roll back together", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `commit_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    const request = { run_id: "run", ingress_id: "launch", definition_bundle_id: "bundle",
      event: { kind: "launched" as const, input: {} }, writer: { kind: "operator" as const, subject: "credential-user" } };
    const rejecting = { request: async () => ({ ok: false, error: { kind: "domain", detail: "invalid input" } }) } as unknown as CoreClient;
    expect(await commitEvent(db, rejecting, request)).toMatchObject({ ok: true, value: { kind: "rejected" } });
    expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.run", []))[0]?.count).toBe(0);
    const faulting: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) =>
      db.transaction((tx) => operation({ query: (sql, params) => {
        if (sql.includes("INSERT INTO authority.ingress_receipt")) throw new Error("injected receipt fault");
        return tx.query(sql, params);
      } }), isolation) };
    expect((await commitEvent(faulting, fakeCore(), request)).ok).toBe(false);
    const rolled_back = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.run", []);
    expect(rolled_back[0]?.count).toBe(0);

    const committed = await commitEvent(db, fakeCore(), request);
    expect(committed).toMatchObject({ ok: true, value: { kind: "committed" } });
    const replayed = await commitEvent(db, fakeCore(), request);
    expect(replayed).toEqual({ ok: true, value: { kind: "replayed", event_id: committed.ok && "event_id" in committed.value ? committed.value.event_id : "" } });
    const other = await commitEvent(db, fakeCore(), { ...request, run_id: "run-2" });
    expect(other).toMatchObject({ ok: true, value: { kind: "committed" } });
    const cancelled = await commitEvent(db, fakeCore(), { run_id: "run-2", ingress_id: "cancel",
      event: { kind: "cancel_requested" }, writer: request.writer });
    expect(cancelled).toMatchObject({ ok: true, value: { kind: "committed" } });
    const rows = await db.query<{ writer: { kind: string; subject: string }; unit_count: number; receipt_count: number }>(
      "SELECT writer,(SELECT count(*)::int FROM authority.unit) AS unit_count,(SELECT count(*)::int FROM authority.ingress_receipt) AS receipt_count FROM authority.event WHERE run_id='run'", []);
    expect(rows).toEqual([{ writer: request.writer, unit_count: 2, receipt_count: 3 }]);
    await db.query(`INSERT INTO authority.unit (id,run_id,parent_id,unit_key,declaration,stage,input,status)
      VALUES ('run/analysis','run','run','analysis','analysis','analysis','{}','{"kind":"active"}')`, []);
    await db.query(`INSERT INTO authority.attempt (action_id,seq,run_id,unit_id,worker,mode,cause,status)
      VALUES ('failed-action',1,'run','run/analysis','writer','{"kind":"initial"}','{"kind":"missing"}',
        '{"kind":"failed","code":"worker_exit","detail":"session stopped"}')`, []);
    expect((await readRunInspect(db, "run"))?.attention).toEqual([
      { kind: "stalled_worker", unit_id: "run/analysis", worker: "writer", action_id: "failed-action", detail: "session stopped" },
    ]);
    const app = new Hono();
    app.use("*", controlTokenMiddleware("operator-secret"));
    installDefinitionApi(app, { db, core: fakeCore(), mutations: {} as Parameters<typeof installDefinitionApi>[1]["mutations"], wake: async () => undefined });
    const http_body = { request_id: "http-launch", digest: "digest", input: {}, writer: { kind: "engine" } };
    const send = () => app.request("http://localhost/api/runs", { method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify(http_body) });
    const launched = await send();
    expect(launched.status).toBe(201);
    const launched_body = await launched.json() as { run_id: string };
    expect((await send()).status).toBe(200);
    const cancel = await app.request(`http://localhost/api/runs/${launched_body.run_id}/cancel`, { method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
      body: JSON.stringify({ request_id: "http-cancel", writer: { kind: "engine" } }) });
    expect(cancel.status).toBe(201);
    const event_count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.event WHERE run_id=$1", [launched_body.run_id]);
    expect(event_count[0]?.count).toBe(2);
    const retry = await app.request("http://localhost/api/runs/run/units/run%2Fanalysis/workers/writer/retry", { method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
      body: JSON.stringify({ request_id: "http-retry", writer: { kind: "engine" } }) });
    expect(retry.status).toBe(201);
    expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.event WHERE ingress_id='http-retry'", []))[0]?.count).toBe(1);
    const http_events = await db.query<{ writer: { kind: string; subject: string } }>(
      "SELECT writer FROM authority.event WHERE ingress_id='http-launch'", []);
    expect(http_events).toEqual([{ writer: { kind: "operator", subject: expect.stringMatching(/^credential:/) } }]);

    await db.query("UPDATE authority.definition_bundle SET source=$1 WHERE id='bundle'", [JSON.stringify({
      stages: { analysis: { reviews: { check: { of: "report" } } } },
    })]);
    await db.query(`INSERT INTO authority.artifact_revision
      (id,run_id,unit_id,artifact,body,by_id,created_at) VALUES
      ('old','run','run/analysis','report','{}','writer','2026-01-01'),
      ('new','run','run/analysis','report','{}','writer','2026-01-02')`, []);
    const stale = await commitEvent(db, fakeCore(), { run_id: "run", ingress_id: "stale-decision",
      event: { kind: "operator_decided", unit: "run/analysis", review: "check", decision: "approve",
        target: "old", payload: {} }, writer: request.writer });
    expect(stale).toMatchObject({ ok: true, value: { kind: "conflict", detail: "review target revision changed" } });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM authority.event WHERE ingress_id='stale-decision'", []))[0]?.count).toBe(0);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
