import { commitTestDefinition, sampleDefinition } from "./committed-fixture";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../observation/src/http/app";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { openDatabase as openObservationDatabase, withTenant } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { commitAnalysisLinkDeclaration } from "../src/storage/commit";
import { jsonText } from "../src/storage/database";
import { actionOf, ANALYSIS_LINK_WORKFLOW, executor, launch, openAuthority, OPERATOR, scratchDatabase, submitter, unitOf } from "./authority-fixture";

test("an oakridge-dbos process restart resumes from the service-held cursor", async () => {
  const authority = await openAuthority();
  const scratch = await scratchDatabase();
  const observation = openObservationDatabase(scratch.url);
  const tenant = { producer: "oakridge", namespace: "process-restart" };
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    await migrateObservation(observation);
    const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] }, profile: oakridgeProfile });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
    const { definition_id } = await sampleDefinition();
    const { run_id } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "restart" } });
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

for (const interruption of ["before it is applied", "after it is applied, before its acknowledgement"] as const)
  test(`a publisher process killed with a journaled declaration ${interruption} delivers it once when restarted`, async () => {
    const authority = await openAuthority();
    const scratch = await scratchDatabase();
    const observation = openObservationDatabase(scratch.url);
    const tenant = { producer: "oakridge", namespace: "declaration-restart" };
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      await migrateObservation(observation);
      const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] }, profile: oakridgeProfile });
      /** The one declaration delivery this test interrupts, once. */
      let interrupted = false;
      let saw_interruption!: () => void;
      const interruption_seen = new Promise<void>((resolve) => { saw_interruption = resolve; });
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
        if (request.method !== "POST" || interrupted) return app.fetch(request);
        const body = await request.text();
        const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body });
        if ((JSON.parse(body) as { readonly outcome: { readonly kind: string } }).outcome.kind !== "relation_declaration") return app.fetch(forwarded);
        interrupted = true;
        if (interruption === "after it is applied, before its acknowledgement") await app.fetch(forwarded);
        saw_interruption();
        return new Response("interrupted", { status: 503 });
      } });
      const { definition_id } = await commitTestDefinition({ source: ANALYSIS_LINK_WORKFLOW });
      const { run_id } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "restart" } });
      const unit = unitOf(run_id, "document");
      const action = await actionOf(authority, run_id, "writer");
      const submit = submitter(authority);
      await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
      await submit({ run_id, event: { kind: "revision_published", unit, artifact: "analysis", body: { findings: [{ id: "F1" }] }, by: action }, writer: executor(action) });
      await submit({ run_id, event: { kind: "revision_published", unit, artifact: "tasks", body: { tasks: ["one"] }, by: action }, writer: executor(action) });
      await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
      await submit({ run_id, event: { kind: "operator_decided", unit, review: "tasks_review", decision: "approve", target: `${unit}:tasks:1`, payload: {} } });
      const declared = await commitAnalysisLinkDeclaration(authority.db, { ingress_id: crypto.randomUUID(), writer: OPERATOR,
        declaration: { run_id, tasks_revision_id: `${unit}:tasks:1`, entries: [{ source_revision_id: `${unit}:analysis:1`, item_path: "/findings/0", task_ids: ["T1"] }] } });
      expect(declared.ok && declared.value.kind).toBe("committed");
      const start = () => Bun.spawn([process.execPath, "oakridge-dbos/src/main.ts"], { cwd: resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "ignore",
        env: { ...process.env, BUN_INSPECT: undefined, DBOS_SYSTEM_DATABASE_URL: authority.url, OAKRIDGE_OBSERVATION_URL: `http://127.0.0.1:${server!.port}`,
          OAKRIDGE_OBSERVATION_INGEST_TOKEN: "ingest", OAKRIDGE_OBSERVATION_NAMESPACE: tenant.namespace, PORT: "0", KBBL_BASE_URL: undefined } });
      const first = start();
      await Promise.race([interruption_seen, Bun.sleep(60_000).then(() => { throw new Error("the declaration was never delivered"); })]);
      first.kill("SIGKILL");
      await first.exited;
      const relations = () => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.item_relation").select(["relation_id", "unresolved_target_ref", "evidence_ref"]).execute());
      const applied = await relations();
      expect(applied).toHaveLength(interruption === "before it is applied" ? 0 : 1);
      const eventIds = (await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute()).map((row) => row.id).sort();
      const second = start();
      try {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const delivered = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select("event_id").execute());
          if (JSON.stringify(delivered.map((row) => row.event_id).sort()) === JSON.stringify(eventIds)) break;
          if (Date.now() >= deadline) throw new Error("the restarted publisher never caught up");
          await Bun.sleep(50);
        }
      } finally {
        second.kill("SIGTERM");
        await Promise.race([second.exited, Bun.sleep(10_000).then(() => { second.kill("SIGKILL"); return second.exited; })]);
      }
      expect(await relations()).toEqual([{ relation_id: expect.any(String), unresolved_target_ref: "logical_item:task:T1", evidence_ref: `analysis_link_declaration:${unit}:tasks:1:T1` }]);
      if (applied.length > 0) expect(await relations()).toEqual(applied);
    } finally { server?.stop(true); await observation.destroy(); await scratch.drop(); await authority.close(); }
  }, 180_000);
