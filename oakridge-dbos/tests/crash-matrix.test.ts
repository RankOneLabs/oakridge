import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { CoreClient } from "../src/core-client/client";
import { pendingCleanupCount, type EffectPayload } from "../src/effects/intents";
import type { EffectProvider } from "../src/effects/provider";
import { createProductionComposition } from "../src/runtime/compose";
import { unsealEffectPayload } from "../src/storage/effect-secret";
import { cancelRun, createMutationService, deleteRun } from "../src/storage/mutation-service";
import { unit, waitUntil, withDatabase } from "./effect-fixture";

/**
 * A real process is killed at each cut. The authority rows must then show one
 * selected execution and one start intent, deletion must stay refused until a
 * stop is positively acknowledged, and a fresh process of the same engine
 * version must resume the parked DBOS workflow instead of starting a second
 * external execution.
 */
const cuts = ["before_decision_commit", "after_decision_commit", "after_accept_before_response", "after_revocation_before_stop", "after_stop_before_ack"] as const;
interface StartRow { readonly id: string; readonly execution_id: string; readonly status: string; readonly payload: EffectPayload }
const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");
const fast = { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 0.2 };

for (const cut of cuts) {
  test(`real process kill ${cut} retains one selected execution and its cleanup obligation`, async () => {
    await withDatabase(async ({ url, db }) => {
      const started_core = CoreClient.start({ binary, deadlineMs: 1000 });
      if (!started_core.ok) throw new Error(JSON.stringify(started_core.error));
      const core = started_core.value;
      const mutations = createMutationService(db, core);
      const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
      const started = await mutations.startRun({ bundle, input: {} });
      if (!started.ok) throw new Error(JSON.stringify(started.error));
      const run = started.value;
      const begin = { run_id: run.run_id, scope_id: run.root_scope_id, ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit }, operator_version: null };
      const marker = `/tmp/oakridge-cut-${crypto.randomUUID()}`;
      const url_of = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
      // The child runs the real composition with a provider that records the external
      // side effect idempotently, then stops the world at the cut.
      const child_source = `
        import { PgPostgresExecutor } from ${url_of("../src/storage/sql-executor.ts")};
        import { CoreClient } from ${url_of("../src/core-client/client.ts")};
        import { createMutationService } from ${url_of("../src/storage/mutation-service.ts")};
        import { createProductionComposition } from ${url_of("../src/runtime/compose.ts")};
        const real = PgPostgresExecutor.connect(process.env.OAKRIDGE_CRASH_URL);
        const cut = process.env.OAKRIDGE_CRASH_CUT;
        const barrier = async () => { await Bun.write(process.env.OAKRIDGE_CRASH_MARKER, JSON.stringify({ cut })); await new Promise(() => {}); };
        const begin = ${JSON.stringify(begin)};
        const unit = ${JSON.stringify(unit)};
        const bind = (invocation) => real.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$1,$3) ON CONFLICT (scope_id,resource_key) DO NOTHING", [invocation.id, begin.scope_id, JSON.stringify(unit)]);
        if (cut === "before_decision_commit" || cut === "after_decision_commit") {
          const core = CoreClient.start({ binary: process.env.OAKRIDGE_CRASH_CORE, deadlineMs: 1000 }).value;
          const db = { query: real.query.bind(real), transaction: async (operation, isolation) => {
            let writes_receipt = false;
            const value = await real.transaction(async (tx) => {
              const result = await operation({ query: async (sql, params) => { if (sql.startsWith("INSERT INTO authority.ingress_receipt")) writes_receipt = true; return tx.query(sql, params); } });
              if (cut === "before_decision_commit" && writes_receipt) await barrier();
              return result;
            }, isolation);
            if (cut === "after_decision_commit" && writes_receipt) await barrier();
            return value;
          } };
          await createMutationService(db, core).decide(begin);
        } else {
          const provider = {
            start: async (invocation) => { await bind(invocation); if (cut === "after_accept_before_response") await barrier(); return { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "one-session" } }; },
            observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
            stop: async () => {
              if (cut === "after_revocation_before_stop") await barrier();
              await real.query("UPDATE authority.resource_binding SET observation=$1", [JSON.stringify(unit)]);
              if (cut === "after_stop_before_ack") await barrier();
              return { kind: "acknowledged", value: { stopped: true } };
            },
          };
          await createProductionComposition({ database_url: process.env.OAKRIDGE_CRASH_URL, core_binary: process.env.OAKRIDGE_CRASH_CORE, host: "127.0.0.1", effect_provider: provider, timing: ${JSON.stringify(fast)} });
          await new Promise(() => {});
        }`;
      const provider: EffectProvider = {
        start: async (invocation) => {
          await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$1,$3) ON CONFLICT (scope_id,resource_key) DO NOTHING", [invocation.id, run.root_scope_id, JSON.stringify(unit)]);
          return { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "one-session" } };
        },
        stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
        observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
      };
      let child: ReturnType<typeof Bun.spawn> | null = null;
      let engine: Awaited<ReturnType<typeof createProductionComposition>> | null = null;
      try {
        const decision_cut = cut === "before_decision_commit" || cut === "after_decision_commit";
        if (!decision_cut) expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Committed" } });
        const starts_before = await db.query<StartRow>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
        child = Bun.spawn(["bun", "-e", child_source], { stdout: "ignore", stderr: "pipe", env: { ...process.env, OAKRIDGE_CRASH_URL: url, OAKRIDGE_CRASH_CORE: binary, OAKRIDGE_CRASH_MARKER: marker, OAKRIDGE_CRASH_CUT: cut } });
        const acknowledged = async () => (await db.query<StartRow>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "acknowledged";
        if (cut === "after_revocation_before_stop" || cut === "after_stop_before_ack") {
          await waitUntil(acknowledged);
          expect(await cancelRun(db, { kind: "cancel_run", run_id: run.run_id, reason: "operator" }, core)).toMatchObject({ kind: "cancelled", stop_intents: 1 });
        }
        for (let attempt = 0; attempt < 400 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(25);
        if (!(await Bun.file(marker).exists())) { child.kill(); await child.exited; throw new Error(typeof child.stderr === "object" ? await new Response(child.stderr).text() : "child failed before the crash marker"); }
        expect(await Bun.file(marker).json()).toEqual({ cut });
        child.kill(); await child.exited;

        if (cut === "before_decision_commit") {
          expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution", []))[0]?.count).toBe("0");
          expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Committed" } });
        } else expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Replayed" } });
        const starts = await db.query<StartRow>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
        expect(starts).toHaveLength(1);
        if (starts_before.length) expect(starts[0] && unsealEffectPayload(starts[0].payload).invocation.bytes)
          .toBe(starts_before[0] && unsealEffectPayload(starts_before[0].payload).invocation.bytes);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution", []))[0]?.count).toBe("1");
        const is_revoked = cut === "after_revocation_before_stop" || cut === "after_stop_before_ack";
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution_selection WHERE execution_id IS NOT NULL", []))[0]?.count).toBe(is_revoked ? "0" : "1");
        if (!decision_cut) {
          expect(await pendingCleanupCount(db, run.run_id)).toBeGreaterThan(0);
          expect(await deleteRun(db, run.run_id)).toMatchObject({ kind: "refused" });
        }

        // A new process of the same engine version resumes the parked workflows.
        engine = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1", effect_provider: provider, timing: fast });
        const health = await (await engine.app.request("http://localhost/health")).json();
        expect(health).toMatchObject({ status: "ok", core: { pid: expect.any(Number), uptime_ms: expect.any(Number), restart_count: 0, last_stderr_lines: [] } });
        if (!is_revoked) {
          await waitUntil(acknowledged);
          expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.resource_binding", []))[0]?.count).toBe("1");
          const cancelled = await engine.app.request(`http://localhost/runs/${run.run_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel_run", reason: "operator" }) });
          expect(await cancelled.json()).toMatchObject({ kind: "cancelled", stop_intents: 1 });
        }
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
        const stops = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE payload->>'action'='stop'", []);
        expect(stops).toHaveLength(1);
        expect(stops[0]?.payload.invocation.id).toBe(starts[0]?.payload.invocation.id);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.resource_binding", []))[0]?.count).toBe("1");
        expect(await pendingCleanupCount(db, run.run_id)).toBe(0);
        expect(await deleteRun(db, run.run_id)).toEqual({ kind: "deleted" });
      } finally {
        if (child) { child.kill(); await child.exited; }
        if (engine) await engine.close();
        core.close();
        await Bun.file(marker).delete().catch(() => {});
      }
    });
  }, 60_000);
}
