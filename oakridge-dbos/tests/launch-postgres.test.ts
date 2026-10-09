import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { deleteRun } from "../src/storage/run-lifecycle";
import { createMutationService, type MutationService, type StartedRun } from "../src/storage/mutation-service";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { stubProviderCapabilities, withDatabase } from "./effect-fixture";

async function withLauncher(operation: (deps: { db: PgPostgresExecutor; core: CoreClient; mutations: MutationService; digest: string; url: string }) => Promise<void>): Promise<void> {
  await withDatabase(async ({ db, url }) => {
    const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
    if (!started.ok) throw new Error(started.error.detail.detail);
    const core = started.value;
    try {
      const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
      const mutations = createMutationService(db, core, stubProviderCapabilities);
      const pinned = await mutations.pinDefinition({ bundle });
      if (!pinned.ok) throw new Error(pinned.error.detail);
      await operation({ db, core, mutations, digest: pinned.value.digest, url });
    } finally { core.close(); }
  });
}

test("concurrent identical launch requests create one run, root and receipt", async () => {
  await withLauncher(async ({ db, mutations, digest }) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => mutations.startRunByDigest({ digest, input: {}, request_id: "same-launch" })));
    expect(results).toEqual(Array.from({ length: 8 }, () => results[0]));
    expect(results[0]?.ok).toBe(true);
    expect(await db.query("SELECT (SELECT count(*)::int FROM authority.run) AS runs, (SELECT count(*)::int FROM authority.scope_instance) AS roots, (SELECT count(*)::int FROM authority.launch_receipt) AS receipts", []))
      .toEqual([{ runs: 1, roots: 1, receipts: 1 }]);
  });
});

test("a fresh service replays a committed launch without a live core", async () => {
  await withLauncher(async ({ mutations, digest, url }) => {
    const request = { digest, input: {}, request_id: "lost-response" };
    const accepted = await mutations.startRunByDigest(request);
    const freshDb = PgPostgresExecutor.connect(url);
    try {
      const fresh = createMutationService(freshDb, {} as CoreClient);
      expect(await fresh.startRunByDigest(request)).toEqual(accepted);
    } finally { await freshDb.close(); }
  });
});

test("a launch identity rejects different input or digest and permits a deliberate new launch", async () => {
  await withLauncher(async ({ db, mutations, digest }) => {
    const request = { digest, input: {}, request_id: "original" };
    await mutations.startRunByDigest(request);
    for (const changed of [{ ...request, input: { changed: true } }, { ...request, digest: "different-digest" }]) {
      expect(await mutations.startRunByDigest(changed)).toMatchObject({ ok: false, error: { operation: "launch_conflict" } });
    }
    expect((await mutations.startRunByDigest({ ...request, request_id: "deliberate-new-launch" })).ok).toBe(true);
    expect(await db.query("SELECT count(*)::int AS runs FROM authority.run", [])).toEqual([{ runs: 2 }]);
  });
});

test("a receipt write failure rolls back the run and retry can create it once", async () => {
  await withLauncher(async ({ db, core, mutations, digest }) => {
    const failing: TransactionalSqlExecutor = {
      query: db.query.bind(db),
      transaction: (operation, isolation) => db.transaction((tx) => operation({ query: async (sql, parameters) => {
        if (sql.startsWith("INSERT INTO authority.launch_receipt")) throw new Error("receipt write failed");
        return tx.query(sql, parameters);
      } }), isolation),
    };
    const request = { digest, input: {}, request_id: "rollback" };
    expect(await createMutationService(failing, core).startRunByDigest(request)).toMatchObject({ ok: false, error: { operation: "start_run_storage" } });
    expect(await db.query("SELECT (SELECT count(*)::int FROM authority.run) AS runs, (SELECT count(*)::int FROM authority.scope_instance) AS roots, (SELECT count(*)::int FROM authority.launch_receipt) AS receipts", []))
      .toEqual([{ runs: 0, roots: 0, receipts: 0 }]);
    expect((await mutations.startRunByDigest(request)).ok).toBe(true);
  });
});

