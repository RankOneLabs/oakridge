import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { purgeRun } from "../src/purge/purge";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const digest = (value: unknown): string => {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};

integration("frozen membership refuses purge; explicit override keeps manifest and records its cost", async () => {
  await scratchGrading(async (db, occurrence_id) => {
    await withTenant(db, tenant, async (trx) => {
      await sql`INSERT INTO observation.export_manifest (producer, namespace, manifest_id, frozen_at,
        membership_digest, format_version, redaction_policy, file_hashes)
        VALUES (${tenant.producer}, ${tenant.namespace}, 'manifest-1', now(), ${digest([])},
          'assay-jsonl/v1', '{}'::jsonb, '{}'::jsonb)`.execute(trx);
      await sql`INSERT INTO observation.export_membership (producer, namespace, manifest_id,
        candidate_id, occurrence_id, revision_id, revision_digest, disposition, reason, redaction_reasons)
        VALUES (${tenant.producer}, ${tenant.namespace}, 'manifest-1', ${digest(["candidate"])},
          ${occurrence_id}, 'rev-1', ${digest({})}, 'excluded', 'test', '[]'::jsonb)`.execute(trx);
    });
    const request = { tenant, run_id: "run-1", trigger_event_id: "delete-event",
      trigger_run_key: "run-1", operator_override: false };
    const refused = await purgeRun(db, request);
    expect(refused.ok ? null : refused.error.code).toBe("frozen_export");
    const before = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
      .select("revision_id").execute());
    expect(before).toHaveLength(1);
    const overridden = await purgeRun(db, { ...request, operator_override: true });
    expect(overridden.ok && overridden.value).toMatchObject({ operator_override: true,
      frozen_manifest_ids: ["manifest-1"], source_revisions_removed: 1, item_occurrences_removed: 1 });
    const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.purge_event")
      .select(["operator_override", "frozen_manifest_ids"]).executeTakeFirstOrThrow());
    expect(stored).toMatchObject({ operator_override: true, frozen_manifest_ids: ["manifest-1"] });
    const membership = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.export_membership")
      .select("occurrence_id").executeTakeFirstOrThrow());
    expect(membership.occurrence_id).toBe(occurrence_id);
  });
});
