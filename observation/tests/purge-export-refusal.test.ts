import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { purgeRun } from "../src/purge/purge";
import { withTenant } from "../src/storage/database";
import { recordHumanGrade, registerGradingContext } from "../src/storage/grading-store";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const digest = (value: unknown): string => {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};

integration("frozen membership refuses purge; explicit override keeps manifest and records its cost", async () => {
  await scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
    const grade = await recordHumanGrade(db, tenant, { subject_occurrence_id: occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: "human", config_digest: "config-1",
      attempt_label: "frozen", details: { answer: { state: "answered", kind: "boolean", value: true },
        probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
        decision_policy_version: null, reviewer_id: "operator", reviewer_details: null,
        comments: null, rationale: null, quality_flags: [], supersedes_observation_id: null } });
    if (!grade.ok || !grade.value.observation) throw new Error("frozen grade fixture was not stored");
    const observation_id = grade.value.observation.observation_id;
    await withTenant(db, tenant, async (trx) => {
      await sql`INSERT INTO observation.export_manifest (producer, namespace, manifest_id, frozen_at,
        membership_digest, format_version, redaction_policy, file_hashes)
        VALUES (${tenant.producer}, ${tenant.namespace}, 'manifest-1', now(), ${digest([])},
          'assay-jsonl/v1', '{}'::jsonb, '{}'::jsonb)`.execute(trx);
      await sql`INSERT INTO observation.export_membership (producer, namespace, manifest_id,
        candidate_id, occurrence_id, revision_id, revision_digest, evidence_set_id, evidence_set_digest,
        observation_id, disposition, reason, redaction_reasons)
        VALUES (${tenant.producer}, ${tenant.namespace}, 'manifest-1', ${digest(["candidate"])},
          ${occurrence_id}, 'rev-1', ${digest({})}, ${evidence.evidence_set_id}, ${digest(evidence.references)},
          ${observation_id},
          'excluded', 'test', '[]'::jsonb)`.execute(trx);
    });
    await expect(withTenant(db, tenant, (trx) => sql`DELETE FROM observation.item_occurrence
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}
        AND occurrence_id = ${occurrence_id}`.execute(trx))).rejects.toThrow("frozen export membership");
    await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.item_occurrence SET occurrence_id = 'changed'
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}
        AND occurrence_id = ${occurrence_id}`.execute(trx))).rejects.toThrow("frozen export membership");
    await expect(withTenant(db, tenant, (trx) => sql`DELETE FROM observation.evidence_set
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}
        AND evidence_set_id = ${evidence.evidence_set_id}`.execute(trx))).rejects.toThrow("frozen export membership");
    const request = { tenant, run_id: "run-1", trigger_event_id: "delete-event",
      trigger_run_key: "run-1", operator_override: false };
    const refused = await purgeRun(db, request);
    expect(refused.ok ? null : refused.error.code).toBe("frozen_export");
    const before = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
      .select("revision_id").execute());
    expect(before).toHaveLength(1);
    const overridden = await purgeRun(db, { ...request, operator_override: true });
    expect(overridden.ok && overridden.value).toMatchObject({ operator_override: true,
      frozen_manifest_ids: ["manifest-1"], source_revisions_removed: 1, item_occurrences_removed: 1,
      grade_observations_removed: 1 });
    const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.purge_event")
      .select(["operator_override", "frozen_manifest_ids"]).executeTakeFirstOrThrow());
    expect(stored).toMatchObject({ operator_override: true, frozen_manifest_ids: ["manifest-1"] });
    const membership = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.export_membership")
      .select("occurrence_id").executeTakeFirstOrThrow());
    expect(membership.occurrence_id).toBe(occurrence_id);
    expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set")
      .select("evidence_set_id").execute())).toHaveLength(1);
  });
});

integration("new export membership requires all four source references after purge migration", async () => {
  await scratchGrading(async (db, occurrence_id) => {
    await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evidence_set
      (producer, namespace, evidence_set_id, evidence_refs, is_incomplete, incompleteness_reason)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'evidence-1', '[]'::jsonb, false, null)`.execute(trx));
    const invalid = [
      { occurrence_id: "missing-occurrence", revision_id: "rev-1", evidence_set_id: null, observation_id: null },
      { occurrence_id, revision_id: "missing-revision", evidence_set_id: null, observation_id: null },
      { occurrence_id, revision_id: "rev-1", evidence_set_id: "missing-evidence", observation_id: null },
      { occurrence_id, revision_id: "rev-1", evidence_set_id: "evidence-1", observation_id: "missing-grade" },
    ];
    for (const [index, member] of invalid.entries()) {
      await expect(withTenant(db, tenant, async (trx) => {
        const manifest_id = `invalid-manifest-${index}`;
        await sql`INSERT INTO observation.export_manifest (producer, namespace, manifest_id, frozen_at,
          membership_digest, format_version, redaction_policy, file_hashes)
          VALUES (${tenant.producer}, ${tenant.namespace}, ${manifest_id}, now(), ${digest([])},
            'assay-jsonl/v1', '{}'::jsonb, '{}'::jsonb)`.execute(trx);
        await sql`INSERT INTO observation.export_membership (producer, namespace, manifest_id,
          candidate_id, occurrence_id, revision_id, revision_digest, evidence_set_id, evidence_set_digest,
          observation_id, disposition, reason, redaction_reasons)
          VALUES (${tenant.producer}, ${tenant.namespace}, ${manifest_id}, ${digest([index])},
            ${member.occurrence_id}, ${member.revision_id}, ${digest({})}, ${member.evidence_set_id},
            ${member.evidence_set_id === null ? null : digest([])}, ${member.observation_id},
            'excluded', 'test', '[]'::jsonb)`.execute(trx);
      })).rejects.toThrow("does not exist");
    }
  });
});
