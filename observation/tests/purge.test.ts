import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { purgeRun } from "../src/purge/purge";
import { deletedRunId, handleOperatorEvent } from "../src/purge/trigger";
import { withTenant, type Database } from "../src/storage/database";
import { recordHumanGrade, registerGradingContext } from "../src/storage/grading-store";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";
import type { ItemOccurrenceId } from "../src/domain/identity";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const request = { tenant, run_id: "run-1", trigger_event_id: "delete-event", trigger_run_key: "run-1", operator_override: false };
const count = async (db: Database, table: string): Promise<number> => withTenant(db, tenant, async (trx) =>
  Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(`observation.${table}`)}`.execute(trx)).rows[0]?.count ?? 0));

export async function seedHumanGrade(db: Database, occurrence_id: ItemOccurrenceId): Promise<void> {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const result = await recordHumanGrade(db, tenant, { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
    question_version: question.question_version, evaluator_definition_id: "human", config_digest: "config-1",
    attempt_label: "one", details: { answer: { state: "answered", kind: "boolean", value: true },
      probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
      decision_policy_version: null, reviewer_id: "operator", reviewer_details: null,
      comments: null, rationale: null, quality_flags: [], supersedes_observation_id: null } });
  expect(result.ok).toBe(true);
}

test("only a run invalidation confirmed absent is a purge trigger", () => {
  const event = { id: "delete-event", run_key: "run-1",
    payload: { kind: "invalidate", data: { target: "run", run_id: "run-1" } },
    run_exists: false, operator_override: false };
  expect([deletedRunId(event), deletedRunId({ ...event, run_exists: true }),
    deletedRunId({ ...event, payload: { kind: "invalidate", data: { target: "runs", run_id: "run-1" } } })])
    .toEqual(["run-1", null, null]);
});

integration("purge removes six layers and commits their audit counts", async () => {
  await scratchGrading(async (db, occurrence_id) => {
    await seedHumanGrade(db, occurrence_id);
    const issue_id = canonicalDigest(["purge issue"]);
    if (!issue_id.ok) throw new Error(issue_id.error.detail);
    await withTenant(db, tenant, async (trx) => {
      await sql`INSERT INTO observation.extraction_issue (producer, namespace, issue_id, revision_id,
        extractor_id, extractor_version, item_selector, kind, detail, is_retriable)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${issue_id.value}, 'rev-1',
          'fixture', '1', '/criterion', 'unresolved_relation', 'test', false)`.execute(trx);
      await sql`INSERT INTO observation.item_relation (producer, namespace, relation_id,
        source_occurrence_id, unresolved_target_ref, type, asserted_by, evidence_ref)
        VALUES (${tenant.producer}, ${tenant.namespace}, 'relation-1', ${occurrence_id},
          'missing', 'addresses', 'human', 'test')`.execute(trx);
    });
    const result = await purgeRun(db, request);
    expect(result.ok && result.value).toMatchObject({ source_revisions_removed: 1, item_occurrences_removed: 1,
      item_relations_removed: 1, extraction_issues_removed: 1, evaluation_executions_removed: 1,
      grade_observations_removed: 1, trigger_event_id: "delete-event", operator_override: false });
    expect(await Promise.all(["source_revision", "item_occurrence", "item_relation", "extraction_issue",
      "evaluation_execution", "grade_observation"].map((table) => count(db, table)))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await count(db, "purge_event")).toBe(1);
  });
});

integration("ordinary invalidation and failed audit leave captured rows intact", async () => {
  await scratchGrading(async (db) => {
    const event = { id: "ordinary", run_key: "run-1", payload: { kind: "invalidate", data: { target: "run", run_id: "run-1" } },
      run_exists: true, operator_override: false };
    expect(await handleOperatorEvent(db, tenant, event)).toEqual({ ok: true, value: null });
    const failed = await purgeRun(db, request, { beforeAudit: async () => { throw new Error("audit write refused"); } });
    expect(failed.ok).toBe(false);
    expect([await count(db, "source_revision"), await count(db, "item_occurrence"), await count(db, "purge_event")])
      .toEqual([1, 1, 0]);
  });
});
