import { expect, test } from "bun:test";
import { sql } from "kysely";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { EvidenceSet } from "../src/grading/evidence";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { mappingKey } from "../src/langfuse/mapping";
import { queueAnnotationTarget } from "../src/langfuse/annotation-queue";
import { scoreConfigFromQuestion } from "../src/langfuse/score-config";
import { withTenant } from "../src/storage/database";
import { upsertLangfuseMapping } from "../src/storage/langfuse-store";
import { registerGradingContext } from "../src/storage/grading-store";
import type { EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import { evaluator, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const question = LANGFUSE_PILOT_QUESTIONS["brief.source_fidelity"].definition;
const sources = [
  { role: "plan_criterion" as const, ref: "revision:plan#/criterion", digest: "plan-digest", deep_link: "https://example.test/plan" },
  { role: "brief_criterion" as const, ref: "revision:brief#/criterion", digest: "brief-digest", deep_link: "https://example.test/brief" },
];
const evidence: EvidenceSet = { evidence_set_id: "queue-evidence" as EvidenceSetId,
  references: sources.map((source) => ({ ref: source.ref, digest: source.digest, content: null })),
  is_incomplete: false, incompleteness_reason: null };
const config = { base_url: "https://example.langfuse.test", project_id: "project",
  credential: { public_key: "public", secret_key: "private" }, annotation_queue_id: "queue",
  decision_evaluator_id: null, retry: { max_attempts: 1, backoff_ms: 0 } };

test("pilot score config categories exactly equal the question allowed values", () => {
  for (const pilot of Object.values(LANGFUSE_PILOT_QUESTIONS)) {
    const result = scoreConfigFromQuestion(pilot.definition, pilot.text);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    const expected = pilot.definition.allowed_values ?? [false, true];
    if (result.value.value_domain.kind !== "numeric")
      expect(JSON.stringify(result.value.value_domain.allowed_values)).toBe(JSON.stringify(expected));
    if (result.value.request.dataType === "CATEGORICAL")
      expect(JSON.stringify(result.value.request.categories?.map((category) => category.label))).toBe(JSON.stringify(expected));
  }
});

integration("queue creation verifies one pinned source occurrence and frozen evidence set", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const key = mappingKey({ occurrence_id, evidence, question_id: question.question_id,
    question_version: question.question_version, projection_version: "v1" });
  if (!key.ok) throw new Error(key.error.detail);
  const mapping = await upsertLangfuseMapping(db, tenant, { base_mapping_key: key.value.mapping_key,
    occurrence_id, evidence_set_id: evidence.evidence_set_id, evidence_set_digest: key.value.evidence_set_digest,
    question_id: question.question_id, question_version: question.question_version, projection_version: "v1",
    execution_id: "projection" as ExecutionId, attempt_id: "projection",
    external_ids: { trace_id: "trace" as never, observation_id: "remote-observation" as never,
      score_id: "judge-score" as never, queue_item_id: "legacy-item" as never } });
  if (!mapping.ok) throw new Error(mapping.error.detail);
  const calls: string[] = [];
  let exposesVerdict = false;
  const client = createLangfuseHttpClient(config, async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/annotation-queues/queue"))
      return Response.json({ id: "queue", scoreConfigIds: ["config"] });
    if (url.endsWith("/score-configs/config"))
      return Response.json({ id: "config", name: "brief.source_fidelity.v1", dataType: "CATEGORICAL",
        categories: [{ value: 0, label: "faithful" }, { value: 1, label: "changed_meaning" },
          { value: 2, label: "unclear_insufficient_evidence" }] });
    if (url.includes("/v2/observations?"))
      return Response.json({ data: [{ id: "remote-observation", traceId: "trace", projectId: "project",
        input: JSON.stringify({ question_text: LANGFUSE_PILOT_QUESTIONS["brief.source_fidelity"].text,
          graded_artifact: "report",
          input_recipe: question.input_recipe, evidence_set: { evidence_set_id: evidence.evidence_set_id,
            evidence_refs: evidence.references.map((ref) => ({ ...ref, is_redacted: false,
              ...(exposesVerdict ? { verdict: "approve" } : {}) })),
            is_incomplete: false, incompleteness_reason: null } }),
        output: JSON.stringify({ execution_id: "projection", status: "completed", error: null,
          model_usage: null, cost: null }) }] });
    return Response.json({ id: "item-1", queueId: "queue", objectId: "remote-observation",
      objectType: "OBSERVATION", status: "PENDING" });
  });
  const target = { mapping_key: mapping.value.mapping_key, sources, graded_artifact: "report" as const };
  const created = await queueAnnotationTarget(db, tenant, client, "queue", target);
  expect(created.ok && created.value).toMatchObject({ occurrence_id, evidence_set_id: evidence.evidence_set_id,
    queue_item_id: "item-1", evidence: { graded_artifact: "report" } });
  expect(calls.map((call) => call.split(" ")[0])).toEqual(["GET", "GET", "GET", "POST", "GET"]);
  exposesVerdict = true;
  const leaked = await queueAnnotationTarget(db, tenant, client, "queue", target);
  expect(leaked).toMatchObject({ ok: false, error: { operation: "annotation_queue" } });
  exposesVerdict = false;
  const missing = await queueAnnotationTarget(db, tenant, client, "queue", { ...target, mapping_key: "missing" });
  expect(missing).toMatchObject({ ok: false, error: { operation: "annotation_queue" } });
  const extra: EvidenceSet = { ...evidence, evidence_set_id: "other-evidence" as EvidenceSetId,
    references: [{ ref: "other", digest: "other", content: null }] };
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.evidence_set").values({
    ...tenant, evidence_set_id: extra.evidence_set_id,
    evidence_refs: sql`${JSON.stringify(extra.references)}::jsonb`, is_incomplete: false,
    incompleteness_reason: null }).execute());
  const otherKey = mappingKey({ occurrence_id, evidence: extra, question_id: question.question_id,
    question_version: "v1", projection_version: "v1" });
  if (!otherKey.ok) throw new Error(otherKey.error.detail);
  const other = await upsertLangfuseMapping(db, tenant, { base_mapping_key: otherKey.value.mapping_key,
    occurrence_id: occurrence_id as ItemOccurrenceId, evidence_set_id: extra.evidence_set_id,
    evidence_set_digest: otherKey.value.evidence_set_digest, question_id: question.question_id as QuestionId,
    question_version: "v1", projection_version: "v1", execution_id: "other" as ExecutionId,
    attempt_id: "other", external_ids: { trace_id: "trace" as never,
      observation_id: "remote-observation" as never, score_id: "other-score" as never,
      queue_item_id: "other-item" as never } });
  expect(other.ok).toBe(true);
  const ambiguous = await queueAnnotationTarget(db, tenant, client, "queue", target);
  expect(ambiguous).toMatchObject({ ok: false, error: { operation: "annotation_queue" } });
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
}));
