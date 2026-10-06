import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { CoreClient } from "../src/core-client/client";
import { createMutationService } from "../src/storage/mutation-service";
import { cancelRun, deleteRun } from "../src/storage/mutation-service";
import { claimIntents, pendingCleanupCount, type EffectPayload } from "../src/effects/leases";
import { dispatchClaim } from "../src/effects/dispatch";
import type { EffectProvider } from "../src/effects/provider";
import { withDatabase, unit } from "./effect-fixture";
import type { ScopeId } from "../src/storage/schema-records";

const cuts = ["before_decision_commit", "after_decision_commit", "before_dispatch", "after_accept_before_response",
  "after_response_before_binding", "after_publication_before_ack", "after_revocation_before_stop", "after_stop_before_ack"] as const;
type CrashCut = typeof cuts[number];
interface StartRow { readonly id: string; readonly execution_id: string; readonly payload: EffectPayload }
interface Marker { readonly cut: CrashCut }

for (const cut of cuts) {
  test(`real process kill ${cut} retains one selected execution and its cleanup obligation`, async () => {
    await withDatabase(async ({ url, db }) => {
      const started_core = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 1000 });
      if (!started_core.ok) throw new Error(JSON.stringify(started_core.error));
      const core = started_core.value;
      const mutations = createMutationService(db, core);
      const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
      const started = await mutations.startRun({ bundle, available_operations: bundle.operations, input: {} });
      if (!started.ok) throw new Error(JSON.stringify(started.error));
      const run = started.value;
      const begin = { run_id: run.run_id, scope_id: run.root_scope_id, ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit }, operator_version: null };
      const marker = `/tmp/oakridge-cut-${crypto.randomUUID()}`;
      const sql_url = new URL("../src/storage/sql-executor.ts", import.meta.url).href;
      const child_imports = `
        import { PgPostgresExecutor } from ${JSON.stringify(sql_url)};
        import { CoreClient } from ${JSON.stringify(new URL("../src/core-client/client.ts", import.meta.url).href)};
        import { createMutationService } from ${JSON.stringify(new URL("../src/storage/mutation-service.ts", import.meta.url).href)};
        import { cancelRun } from ${JSON.stringify(new URL("../src/storage/mutation-service.ts", import.meta.url).href)};
        import { claimIntents } from ${JSON.stringify(new URL("../src/effects/leases.ts", import.meta.url).href)};
        import { dispatchClaim } from ${JSON.stringify(new URL("../src/effects/dispatch.ts", import.meta.url).href)};
        const real=PgPostgresExecutor.connect(process.env.OAKRIDGE_CRASH_URL);
        const core=CoreClient.start({binary:process.env.OAKRIDGE_CRASH_CORE,deadlineMs:1000}).value;
        const barrier=async()=>{core.close(); await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,JSON.stringify({cut:process.env.OAKRIDGE_CRASH_CUT})); await new Promise(()=>{});};
        const begin=${JSON.stringify(begin)};
        const unit=${JSON.stringify(unit)};`;
      const provider: EffectProvider = {
        start: async (invocation) => {
          await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,resource_key) DO NOTHING", [invocation.id, run.root_scope_id, invocation.id, JSON.stringify(unit)]);
          return { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "one-session" } };
        },
        stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
        observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
      };
      let child: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const decision_cut = cut === "before_decision_commit" || cut === "after_decision_commit";
        if (!decision_cut && cut !== "before_dispatch") expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Committed" } });
        const starts_before = await db.query<StartRow>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
        if (cut === "after_stop_before_ack" || cut === "after_revocation_before_stop") {
          const claim = (await claimIntents(db, "initial", 1, 1000))[0]!;
          await dispatchClaim(db, provider, claim, 100);
          if (cut === "after_stop_before_ack") await cancelRun(db, { kind: "cancel_run", run_id: run.run_id, reason: "operator" }, core);
        }
        let code: string;
        if (decision_cut) {
          code = `const db={query:real.query.bind(real),transaction:async(operation,isolation)=>{
            let writes_receipt=false;
            const value=await real.transaction(async(tx)=>{const result=await operation({query:async(sql,params)=>{if(sql.startsWith("INSERT INTO authority.ingress_receipt"))writes_receipt=true;return tx.query(sql,params);}}); ${cut === "before_decision_commit" ? "if(writes_receipt) await barrier();" : ""} return result;},isolation);
            ${cut === "after_decision_commit" ? "if(writes_receipt) await barrier();" : ""} return value;
          }}; await createMutationService(db,core).decide(begin);`;
        } else if (cut === "before_dispatch") {
          code = `await createMutationService(real,core).decide(begin); await claimIntents(real,"killed",1,150); await barrier();`;
        } else if (cut === "after_publication_before_ack") {
          code = `const starts=await real.query("SELECT execution_id FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'",[begin.scope_id]);
            const db={query:real.query.bind(real),transaction:async(operation,isolation)=>{let writes_receipt=false;const result=await real.transaction(tx=>operation({query:async(sql,params)=>{if(sql.startsWith("INSERT INTO authority.ingress_receipt"))writes_receipt=true;return tx.query(sql,params);}}),isolation);if(writes_receipt)await barrier();return result;}};
            await createMutationService(db,core).decide({...begin,ingress_id:"publication",trigger:{id:"publication",key:"tick",payload:unit},outputs:[{scope_id:begin.scope_id,output_key:"document",collection_key:"",predecessor_id:null,expected_slot_version:null,execution_id:starts[0].execution_id,body:unit}]});`;
        } else if (cut === "after_revocation_before_stop") {
          code = `const db={query:real.query.bind(real),transaction:async(operation,isolation)=>{const result=await real.transaction(operation,isolation);await barrier();return result;}};
            await cancelRun(db,{kind:"cancel_run",run_id:begin.run_id,reason:"operator"},core);`;
        } else if (cut === "after_stop_before_ack") {
          code = `const claim=(await claimIntents(real,"killed",1,150))[0];
            const provider={stop:async()=>{await real.query("UPDATE authority.resource_binding SET observation=$1",[JSON.stringify(unit)]);await barrier();}};
            await dispatchClaim(real,provider,claim,100000);`;
        } else {
          code = `const claim=(await claimIntents(real,"killed",1,150))[0];
            const provider={start:async(invocation)=>{
              await real.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$1,$3) ON CONFLICT (scope_id,resource_key) DO NOTHING",[invocation.id,begin.scope_id,JSON.stringify(unit)]);
              ${cut === "after_accept_before_response" ? "await barrier();" : ""}
              return {kind:"acknowledged",value:{kind:"kbbl_session",session_id:"one-session"}};
            }};
            const db=${cut === "after_response_before_binding" ? `{query:real.query.bind(real),transaction:async(operation)=>real.transaction(tx=>operation({query:async(sql,params)=>{if(sql.includes("UPDATE authority.effect_intent SET status=$1"))await barrier();return tx.query(sql,params);}}))}` : "real"};
            await dispatchClaim(db,provider,claim,100000);`;
        }
        child = Bun.spawn(["bun", "-e", child_imports + code], { stdout: "pipe", stderr: "pipe", env: { ...process.env,
          OAKRIDGE_CRASH_URL: url, OAKRIDGE_CRASH_CORE: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), OAKRIDGE_CRASH_MARKER: marker, OAKRIDGE_CRASH_CUT: cut } });
        for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10);
        if (!(await Bun.file(marker).exists())) { child.kill(); await child.exited; throw new Error(typeof child.stderr === "object" ? await new Response(child.stderr).text() : "child failed before the crash marker"); }
        const marked: Marker = await Bun.file(marker).json();
        expect(marked.cut).toBe(cut);
        child.kill(); await child.exited;
        if (cut === "before_decision_commit") {
          expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution", []))[0]?.count).toBe("0");
          expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Committed" } });
        } else expect(await mutations.decide(begin)).toMatchObject({ ok: true, value: { kind: "Replayed" } });
        const starts = await db.query<StartRow>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
        expect(starts).toHaveLength(1);
        if (starts_before.length) expect(starts[0]?.payload.invocation.bytes).toBe(starts_before[0]?.payload.invocation.bytes);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution", []))[0]?.count).toBe("1");
        const is_revoked = cut === "after_revocation_before_stop" || cut === "after_stop_before_ack";
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.execution_selection WHERE execution_id IS NOT NULL", []))[0]?.count).toBe(is_revoked ? "0" : "1");
        expect(await pendingCleanupCount(db, run.run_id)).toBeGreaterThan(0);
        expect(await deleteRun(db, run.run_id)).toMatchObject({ kind: "refused" });
        if (cut === "after_publication_before_ack") {
          expect(await mutations.decide({ ...begin, ingress_id: "publication", trigger: { id: "publication", key: "tick", payload: unit }, outputs: [{ scope_id: run.root_scope_id as ScopeId, output_key: "document", collection_key: "", predecessor_id: null, expected_slot_version: null, execution_id: starts[0]!.execution_id, body: unit }] })).toMatchObject({ ok: true, value: { kind: "Replayed" } });
          expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.artifact_revision", []))[0]?.count).toBe("1");
        }
        await Bun.sleep(180);
        if (!is_revoked) {
          const claim = (await claimIntents(db, "recovered", 1, 1000))[0]!;
          expect(claim.payload.invocation.bytes).toBe(starts[0]?.payload.invocation.bytes);
          await dispatchClaim(db, provider, claim, 100);
          expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.resource_binding", []))[0]?.count).toBe("1");
          await cancelRun(db, { kind: "cancel_run", run_id: run.run_id, reason: "operator" }, core);
        }
        const stops = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE payload->>'action'='stop'", []);
        expect(stops[0]?.count).toBe("1");
        expect(await deleteRun(db, run.run_id)).toMatchObject({ kind: "refused" });
        const stop = (await claimIntents(db, "cleanup", 1, 1000))[0]!;
        expect(stop.payload.invocation.id).toBe(starts[0]?.payload.invocation.id);
        expect((await dispatchClaim(db, provider, stop, 100)).status).toBe("cleanup_confirmed");
        expect(await pendingCleanupCount(db, run.run_id)).toBe(0);
      } finally {
        if (child) { child.kill(); await child.exited; }
        core.close();
        await Bun.file(marker).delete().catch(() => {});
      }
    });
  });
}
