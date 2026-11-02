import { expect, test } from "bun:test";
import { Client } from "pg";
import { sql } from "kysely";
import { openAuthority, pinSample, launch } from "../../oakridge-dbos/tests/authority-fixture";
import { createScratchDatabase } from "../scripts/scratch-database";
import { jsonText, openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readSourceCursor } from "../src/storage/capture-store";
import { purgeRun } from "../src/purge/purge";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "repair-test" };
interface RepairReport { readonly dry_run: boolean; readonly resumed_from: { readonly commit_txid: string; readonly id: string };
  readonly progress_after: { readonly commit_txid: string; readonly id: string }; readonly interrupted: boolean;
  readonly before_cursor: unknown; readonly after_cursor: unknown; readonly before: { readonly revisions: number };
  readonly after: { readonly revisions: number }; readonly conflicts: number; readonly purge_exclusions: number }
function start(authority_url: string, observation_url: string, through: string, extra: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env,
    DBOS_SYSTEM_DATABASE_URL: authority_url, OBSERVATION_DATABASE_URL: observation_url };
  delete env.BUN_INSPECT;
  return Bun.spawn([process.execPath, new URL("../scripts/observation-repair.ts", import.meta.url).pathname,
    "--namespace", tenant.namespace, "--through-txid", through, ...extra], { env, stdout: "pipe", stderr: "pipe" });
}
async function result(process: ReturnType<typeof start>): Promise<RepairReport> {
  const [output, error, code] = await Promise.all([new Response(process.stdout).text(),
    new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`repair exited ${code}: ${error}`);
  return JSON.parse(output) as RepairReport;
}

integration("dry run is read only, interrupted repair resumes, and overlapping invocations serialize", async () => {
  const authority = await openAuthority();
  const scratch = await createScratchDatabase(process.env.OAKRIDGE_TEST_DATABASE_URL!, `observation_repair_${crypto.randomUUID().replaceAll("-", "")}`);
  const observation = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(observation);
    const { bundle_id } = await pinSample(authority);
    const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "repair" } });
    const horizon = await sql<{ through: string }>`SELECT max(commit_txid)::text AS through FROM authority.event`.execute(authority.db);
    const through = horizon.rows[0]!.through;
    const before = await readSourceCursor(observation, tenant);
    const dry = await result(start(authority.url, scratch.url, through, ["--dry-run"]));
    const progressBefore = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_repair_position")
      .selectAll().execute());
    expect({ dry: dry.dry_run, cursor: dry.before_cursor, after_cursor: dry.after_cursor,
      counts: dry.before, after: dry.after, progress: progressBefore.length })
      .toEqual({ dry: true, cursor: before, after_cursor: before, counts: dry.before, after: dry.before, progress: 0 });

    const interrupted = await result(start(authority.url, scratch.url, through, ["--max-events", "1"]));
    expect(interrupted.interrupted).toBe(true);
    const resumed = await result(start(authority.url, scratch.url, through));
    expect(resumed.resumed_from).toEqual(interrupted.progress_after);
    expect(resumed.conflicts).toBe(0);
    expect(await readSourceCursor(observation, tenant)).toEqual(before);

    const prior = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select(["event_id", "detail"]).orderBy("event_id").executeTakeFirstOrThrow());
    await withTenant(observation, tenant, (trx) => trx.updateTable("observation.source_event_outcome")
      .set({ detail: jsonText({ tampered: true }) }).where("event_id", "=", prior.event_id).execute());
    const conflicted = await result(start(authority.url, scratch.url, through, ["--dry-run"]));
    expect(conflicted.conflicts).toBeGreaterThan(0);
    await withTenant(observation, tenant, (trx) => trx.updateTable("observation.source_event_outcome")
      .set({ detail: jsonText(prior.detail) }).where("event_id", "=", prior.event_id).execute());

    const blocker = new Client({ connectionString: scratch.url });
    await blocker.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`observation:repair:${tenant.namespace}`]);
      const first = start(authority.url, scratch.url, through);
      const second = start(authority.url, scratch.url, through);
      await Bun.sleep(150);
      expect([first.exitCode, second.exitCode]).toEqual([null, null]);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`observation:repair:${tenant.namespace}`]);
      const reports = await Promise.all([result(first), result(second)]);
      expect(reports.map((report) => report.conflicts)).toEqual([0, 0]);
    } finally { await blocker.end(); }
    const purged = await purgeRun(observation, { tenant, run_id, trigger_event_id: "repair-test-purge",
      trigger_run_key: run_id, operator_override: false });
    expect(purged.ok).toBe(true);
    const excluded = await result(start(authority.url, scratch.url, through, ["--dry-run"]));
    expect(excluded.purge_exclusions).toBeGreaterThan(0);
  } finally { await observation.destroy(); await scratch.drop(); await authority.close(); }
});
