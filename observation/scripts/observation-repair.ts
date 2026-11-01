/** Repair a finite authority history range without changing live delivery positions. */
import { Client } from "pg";
import { sql } from "kysely";
import { mapObservationEvent } from "../../oakridge-dbos/src/adapters/observation-mapping";
import { openDatabase as openAuthorityDatabase } from "../../oakridge-dbos/src/storage/database";
import type { Event } from "../../oakridge-dbos/src/core-client/core-types";
import { readEventRevisionSequence, readEventUnitStage, readPinnedDefinition,
  type CommittedEventRow } from "../../oakridge-dbos/src/storage/read-store";
import { readDecisionForEvent } from "../../oakridge-dbos/src/storage/observation-backfill-store";
import { openDatabase, withTenant } from "../src/storage/database";
import { readSourceCursor, repairSourceEvent } from "../src/storage/capture-store";
import type { SourceEventCursor } from "../src/ingest/cursor";

interface Counts { readonly revisions: number; readonly occurrences: number; readonly grades: number;
  readonly issues: number; readonly unresolved_issues: number }
async function counts(db: ReturnType<typeof openDatabase>, tenant: { producer: string; namespace: string }): Promise<Counts> {
  const result = await withTenant(db, tenant, (trx) => sql<Counts>`SELECT
    (SELECT count(*)::integer FROM observation.source_revision WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}) AS revisions,
    (SELECT count(*)::integer FROM observation.item_occurrence WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}) AS occurrences,
    (SELECT count(*)::integer FROM observation.grade_observation WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}) AS grades,
    (SELECT count(*)::integer FROM observation.source_event_issue WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}) AS issues,
    (SELECT count(*)::integer FROM observation.source_event_issue WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}
      AND resolution_state = 'unresolved') AS unresolved_issues`.execute(trx));
  return result.rows[0]!;
}

const args = process.argv.slice(2);
const value = (flag: string): string | null => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1] ?? null; };
const through = value("--through-txid");
const namespace = value("--namespace") ?? process.env.OAKRIDGE_OBSERVATION_NAMESPACE ?? "default";
const dry_run = args.includes("--dry-run");
if (!through || !/^[0-9]+$/.test(through)) throw new Error("--through-txid requires a finite decimal transaction ID");
const authority_url = process.env.DBOS_SYSTEM_DATABASE_URL;
const observation_url = process.env.OBSERVATION_DATABASE_URL;
if (!authority_url || !observation_url) throw new Error("DBOS_SYSTEM_DATABASE_URL and OBSERVATION_DATABASE_URL are required");
const tenant = { producer: "oakridge", namespace };
const authority = openAuthorityDatabase(authority_url);
const observation = openDatabase(observation_url);
const lock = new Client({ connectionString: observation_url });
await lock.connect();
try {
  await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`observation:repair:${namespace}`]);
  const before_cursor = await readSourceCursor(observation, tenant);
  const before = await counts(observation, tenant);
  let after: SourceEventCursor = { commit_txid: "0", id: "" };
  let inspected = 0, repaired = 0, purged = 0, conflicts = 0;
  for (;;) {
    const batch = await sql<{ id: string; run_id: string | null; unit_id: string | null; payload: Event;
      created_at: Date; commit_txid_text: string; collection_key: string | null; was_visible_at_subscription: boolean }>`
      SELECT id, run_id, unit_id, payload, created_at, commit_txid::text AS commit_txid_text,
        (SELECT u.collection_key FROM authority.unit u WHERE u.run_id = source_event.run_id AND u.id = source_event.unit_id)
          AS collection_key,
        false AS was_visible_at_subscription FROM authority.event AS source_event
      WHERE (commit_txid, id) > (${after.commit_txid}::bigint, ${after.id})
        AND commit_txid <= ${through}::bigint ORDER BY authority.event.commit_txid, authority.event.id LIMIT 100`.execute(authority);
    const rows: readonly CommittedEventRow<Event>[] = batch.rows.map(({ commit_txid_text, ...row }) =>
      ({ ...row, commit_txid: commit_txid_text }));
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = row.payload;
      const definition = await readPinnedDefinition(authority, row.run_id ?? "");
      const stage = event.kind === "revision_published" || event.kind === "operator_decided"
        ? await readEventUnitStage(authority, row.run_id ?? "", event.unit) : null;
      const revision_sequence = event.kind === "revision_published"
        ? await readEventRevisionSequence(authority, row, event.artifact) : null;
      const decision = event.kind === "operator_decided"
        ? await readDecisionForEvent(authority, row.run_id ?? "", event, row.created_at) : null;
      const outcome = mapObservationEvent({ row, definition, namespace, stage, revision_sequence,
        decision_effect: decision?.effect ?? null, decision_created_at: decision?.created_at,
        decision_id: decision?.id ?? null });
      inspected++;
      if (!dry_run) {
        try {
          const result = await repairSourceEvent(observation, tenant, outcome, row.commit_txid);
          if (result === "repaired") repaired++;
          if (result === "purged") purged++;
        } catch (cause) {
          conflicts++;
          console.error("[observation repair] refused event", row.id, cause);
        }
      }
      after = { commit_txid: row.commit_txid, id: row.id };
    }
  }
  const after_cursor = await readSourceCursor(observation, tenant);
  const after_counts = await counts(observation, tenant);
  console.log(JSON.stringify({ dry_run, through_txid: through, before_cursor, after_cursor, before, after: after_counts,
    inspected_events: inspected, repaired_events: repaired, conflicts, purge_exclusions: purged,
    note: "A skipped-event count is not an expected count of new rows; one event can produce several rows or none." }, null, 2));
} finally {
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`observation:repair:${namespace}`]);
  await lock.end();
  await observation.destroy();
  await authority.destroy();
}
