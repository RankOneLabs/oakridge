import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { err, ok, type Result } from "../domain/primitives";
import { withTenant, type Database, type TenantScope } from "../storage/database";

export interface PurgeRequest {
  readonly tenant: TenantScope;
  readonly run_id: string;
  readonly trigger_event_id: string;
  readonly trigger_run_key: string;
  readonly operator_override: boolean;
}
export interface PurgeCounts {
  readonly source_revisions_removed: number;
  readonly item_occurrences_removed: number;
  readonly item_relations_removed: number;
  readonly extraction_issues_removed: number;
  readonly evaluation_executions_removed: number;
  readonly grade_observations_removed: number;
}
export interface PurgeRecord extends PurgeCounts {
  readonly purge_id: string;
  readonly run_id: string;
  readonly trigger_event_id: string;
  readonly trigger_run_key: string;
  readonly operator_override: boolean;
  readonly frozen_manifest_ids: readonly string[];
}
export interface PurgeError { readonly operation: "purge_run"; readonly entity_id: string;
  readonly detail: string; readonly code: "frozen_export" | "storage_failure" }
export interface PurgeHooks { readonly beforeAudit?: () => Promise<void> }
const failure = (request: PurgeRequest, code: PurgeError["code"], detail: string): Result<never, PurgeError> =>
  err({ operation: "purge_run", entity_id: request.run_id, code, detail });

/** The only deletion entry point. The frozen check and audit share the deletion transaction. */
export async function purgeRun(db: Database, request: PurgeRequest, hooks: PurgeHooks = {}): Promise<Result<PurgeRecord, PurgeError>> {
  const { tenant, run_id, trigger_event_id, trigger_run_key, operator_override } = request;
  if (!run_id || trigger_run_key !== run_id || !trigger_event_id)
    return failure(request, "storage_failure", "invalid purge identity");
  try {
    return await withTenant(db, tenant, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant.producer}:${tenant.namespace}:purge:${run_id}`}, 0))`.execute(trx);
      const prior = await trx.selectFrom("observation.purge_event").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("trigger_event_id", "=", trigger_event_id).executeTakeFirst();
      if (prior) return ok({ ...prior, frozen_manifest_ids: prior.frozen_manifest_ids as unknown as string[] });
      const frozen = await sql<{ manifest_id: string }>`SELECT DISTINCT m.manifest_id
        FROM observation.export_membership m
        JOIN observation.item_occurrence i ON i.producer = m.producer AND i.namespace = m.namespace
          AND i.occurrence_id = m.occurrence_id
        WHERE m.producer = ${tenant.producer} AND m.namespace = ${tenant.namespace} AND i.run_id = ${run_id}
        ORDER BY m.manifest_id`.execute(trx);
      const frozen_manifest_ids = frozen.rows.map((row) => row.manifest_id);
      if (frozen_manifest_ids.length && !operator_override)
        return failure(request, "frozen_export", `run appears in frozen manifest(s): ${frozen_manifest_ids.join(", ")}`);
      await sql`SELECT set_config('observation.purge_run', ${run_id}, true)`.execute(trx);
      await sql`SELECT set_config('observation.purge_override', ${operator_override ? "true" : "false"}, true)`.execute(trx);
      await sql`DELETE FROM observation.grading_job
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      await sql`UPDATE observation.blind_assignment a SET submitted_observation_id = NULL
        FROM observation.item_occurrence i
        WHERE a.producer = ${tenant.producer} AND a.namespace = ${tenant.namespace}
          AND i.producer = a.producer AND i.namespace = a.namespace
          AND i.occurrence_id = a.subject_occurrence_id AND i.run_id = ${run_id}`.execute(trx);
      const grades = await sql`DELETE FROM observation.grade_observation g
        USING observation.item_occurrence i
        WHERE g.producer = ${tenant.producer} AND g.namespace = ${tenant.namespace}
          AND i.producer = g.producer AND i.namespace = g.namespace
          AND i.occurrence_id = g.subject_occurrence_id AND i.run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.blind_assignment a
        USING observation.item_occurrence i
        WHERE a.producer = ${tenant.producer} AND a.namespace = ${tenant.namespace}
          AND i.producer = a.producer AND i.namespace = a.namespace
          AND i.occurrence_id = a.subject_occurrence_id AND i.run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.evaluation_eligibility e
        USING observation.item_occurrence i
        WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace}
          AND i.producer = e.producer AND i.namespace = e.namespace
          AND i.occurrence_id = e.subject_occurrence_id AND i.run_id = ${run_id}`.execute(trx);
      const executions = await sql`DELETE FROM observation.evaluation_execution x
        USING observation.item_occurrence i
        WHERE x.producer = ${tenant.producer} AND x.namespace = ${tenant.namespace}
          AND i.producer = x.producer AND i.namespace = x.namespace
          AND i.occurrence_id = x.subject_occurrence_id AND i.run_id = ${run_id}`.execute(trx);
      const relations = await sql`DELETE FROM observation.item_relation r
        WHERE r.producer = ${tenant.producer} AND r.namespace = ${tenant.namespace}
          AND (EXISTS (SELECT 1 FROM observation.item_occurrence i WHERE i.producer = r.producer
            AND i.namespace = r.namespace AND i.run_id = ${run_id}
            AND i.occurrence_id IN (r.source_occurrence_id, r.target_occurrence_id))
          OR EXISTS (SELECT 1 FROM observation.logical_item l WHERE l.producer = r.producer
            AND l.namespace = r.namespace AND l.run_id = ${run_id}
            AND l.logical_item_id IN (r.source_logical_item_id, r.target_logical_item_id)))`.execute(trx);
      const issues = await sql`DELETE FROM observation.extraction_issue e
        USING observation.source_revision r
        WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace}
          AND r.producer = e.producer AND r.namespace = e.namespace
          AND r.revision_id = e.revision_id AND r.run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.source_collaboration_comment
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      const occurrences = await sql`DELETE FROM observation.item_occurrence
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.logical_item
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.ingest_receipt p USING observation.source_revision r
        WHERE p.producer = ${tenant.producer} AND p.namespace = ${tenant.namespace}
          AND r.producer = p.producer AND r.namespace = p.namespace
          AND r.revision_id = p.revision_id AND r.run_id = ${run_id}`.execute(trx);
      const revisions = await sql`DELETE FROM observation.source_revision
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.source_human_grade
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      await sql`DELETE FROM observation.source_event_outcome
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
      const counts: PurgeCounts = {
        source_revisions_removed: Number(revisions.numAffectedRows),
        item_occurrences_removed: Number(occurrences.numAffectedRows),
        item_relations_removed: Number(relations.numAffectedRows),
        extraction_issues_removed: Number(issues.numAffectedRows),
        evaluation_executions_removed: Number(executions.numAffectedRows),
        grade_observations_removed: Number(grades.numAffectedRows),
      };
      await hooks.beforeAudit?.();
      const record: PurgeRecord = { ...counts, purge_id: randomUUID(), run_id, trigger_event_id,
        trigger_run_key, operator_override, frozen_manifest_ids };
      await trx.insertInto("observation.purge_event").values({ producer: tenant.producer, namespace: tenant.namespace, ...record,
        frozen_manifest_ids: sql`${JSON.stringify(frozen_manifest_ids)}::jsonb` }).execute();
      return ok(record);
    });
  } catch (cause) { return failure(request, "storage_failure", String(cause)); }
}
