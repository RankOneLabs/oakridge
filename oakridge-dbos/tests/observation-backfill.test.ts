import { expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../../observation/src/http/app";
import { canonicalDigest } from "../../observation/src/canonical/canonical-json";
import { openDatabase as openObservationDatabase, withTenant } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { projectRevision } from "../../observation/src/storage/projection-store";
import { recordHumanGrade, registerGradingContext } from "../../observation/src/storage/grading-store";
import { evidence as sampleEvidence, evaluator as sampleEvaluator, question as sampleQuestion } from "../../observation/tests/grading-fixture";
import type { ItemOccurrenceId } from "../../observation/src/domain/identity";
import { INITIAL_BACKFILL_POSITION, runObservationBackfill } from "../src/adapters/observation-backfill";
import { publishObservationOnce, publishObservationOperatorOnce, type ObservationOptions } from "../src/adapters/observation";
import { jsonText } from "../src/storage/database";
import type { RunId } from "../src/domain/primitives";
import { launch, openAuthority, pinSample, scratchDatabase, unitOf } from "./authority-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "backfill-test" };
const digest = (body: unknown): string => {
  const value = canonicalDigest(body);
  if (!value.ok) throw new Error(value.error.detail);
  return value.value;
};
const brief = { cohort_id: "c", decisions_made: [], approaches_rejected: [],
  acceptance_criteria: [{ id: "criterion-1", text: "Works", task_ids: [], decision_ids: [] }] };

integration("bounded backfill covers active and archived labels, anchors, replay and live overlap", async () => {
  const authority = await openAuthority();
  const scratch = await scratchDatabase();
  const observation = openObservationDatabase(scratch.url);
  try {
    await migrateObservation(observation);
    const app = createApp({ db: observation, credentials: {
      ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] } });
    const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest",
      fetcher: async (input, init) => app.request(new Request(input, init)) };
    const { bundle_id } = await pinSample(authority);
    async function seed(archived: boolean, effect: "approve" | "request_changes", number: number) {
      const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: `run-${number}` } });
      const unit_id = unitOf(run_id, "document");
      const revision_id = `${unit_id}:brief:1`;
      await authority.db.insertInto("authority.artifact_revision").values({ id: revision_id, run_id, unit_id,
        artifact: "brief", seq: 1, body: jsonText(brief), by_id: null, predecessor_id: null, subject: null }).execute();
      if (archived) await authority.db.updateTable("authority.run").set({ archived_at: new Date() }).where("id", "=", run_id).execute();
      await withTenant(observation, tenant, (trx) => sql`INSERT INTO observation.source_revision
        (producer, namespace, revision_id, run_id, unit_id, artifact_kind, artifact_schema_version,
         definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${revision_id}, ${run_id}, ${unit_id},
          'brief', '1', ${bundle_id}, 'bundle-digest', ${JSON.stringify(brief)}::jsonb, ${digest(brief)}, now())`.execute(trx));
      expect(await projectRevision(observation, tenant, revision_id)).toMatchObject({ occurrences: 1 });
      const decision_id = `${unit_id}:d${number}`;
      const event_id = crypto.randomUUID();
      const feedback = { note: effect };
      const at = new Date(Date.UTC(2026, 9, 28, 0, 0, number));
      await authority.db.insertInto("authority.review_decision").values({ id: decision_id, run_id, unit_id,
        review: "editor", decision: effect, effect, target_revision_id: revision_id,
        payload: jsonText(feedback), validation_artifact: null, validation_messages: null, created_at: at }).execute();
      await authority.db.insertInto("authority.event").values({ id: event_id, run_id, unit_id,
        payload: jsonText({ kind: "operator_decided", unit: unit_id, review: "editor", decision: effect,
          target: revision_id, payload: feedback }), writer: jsonText({ kind: "operator", subject: "test" }),
        ingress_id: crypto.randomUUID(), created_at: new Date(at.getTime() + 1) }).execute();
      return { run_id, unit_id, revision_id, event_id };
    }
    const active = await seed(false, "approve", 1);
    const archived = await seed(true, "request_changes", 2);
    for (const [index, anchor] of ["/acceptance_criteria/0", "/acceptance_criteria/9"].entries()) {
      const thread_id = `thread-${index}`;
      await authority.db.insertInto("authority.collaboration_thread").values({ id: thread_id,
        run_id: archived.run_id, unit_id: archived.unit_id, artifact_revision_id: archived.revision_id,
        context: jsonText({ title: "Review", anchor }), created_at: new Date(Date.UTC(2026, 9, 28, 0, 1, index)) }).execute();
      await authority.db.insertInto("authority.collaboration_message").values({ id: `message-${index}`,
        run_id: archived.run_id, unit_id: archived.unit_id, thread_id,
        body: jsonText({ text: `Comment ${index}`, author: "operator" }) }).execute();
    }
    let result = await runObservationBackfill(authority.db, options, { max_rows: 1, position: null });
    if (!result.ok) throw new Error(result.error.detail);
    expect(result.ok).toBe(true);
    for (let index = 0; index < 5 && result.ok && !result.value.is_done; index++)
      result = await runObservationBackfill(authority.db, options, { max_rows: 1, position: null });
    if (!result.ok) throw new Error(result.error.detail);
    expect(result.value).toMatchObject({ is_done: true, counts: {
      review_decision: { active: 1, archived: 1 }, collaboration_thread: { active: 0, archived: 2 } } });
    const counts = async () => withTenant(observation, tenant, async (trx) => {
      const tables = ["source_revision", "item_occurrence", "item_relation", "evaluation_execution", "grade_observation"];
      return Promise.all(tables.map(async (table) => Number((await sql<{ count: string }>`SELECT count(*)::text AS count
        FROM ${sql.table(`observation.${table}`)}`.execute(trx)).rows[0]?.count ?? 0)));
    });
    const firstCounts = await counts();
    expect(firstCounts).toEqual([2, 2, 0, 2, 2]);
    const replay = await runObservationBackfill(authority.db, options,
      { max_rows: 4, position: INITIAL_BACKFILL_POSITION });
    expect(replay.ok).toBe(true);
    expect(await counts()).toEqual(firstCounts);
    for (let index = 0; index < 10 && await publishObservationOnce(authority.db, options); index++);
    expect(await counts()).toEqual(firstCounts);
    const comments = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_collaboration_comment")
      .select(["anchor", "occurrence_id"]).orderBy("message_id").execute());
    expect(comments.map((row) => [row.anchor, row.occurrence_id !== null])).toEqual([
      ["/acceptance_criteria/0", true], ["/acceptance_criteria/9", false] ]);
    const unresolved = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.extraction_issue")
      .select(["item_selector", "kind"]).where("revision_id", "=", archived.revision_id)
      .where("kind", "=", "unresolved_relation").execute());
    expect(unresolved).toEqual([{ item_selector: "/acceptance_criteria/9", kind: "unresolved_relation" }]);
    const archivedGrades = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.item_occurrence as i", "i.occurrence_id", "g.subject_occurrence_id")
      .select(["g.answer_payload", "g.recorded_at"]).where("i.run_id", "=", archived.run_id).execute());
    expect(archivedGrades).toHaveLength(1);
    expect(archivedGrades[0]?.answer_payload).toMatchObject({ value: { review: "editor", decision: "request_changes",
      effect: "request_changes", feedback: { note: "request_changes" } } });
    const activeGrades = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.item_occurrence as i", "i.occurrence_id", "g.subject_occurrence_id")
      .select("g.answer_payload").where("i.run_id", "=", active.run_id).execute());
    expect(activeGrades[0]?.answer_payload).toMatchObject({ value: { review: "editor", decision: "approve",
      effect: "approve", feedback: { note: "approve" } } });
    const archivedOccurrence = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.item_occurrence")
      .select("occurrence_id").where("run_id", "=", archived.run_id).executeTakeFirstOrThrow());
    const comparisonQuestion = { ...sampleQuestion, target_item_kinds: ["criterion"] };
    expect((await registerGradingContext(observation, tenant, { question: comparisonQuestion,
      evidence: sampleEvidence, evaluator: sampleEvaluator("human") })).ok).toBe(true);
    const submitted = await recordHumanGrade(observation, tenant, { subject_occurrence_id: archivedOccurrence.occurrence_id as ItemOccurrenceId,
      evidence_set_id: sampleEvidence.evidence_set_id, question_id: comparisonQuestion.question_id,
      question_version: comparisonQuestion.question_version, evaluator_definition_id: "human", config_digest: "config-1",
      attempt_label: "comparison", details: { answer: { state: "answered", kind: "boolean", value: true },
        probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
        decision_policy_version: null, reviewer_id: "operator", reviewer_details: null, comments: null,
        rationale: null, quality_flags: [], supersedes_observation_id: null } });
    expect(submitted.ok).toBe(true);
    const shape = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluator_definition as d", (join) => join.onRef("d.producer", "=", "g.producer")
        .onRef("d.namespace", "=", "g.namespace").onRef("d.evaluator_definition_id", "=", "g.evaluator_definition_id"))
      .selectAll("g").select("d.kind as evaluator_kind")
      .where("g.subject_occurrence_id", "=", archivedOccurrence.occurrence_id).orderBy("g.question_id").execute());
    expect(shape.map((row) => row.evaluator_kind)).toEqual(["human", "human"]);
    expect(Object.keys(shape[0] ?? {}).sort()).toEqual(Object.keys(shape[1] ?? {}).sort());
    await withTenant(observation, tenant, (trx) => sql`INSERT INTO observation.source_revision
      (producer, namespace, revision_id, run_id, unit_id, artifact_kind, artifact_schema_version,
       definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'ghost-revision', 'ghost-run', 'ghost-unit',
        'brief', '1', 'bundle', 'digest', '{}'::jsonb, ${digest({})}, now())`.execute(trx));
    const deletion_event_id = crypto.randomUUID();
    await authority.db.insertInto("authority.operator_event").values({ id: deletion_event_id,
      run_id: null, run_key: "ghost-run", payload: jsonText({ kind: "invalidate",
        data: { target: "run", run_id: "ghost-run" as RunId } }) }).execute();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const published = await publishObservationOperatorOnce(authority.db, options);
      const found = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.purge_event")
        .select("trigger_event_id").where("trigger_event_id", "=", deletion_event_id).executeTakeFirst());
      if (found) break;
      if (!published) await Bun.sleep(100);
    }
    const ghost = await withTenant(observation, tenant, async (trx) => ({
      revision: await trx.selectFrom("observation.source_revision").select("revision_id")
        .where("run_id", "=", "ghost-run").execute(),
      purge: await trx.selectFrom("observation.purge_event").select(["trigger_event_id", "source_revisions_removed"])
        .where("run_id", "=", "ghost-run").executeTakeFirst(),
    }));
    expect(ghost).toEqual({ revision: [], purge: { trigger_event_id: deletion_event_id, source_revisions_removed: 1 } });
  } finally { await observation.destroy(); await scratch.drop(); await authority.close(); }
});
