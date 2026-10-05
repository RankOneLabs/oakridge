import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { claimIntents } from "../src/effects/leases";
import { dispatchClaim } from "../src/effects/dispatch";
import { selectedInvocation, type EffectProvider, type InvocationId } from "../src/effects/provider";
import type { Invocation } from "../src/core-client/generated-contracts";

const selection = { definition: { operation: "run", provider: "kbbl", contract_version: 1, deadline_ms: 1000, input_schema: "input",
  max_attempts: 1, outputs: [], settings: [], tools: [] }, input: { schema: "input", data: { kind: "string", value: "selected" } },
  selection: { worker: "agent", action: "build" } } satisfies Invocation;
const invocation = selectedInvocation("stable" as InvocationId, "execution", selection);

for (const cut of ["after_accept_before_response", "after_response_before_binding"] as const) {
  test(`real process kill ${cut} replays one selected external execution`, async () => {
    const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
    if (!adminUrl) return;
    const name = `crash_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: adminUrl });
    const url = new URL(adminUrl); url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const db = PgPostgresExecutor.connect(url.href);
    const marker = `/tmp/oakridge-${name}`;
    try {
      await migrateEmptyDatabase(db);
      await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
      await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
      await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
      await db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload) VALUES ('intent','scope','start',$1)",
        [JSON.stringify({ invocation, action: "start", handle: null })]);
      const childCode = `import { PgPostgresExecutor } from ${JSON.stringify(new URL("../src/storage/sql-executor.ts", import.meta.url).href)};
        import { claimIntents } from ${JSON.stringify(new URL("../src/effects/leases.ts", import.meta.url).href)};
        import { dispatchClaim } from ${JSON.stringify(new URL("../src/effects/dispatch.ts", import.meta.url).href)};
        const real=PgPostgresExecutor.connect(process.env.OAKRIDGE_CRASH_URL);
        const claim=(await claimIntents(real,"killed",1,150))[0];
        const provider={start:async (invocation)=>{
          await real.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('external','scope',$1,'{}') ON CONFLICT (scope_id,resource_key) DO NOTHING",[invocation.id]);
          if(process.env.OAKRIDGE_CRASH_CUT==="after_accept_before_response") {
            await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"accepted"); await new Promise(()=>{});
          }
          return {kind:"acknowledged",value:{kind:"kbbl_session",session_id:"one-session"}};
        }};
        const db=process.env.OAKRIDGE_CRASH_CUT==="after_response_before_binding" ? {
          transaction:real.transaction.bind(real),
          query:async(sql,params)=>{if(sql.includes("UPDATE authority.effect_intent SET status=$1")) {
            await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"response"); await new Promise(()=>{});
          } return real.query(sql,params);}
        } : real;
        await dispatchClaim(db,provider,claim,100000);`;
      const child = Bun.spawn(["bun", "-e", childCode], { stdout: "pipe", stderr: "pipe",
        env: { ...process.env, OAKRIDGE_CRASH_URL: url.href, OAKRIDGE_CRASH_MARKER: marker, OAKRIDGE_CRASH_CUT: cut } });
      for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await Bun.file(marker).exists()).toBe(true);
      child.kill(); await child.exited;
      await new Promise((resolve) => setTimeout(resolve, 180));
      const [claim] = await claimIntents(db, "recovered", 1, 1000);
      expect(claim?.payload.invocation.bytes).toBe(invocation.bytes);
      const provider: EffectProvider = {
        start: async (selected) => {
          await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('external','scope',$1,'{}') ON CONFLICT (scope_id,resource_key) DO NOTHING", [selected.id]);
          return { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "one-session" } };
        },
        stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
        observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
      };
      expect((await dispatchClaim(db, provider, claim!, 100)).status).toBe("acknowledged");
      const external = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.resource_binding", []);
      expect(external[0]?.count).toBe("1");
    } finally {
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await Bun.file(marker).delete().catch(() => {});
    }
  });
}

test("real process kill after external stop preserves cleanup until acknowledgement", async () => {
  const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!adminUrl) return;
  const name = `stop_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const marker = `/tmp/oakridge-${name}`;
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
    await db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload,status) VALUES ('intent','scope','stop',$1,'cleanup_pending')",
      [JSON.stringify({ invocation, action: "stop", handle: { kind: "kbbl_session", session_id: "one-session" } })]);
    const childCode = `import { PgPostgresExecutor } from ${JSON.stringify(new URL("../src/storage/sql-executor.ts", import.meta.url).href)};
      import { claimIntents } from ${JSON.stringify(new URL("../src/effects/leases.ts", import.meta.url).href)};
      import { dispatchClaim } from ${JSON.stringify(new URL("../src/effects/dispatch.ts", import.meta.url).href)};
      const db=PgPostgresExecutor.connect(process.env.OAKRIDGE_CRASH_URL);
      const claim=(await claimIntents(db,"killed",1,150))[0];
      const provider={stop:async(invocation)=>{
        await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('stopped','scope',$1,'{}') ON CONFLICT (scope_id,resource_key) DO NOTHING",[invocation.id]);
        await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"stopped"); await new Promise(()=>{});
      }};
      await dispatchClaim(db,provider,claim,100000);`;
    const child = Bun.spawn(["bun", "-e", childCode], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OAKRIDGE_CRASH_URL: url.href, OAKRIDGE_CRASH_MARKER: marker } });
    for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill(); await child.exited;
    const pending = await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id='intent'", []);
    expect(pending[0]?.status).toBe("in_flight");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const [claim] = await claimIntents(db, "recovered", 1, 1000);
    const provider: EffectProvider = {
      start: async () => ({ kind: "uncertain", detail: "unused" }),
      stop: async (selected) => {
        await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('stopped','scope',$1,'{}') ON CONFLICT (scope_id,resource_key) DO NOTHING", [selected.id]);
        return { kind: "acknowledged", value: { stopped: true } };
      },
      observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
    };
    expect((await dispatchClaim(db, provider, claim!, 100)).status).toBe("cleanup_confirmed");
    const external = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.resource_binding", []);
    expect(external[0]?.count).toBe("1");
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await Bun.file(marker).delete().catch(() => {});
  }
});

