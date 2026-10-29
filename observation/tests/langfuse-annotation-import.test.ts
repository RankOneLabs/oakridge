import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { EvidenceSetId, ExecutionId } from "../src/domain/identity";
import { importLangfuseAnnotation } from "../src/langfuse/annotation-import";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { mappingKey } from "../src/langfuse/mapping";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { upsertLangfuseMapping } from "../src/storage/langfuse-store";
import { evaluator, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const config = { base_url: "https://example.langfuse.test", project_id: "project",
  credential: { public_key: "public", secret_key: "private" }, annotation_queue_id: "queue",
  decision_evaluator_id: null, retry: { max_attempts: 1, backoff_ms: 0 } };

integration("annotation imports through human intake, preserves score mapping, and appends a revision", async () => scratchGrading(async (db, occurrence_id) => {
  const question = { ...LANGFUSE_PILOT_QUESTIONS["brief.source_fidelity"].definition,
    target_item_kinds: ["cohort_criterion"] };
  const evidence = { evidence_set_id: "annotation-evidence" as EvidenceSetId,
    references: [{ ref: "pinned-criterion", content: null, digest: "digest" }],
    is_incomplete: false, incompleteness_reason: null };
  const registered = await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") });
  expect(registered.ok).toBe(true);
  const key = mappingKey({ occurrence_id, evidence, question_id: question.question_id,
    question_version: question.question_version, projection_version: "v1" });
  if (!key.ok) throw new Error(key.error.detail);
  const original = await upsertLangfuseMapping(db, tenant, { base_mapping_key: key.value.mapping_key,
    occurrence_id, evidence_set_id: evidence.evidence_set_id, evidence_set_digest: key.value.evidence_set_digest,
    question_id: question.question_id, question_version: question.question_version,
    projection_version: "v1", execution_id: "projection" as ExecutionId, attempt_id: "projection",
    external_ids: { trace_id: "trace" as never, observation_id: "remote-observation" as never,
      score_id: "judge-score" as never, queue_item_id: "old-queue-item" as never } });
  if (!original.ok) throw new Error(original.error.detail);
  const queueClaim = await upsertLangfuseMapping(db, tenant, { base_mapping_key: original.value.mapping_key as typeof key.value.mapping_key,
    occurrence_id, evidence_set_id: evidence.evidence_set_id, evidence_set_digest: key.value.evidence_set_digest,
    question_id: question.question_id, question_version: question.question_version,
    projection_version: "v1", execution_id: "projection" as ExecutionId, attempt_id: "queue:queue-item",
    external_ids: { trace_id: "trace" as never, observation_id: "remote-observation" as never,
      score_id: "judge-score" as never, queue_item_id: "queue-item" as never } });
  expect(queueClaim.ok).toBe(true);
  let value = "faithful";
  let updatedAt = "2026-10-29T10:00:00.000Z";
  const client = createLangfuseHttpClient(config, async (url) => {
    if (url.includes("/annotation-queues/")) return Response.json({ id: "queue-item", queueId: "queue",
      objectId: "remote-observation", objectType: "OBSERVATION", status: "COMPLETED" });
    if (url.includes("/score-configs/")) return Response.json({ id: "config", name: "brief.source_fidelity.v1",
      dataType: "CATEGORICAL", categories: [
        { value: 0, label: "faithful" }, { value: 1, label: "changed_meaning" },
        { value: 2, label: "unclear_insufficient_evidence" }] });
    return Response.json({ data: [{ id: "human-score", projectId: "project", name: "brief.source_fidelity.v1",
      value, dataType: "CATEGORICAL", source: "ANNOTATION", updatedAt,
      timestamp: "2026-10-29T09:59:00.000Z", comment: "reviewer note", configId: "config",
      queueId: "queue", authorUserId: "reviewer-42",
      subject: { kind: "observation", id: "remote-observation", traceId: "trace" } }] });
  });
  const input = { mapping_key: original.value.mapping_key as typeof key.value.mapping_key,
    queue_item_id: "queue-item", score_id: "human-score", allow_notes: true };
  const first = await importLangfuseAnnotation(db, tenant, config, client, input);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const repeated = await importLangfuseAnnotation(db, tenant, config, client, input);
  expect(repeated.ok && repeated.value.was_replay).toBe(true);
  value = "changed_meaning";
  updatedAt = "2026-10-29T11:00:00.000Z";
  const revision = await importLangfuseAnnotation(db, tenant, config, client, input);
  expect(revision.ok).toBe(true);
  const mappings = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("score_id", "=", "human-score").execute());
  expect(mappings).toHaveLength(2);
  expect(mappings.every((row) => row.queue_item_id === "queue-item" && row.occurrence_id === occurrence_id)).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }],
    grade: [{ ...tenant, token: "grade" }] } });
  const forged = await app.request("/v1/grades", { method: "POST",
    headers: { Authorization: "Bearer grade", "Content-Type": "application/json" },
    body: JSON.stringify({ identity: { subject_occurrence_id: occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: "langfuse-annotation-human",
      config_digest: "langfuse-annotation/v1", attempt_label: "forged" },
    details: { answer: { state: "answered", kind: "choice", value: "faithful" }, reviewer_id: "reviewer-42" } }) });
  expect(forged.status).toBe(400);
  const response = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`,
    { headers: { Authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  const page = await response.json();
  const human = page.items.filter((item: { observation: { label_origin: string } }) =>
    item.observation.label_origin === "langfuse_annotation_blinded");
  expect(human).toHaveLength(2);
  expect(human.map((item: { answer: { value: string } }) => item.answer.value).sort()).toEqual(["changed_meaning", "faithful"]);
  const initial = human.find((item: { observation: { observation_id: string } }) => item.observation.observation_id === first.value.observation_id);
  const corrected = human.find((item: { observation: { supersedes_observation_id: string | null } }) =>
    item.observation.supersedes_observation_id === first.value.observation_id);
  expect(initial?.observation.reviewer_id).toBe("reviewer-42");
  expect(initial?.observation.comments).toBe("reviewer note");
  expect(initial?.observation.reviewer_details).toMatchObject({ action: "create", score_id: "human-score",
    queue_item_id: "queue-item", score_timestamp: "2026-10-29T09:59:00.000Z" });
  expect(corrected?.observation.reviewer_details).toMatchObject({ action: "revision" });
  expect(corrected?.execution.attempt_label).not.toBe(initial?.execution.attempt_label);
}));