test("a lost database commit acknowledgement retains the receipt for safe replay", async () => {
  await withLauncher(async ({ db, core, mutations, digest }) => {
    const uncertain: TransactionalSqlExecutor = {
      query: db.query.bind(db),
      transaction: async (operation, isolation) => {
        await db.transaction(operation, isolation);
        throw new Error("commit acknowledgement lost");
      },
    };
    const request = { digest, input: {}, request_id: "lost-commit-ack" };
    expect(await createMutationService(uncertain, core).startRunByDigest(request)).toMatchObject({ ok: false, error: { operation: "start_run_storage" } });
    const stored = await db.query<StartedRun>("SELECT run_id,root_scope_id,bundle_id FROM authority.launch_receipt WHERE request_id=$1", [request.request_id]);
    expect(await mutations.startRunByDigest(request)).toEqual({ ok: true, value: stored[0] });
    expect(await db.query("SELECT count(*)::int AS runs FROM authority.run", [])).toEqual([{ runs: 1 }]);
  });
});

test("a deleted run leaves a launch tombstone and cannot be recreated by retry", async () => {
  await withLauncher(async ({ db, mutations, digest }) => {
    const request = { digest, input: {}, request_id: "deleted-launch" };
    const result = await mutations.startRunByDigest(request);
    if (!result.ok) throw new Error(result.error.detail);
    expect(await deleteRun(db, result.value.run_id)).toEqual({ kind: "deleted" });
    expect(await mutations.startRunByDigest(request)).toMatchObject({ ok: false, error: { operation: "launch_gone" } });
    expect(await db.query("SELECT (SELECT count(*)::int FROM authority.run) AS runs, (SELECT count(*)::int FROM authority.launch_receipt) AS receipts", []))
      .toEqual([{ runs: 0, receipts: 1 }]);
  });
});

test("deleting a run removes collaboration records and retains committed event frames", async () => withDatabase(async ({ db }) => {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root','{}','{}')", []);
  await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution','scope','agent',1,'terminal')", []);
  await db.query("INSERT INTO authority.artifact_revision (id,scope_id,execution_id,output_key,body) VALUES ('revision','scope','execution','plan','{}')", []);
  await db.query("INSERT INTO authority.output_slot (id,scope_id,output_key,current_revision_id) VALUES ('slot','scope','plan','revision')", []);
  await db.query("INSERT INTO authority.collaboration_thread (id,run_id,scope_id,output_key,revision_id,status) VALUES ('thread','run','scope','plan','revision','open')", []);
  await db.query("INSERT INTO authority.collaboration_message (id,thread_id,body,author) VALUES ('message','thread','review','operator')", []);
  await db.query("INSERT INTO authority.review_item (id,run_id,scope_id,output_key,revision_id,anchor,claim,reality,status) VALUES ('review','run','scope','plan','revision','section','claim','reality','open')", []);
  await db.query("INSERT INTO authority.collaboration_delivery (id,thread_id,request_key,target_execution_id,transcript,status) VALUES ('delivery','thread','request','execution','{}','delivered')", []);
  await db.query("INSERT INTO authority.operator_event (id,run_id,scope_id,payload) VALUES ('event','run','scope','{\"kind\":\"complete\"}')", []);

  expect(await deleteRun(db, "run")).toEqual({ kind: "deleted" });
  expect(await db.query(`SELECT
    (SELECT count(*)::int FROM authority.run) AS runs,
    (SELECT count(*)::int FROM authority.collaboration_thread) AS threads,
    (SELECT count(*)::int FROM authority.collaboration_message) AS messages,
    (SELECT count(*)::int FROM authority.review_item) AS reviews,
    (SELECT count(*)::int FROM authority.collaboration_delivery) AS deliveries`, []))
    .toEqual([{ runs: 0, threads: 0, messages: 0, reviews: 0, deliveries: 0 }]);
  expect(await db.query("SELECT payload FROM authority.operator_event WHERE id='event'", []))
    .toEqual([{ payload: { kind: "complete" } }]);
}));
