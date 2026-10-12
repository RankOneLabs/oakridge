import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { commitEvent } from "../src/storage/commit";
import type { CoreClient } from "../src/core-client/client";
import type { ScopedSnapshot, StepResult } from "../src/core-client/core-types";

test("concurrent events serialize on the authority.run row", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `serial_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.unit (id,run_id,unit_key,declaration,input,status) VALUES ('run','run','$root','$root','{}','{\"kind\":\"active\"}')", []);
    await db.query("UPDATE authority.run SET root_unit_id='run',status='{\"kind\":\"active\"}' WHERE id='run'", []);
    let release_first: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release_first = resolve; });
    let signal_first: () => void = () => undefined;
    const first_in_core = new Promise<void>((resolve) => { signal_first = resolve; });
    let calls = 0;
    const core = { request: async (_operation: string, input: { snapshot: ScopedSnapshot }) => {
      calls++;
      if (calls === 1) { signal_first(); await held; }
      const snapshot: ScopedSnapshot = { ...input.snapshot, run: { ...input.snapshot.run, status: { kind: "cancelled" } },
        units: input.snapshot.units.map((unit) => ({ ...unit, status: { kind: "cancelled" } })) };
      const value: StepResult = { snapshot, statuses: [], wanted: [] };
      return { ok: true, value: { kind: "stepped", value } };
    } } as unknown as CoreClient;
    const request = (ingress_id: string) => ({ run_id: "run", ingress_id,
      event: { kind: "cancel_requested" as const }, writer: { kind: "operator" as const, subject: "operator" } });
    const first = commitEvent(db, core, request("cancel-one"));
    await first_in_core;
    const second = commitEvent(db, core, request("cancel-two"));
    await Bun.sleep(100);
    expect(calls).toBe(1);
    release_first();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.ok && result.value.kind)).toEqual(["committed", "committed"]);
    expect(calls).toBe(2);
    const events = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.event", []);
    expect(events[0]?.count).toBe(2);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
