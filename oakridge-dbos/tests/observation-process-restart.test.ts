import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../observation/src/http/app";
import { openDatabase as openObservationDatabase, withTenant } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { jsonText } from "../src/storage/database";
import { launch, openAuthority, pinSample, scratchDatabase, submitter } from "./authority-fixture";

test("an oakridge-dbos process restart resumes from the service-held cursor", async () => {
  const authority = await openAuthority();
  const scratch = await scratchDatabase();
  const observation = openObservationDatabase(scratch.url);
  const tenant = { producer: "oakridge", namespace: "process-restart" };
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    await migrateObservation(observation);
    const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] } });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
    const { bundle_id } = await pinSample(authority);
    const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "restart" } });
    await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
    const start = () => Bun.spawn([process.execPath, "oakridge-dbos/src/main.ts"], {
      cwd: resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "ignore",
      env: { ...process.env, BUN_INSPECT: undefined, DBOS_SYSTEM_DATABASE_URL: authority.url,
        OAKRIDGE_OBSERVATION_URL: `http://127.0.0.1:${server!.port}`, OAKRIDGE_OBSERVATION_INGEST_TOKEN: "ingest",
        OAKRIDGE_OBSERVATION_NAMESPACE: tenant.namespace, PORT: "0", KBBL_BASE_URL: undefined },
    });
    const committedIds = async (): Promise<string[]> => (await authority.db.selectFrom("authority.event").select("id")
      .where("run_id", "=", run_id).execute()).map((row) => row.id).sort();
    const deliveredIds = async (): Promise<string[]> => (await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select("event_id").execute())).map((row) => row.event_id).sort();
    const caughtUp = async (): Promise<boolean> => JSON.stringify(await committedIds()) === JSON.stringify(await deliveredIds());
    const until = async (child: ReturnType<typeof start>): Promise<void> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (await caughtUp()) {
          await Bun.sleep(250);
          if (await caughtUp()) return;
        }
        if (child.exitCode !== null) throw new Error(`oakridge-dbos exited early with ${child.exitCode}`);
        if (Date.now() >= deadline) throw new Error("timed out waiting for all committed events");
        await Bun.sleep(50);
      }
    };
    const stop = async (child: ReturnType<typeof start>): Promise<void> => {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(10_000).then(() => { child.kill("SIGKILL"); return child.exited; })]);
    };
    const first = start();
    try { await until(first); } finally { await stop(first); }
    const cursorBefore = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor")
      .select("event_id").executeTakeFirstOrThrow());
    for (let index = 0; index < 2; index++) await authority.db.insertInto("authority.event").values({ id: crypto.randomUUID(), run_id,
      unit_id: null, payload: jsonText({ kind: "cancel_requested" }), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
    const second = start();
    try { await until(second); } finally { await stop(second); }
    const committed = await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute();
    const delivered = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select("event_id").execute());
    const cursorAfter = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor")
      .select("event_id").executeTakeFirstOrThrow());
    expect({ committed: committed.map((row) => row.id).sort(), delivered: delivered.map((row) => row.event_id).sort(),
      advanced: cursorBefore.event_id !== cursorAfter.event_id })
      .toEqual({ committed: committed.map((row) => row.id).sort(), delivered: committed.map((row) => row.id).sort(), advanced: true });
  } finally { server?.stop(true); await observation.destroy(); await scratch.drop(); await authority.close(); }
}, 120_000);