test("real process kills around decision, publication and revocation retain committed identities", async () => {
  const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!adminUrl) return;
  const name = `commits_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const marker = `/tmp/oakridge-${name}`;
  const runChild = async (code: string): Promise<void> => {
    await Bun.file(marker).delete().catch(() => {});
    const child = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OAKRIDGE_CRASH_URL: url.href, OAKRIDGE_CRASH_MARKER: marker } });
    for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill(); await child.exited;
  };
  const imports = `import { PgPostgresExecutor } from ${JSON.stringify(new URL("../src/storage/sql-executor.ts", import.meta.url).href)};
    const db=PgPostgresExecutor.connect(process.env.OAKRIDGE_CRASH_URL);`;
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
    await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution','scope','agent',1,'pending')", []);
    await db.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ('selection','scope','agent','execution',1)", []);
    const effect = JSON.stringify({ invocation, action: "start", handle: null });
    const before = `${imports} await db.transaction(async tx=>{
      await tx.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('intent','scope','execution','selected',$1)",[${JSON.stringify(effect)}]);
      await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"before"); await new Promise(()=>{});
    });`;
    await runChild(before);
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent", []))[0]?.count).toBe("0");
    const after = `${imports}
      await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('intent','scope','execution','selected',$1) ON CONFLICT (id) DO NOTHING",[${JSON.stringify(effect)}]);
      await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"after"); setInterval(()=>{},1000);`;
    await runChild(after);
    await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('intent','scope','execution','selected',$1) ON CONFLICT (id) DO NOTHING", [effect]);
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent", []))[0]?.count).toBe("1");
    const publication = `${imports} await db.transaction(async tx=>{
      await tx.query("INSERT INTO authority.artifact_revision (id,scope_id,execution_id,output_key,body) VALUES ('revision','scope','execution','result','{}')",[]);
      await tx.query("INSERT INTO authority.output_slot (id,scope_id,output_key,current_revision_id) VALUES ('slot','scope','result','revision')",[]);
      await tx.query("INSERT INTO authority.ingress_receipt (id,run_id,scope_id,ingress_id,request_digest,result) VALUES ('receipt','run','scope','publish','digest','{}')",[]);
    }); await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"published"); setInterval(()=>{},1000);`;
    await runChild(publication);
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.output_slot", []))[0]?.count).toBe("1");
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.ingress_receipt", []))[0]?.count).toBe("1");
    const revoke = `${imports} import { cancelRun } from ${JSON.stringify(new URL("../src/effects/reconcile.ts", import.meta.url).href)};
      await cancelRun(db,{kind:"cancel_run",run_id:"run",reason:"operator"});
      await Bun.write(process.env.OAKRIDGE_CRASH_MARKER,"revoked"); setInterval(()=>{},1000);`;
    await runChild(revoke);
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE effect_key='selected:stop'", []))[0]?.count).toBe("1");
    expect((await db.query<{ execution_id: string | null }>("SELECT execution_id FROM authority.execution_selection WHERE id='selection'", []))[0]?.execution_id).toBeNull();
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await Bun.file(marker).delete().catch(() => {});
  }
});
