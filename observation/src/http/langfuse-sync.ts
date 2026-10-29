import type { Hono } from "hono";
import { z } from "zod";
import type { CanonicalDigest } from "../domain/identity";
import type { EvidenceSet } from "../grading/evidence";
import type { EvaluationExecution } from "../grading/execution";
import type { QuestionDefinition } from "../grading/question";
import { LangfuseBackend } from "../langfuse/backend";
import type { LangfuseConfiguration } from "../langfuse/config";
import { createLangfuseHttpClient } from "../langfuse/http-client";
import type { ProjectionInput } from "../ports/evaluation-backend";
import { withTenant } from "../storage/database";
import type { SourceDependencies } from "./sources";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";

export interface LangfuseRouteDependencies extends SourceDependencies {
  readonly langfuse?: LangfuseConfiguration;
}
const digestSchema = z.string().regex(/^canonical-json\/v1:[0-9a-f]{64}$/);
const projectionSchema = z.object({ execution_id: z.string().min(1), question_text: z.string().min(1),
  projection_version: z.string().min(1) });
const reconcileSchema = z.object({ mapping_key: digestSchema });
const RESTRICTED_POLICY: ProjectionInput["policy"] = { body_sensitivity: {
  analysis: "restricted", plan: "restricted", brief: "restricted", assessment: "restricted",
}, allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false };

async function projectionInput(deps: SourceDependencies, tenant: { producer: string; namespace: string },
  request: z.infer<typeof projectionSchema>): Promise<ProjectionInput | null> {
  return withTenant(deps.db, tenant, async (trx) => {
    const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", request.execution_id).executeTakeFirst();
    if (!execution) return null;
    const evidence = await trx.selectFrom("observation.evidence_set").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("evidence_set_id", "=", execution.evidence_set_id).executeTakeFirst();
    const question = await trx.selectFrom("observation.question_definition").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("question_id", "=", execution.question_id).where("question_version", "=", execution.question_version)
      .executeTakeFirst();
    const occurrence = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", execution.subject_occurrence_id).executeTakeFirst();
    const revision = occurrence ? await trx.selectFrom("observation.source_revision").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", occurrence.revision_id).executeTakeFirst() : null;
    if (!evidence || !question || !occurrence || !revision) return null;
    return { execution: execution as unknown as EvaluationExecution,
      evidence: { evidence_set_id: evidence.evidence_set_id,
        references: evidence.evidence_refs as unknown as EvidenceSet["references"],
        is_incomplete: evidence.is_incomplete, incompleteness_reason: evidence.incompleteness_reason } as EvidenceSet,
      question: { ...question, question_id: question.question_id as QuestionDefinition["question_id"],
        target_item_kinds: question.target_item_kinds as string[],
        input_recipe: question.input_recipe as QuestionDefinition["input_recipe"],
        response_kind: question.response_kind as QuestionDefinition["response_kind"],
        allowed_values: question.allowed_values as QuestionDefinition["allowed_values"],
        missing_evidence_policy: question.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"] },
      question_text: request.question_text,
      source: { producer: tenant.producer, namespace: tenant.namespace,
        run_id: occurrence.run_id as ProjectionInput["source"]["run_id"],
        unit_id: revision.unit_id as ProjectionInput["source"]["unit_id"],
        artifact_kind: revision.artifact_kind,
        revision_id: revision.revision_id as ProjectionInput["source"]["revision_id"],
        revision_digest: revision.body_digest as ProjectionInput["source"]["revision_digest"],
        logical_item_id: occurrence.logical_item_id as ProjectionInput["source"]["logical_item_id"],
        extractor_version: occurrence.extractor_version },
      policy: RESTRICTED_POLICY, projection_version: request.projection_version };
  });
}

export function registerLangfuseRoutes(app: Hono, deps: LangfuseRouteDependencies): void {
  const configuration = deps.langfuse ?? { status: "disabled" as const };
  app.get("/v1/langfuse/status", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    if (configuration.status === "disabled") return c.json({ status: "disabled" });
    const rows = await withTenant(deps.db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
      .select(["mapping_key", "sync_state", "attempt_id", "updated_at"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .orderBy("updated_at", "desc").limit(100).execute());
    return c.json({ status: "enabled", mappings: rows });
  });
  app.post("/v1/langfuse/projections", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!tenant) return errorResponse(c, 403, "forbidden", "grade credential required");
    if (configuration.status === "disabled") return c.json({ status: "disabled" });
    const parsed = projectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, "invalid_projection", "execution_id, question_text and projection_version required");
    const input = await projectionInput(deps, tenant, parsed.data);
    if (!input) return errorResponse(c, 404, "not_found", "projection inputs were not found in this tenant");
    const backend = new LangfuseBackend(deps.db, tenant, configuration.config,
      createLangfuseHttpClient(configuration.config));
    const result = await backend.project(input);
    return result.ok ? c.json({ status: "pending", external_ids: result.value }, 202)
      : errorResponse(c, 422, "langfuse_projection_pending", result.error.detail);
  });
  app.post("/v1/langfuse/reconcile", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!tenant) return errorResponse(c, 403, "forbidden", "grade credential required");
    if (configuration.status === "disabled") return c.json({ status: "disabled" });
    const parsed = reconcileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, "invalid_reconcile", "mapping_key required");
    const key = parsed.data.mapping_key as CanonicalDigest;
    const row = await withTenant(deps.db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("mapping_key", "=", key).executeTakeFirst());
    if (!row) return errorResponse(c, 404, "not_found", "mapping not found");
    const backend = new LangfuseBackend(deps.db, tenant, configuration.config,
      createLangfuseHttpClient(configuration.config));
    const result = await backend.reconcile({ mapping_key: key,
      occurrence_id: row.occurrence_id as ProjectionInput["execution"]["subject_occurrence_id"],
      question_id: row.question_id as ProjectionInput["question"]["question_id"],
      question_version: row.question_version, external_ids: null });
    return result.ok ? c.json(result.value) : errorResponse(c, 422, "langfuse_reconcile_failed", result.error.detail);
  });
}
