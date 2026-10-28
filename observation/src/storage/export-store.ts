import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { canonicalDigest } from "../canonical/canonical-json";
import type { ArtifactRevisionId, CanonicalDigest, EvidenceSetId, GradeObservationId, ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import { makeManifest, type ExportManifest, type ExportMembership, type ExportRecord,
  type RedactionPolicy } from "../export/manifest";
import { redactRecord } from "../export/redaction";
import { withTenant, type Database, type TenantScope } from "./database";
import type { ObservationItemOccurrence, ObservationSourceRevision, ObservationGradeObservation,
  ObservationEvidenceSet, ObservationEvaluationExecution, ObservationEvaluatorDefinition,
  ObservationQuestionDefinition } from "./db-types";

export interface ExportSelection { readonly run_id: string | null; readonly occurrence_ids: readonly string[] | null }
export interface PreparedExport { readonly manifest: ExportManifest; readonly records: readonly ExportRecord[] }
export interface ExportRows {
  readonly occurrences: readonly Selectable<ObservationItemOccurrence>[];
  readonly revisions: readonly Selectable<ObservationSourceRevision>[];
  readonly grades: readonly Selectable<ObservationGradeObservation>[];
  readonly evidences: readonly Selectable<ObservationEvidenceSet>[];
  readonly executions: readonly Selectable<ObservationEvaluationExecution>[];
  readonly evaluators: readonly Selectable<ObservationEvaluatorDefinition>[];
  readonly questions: readonly Selectable<ObservationQuestionDefinition>[];
}
const json = (value: unknown) => sql<JsonValue>`${JSON.stringify(value)}::jsonb`;

function requiredDigest(value: unknown): CanonicalDigest {
  const digest = canonicalDigest(value);
  if (!digest.ok) throw new Error(digest.error.detail);
  return digest.value;
}
function hasUnresolvedEvidence(evidence_refs: JsonValue): boolean {
  return Array.isArray(evidence_refs) && evidence_refs.some((reference) =>
    reference !== null && typeof reference === "object" && !Array.isArray(reference)
      && "content" in reference && reference.content === null);
}

/** Read every candidate in one tenant and pin every identity before writing files. */
export function prepareExport(db: Database, tenant: TenantScope, selection: ExportSelection,
  policy: RedactionPolicy): Promise<PreparedExport> {
  return db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(trx);
    await sql`SELECT set_config('observation.producer', ${tenant.producer}, true),
      set_config('observation.namespace', ${tenant.namespace}, true)`.execute(trx);
    const [occurrences, revisions, grades, evidences, executions, evaluators, questions] = await Promise.all([
      trx.selectFrom("observation.item_occurrence").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).orderBy("occurrence_id").execute(),
      trx.selectFrom("observation.source_revision").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).execute(),
      trx.selectFrom("observation.grade_observation").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).orderBy("observation_id").execute(),
      trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).execute(),
      trx.selectFrom("observation.evaluation_execution").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).execute(),
      trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).execute(),
      trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).execute(),
    ]);
    return prepareRows({ occurrences, revisions, grades, evidences, executions, evaluators, questions }, tenant, selection, policy);
  });
}

/** Pure snapshot transform, also used to verify an export without a live database. */
export function prepareRows(rows: ExportRows, tenant: TenantScope, selection: ExportSelection,
  policy: RedactionPolicy, identity: { readonly manifest_id: string; readonly frozen_at: string } = {
    manifest_id: randomUUID(), frozen_at: new Date().toISOString(),
  }): PreparedExport {
    const { occurrences, revisions, grades, evidences, executions, evaluators, questions } = rows;
    const revisionById = new Map(revisions.map((row) => [row.revision_id, row]));
    const evidenceById = new Map(evidences.map((row) => [row.evidence_set_id, row]));
    const executionById = new Map(executions.map((row) => [row.execution_id, row]));
    const evaluatorById = new Map(evaluators.map((row) => [row.evaluator_definition_id, row]));
    const questionById = new Map(questions.map((row) => [`${row.question_id}:${row.question_version}`, row]));
    const gradesByOccurrence = Map.groupBy(grades, (row) => row.subject_occurrence_id);
    const membership: ExportMembership[] = [];
    const records: ExportRecord[] = [];
    for (const occurrence of occurrences) {
      const revision = revisionById.get(occurrence.revision_id);
      if (!revision) throw new Error(`missing revision ${occurrence.revision_id}`);
      for (const grade of gradesByOccurrence.get(occurrence.occurrence_id) ?? [null]) {
        const candidate_id = requiredDigest([occurrence.occurrence_id, grade?.observation_id ?? null]);
        const evidence = grade ? evidenceById.get(grade.evidence_set_id) : null;
        if (grade && !evidence) throw new Error(`missing evidence ${grade.evidence_set_id}`);
        const evidence_set_digest = evidence ? requiredDigest({ evidence_refs: evidence.evidence_refs,
          is_incomplete: evidence.is_incomplete, incompleteness_reason: evidence.incompleteness_reason }) : null;
        const reason = selection.run_id !== null && selection.run_id !== occurrence.run_id ? "run_id_mismatch"
          : selection.occurrence_ids !== null && !selection.occurrence_ids.includes(occurrence.occurrence_id) ? "occurrence_not_selected"
            : !grade ? "no_grade_observation" : evidence?.is_incomplete ? "incomplete_evidence_set"
              : evidence && hasUnresolvedEvidence(evidence.evidence_refs) ? "unresolved_evidence_content"
              : grade.answer_state !== "answered" ? `answer_${grade.answer_state}` : "selected_complete_grade";
        let redaction_reasons: ExportMembership["redaction_reasons"] = [];
        if (reason === "selected_complete_grade" && grade && evidence) {
          const execution = executionById.get(grade.execution_id);
          const evaluator = evaluatorById.get(grade.evaluator_definition_id);
          const question = questionById.get(`${grade.question_id}:${grade.question_version}`);
          if (!execution || !evaluator || !question) throw new Error(`missing grade context ${grade.observation_id}`);
          const source_revision = { producer: revision.producer, namespace: revision.namespace,
            revision_id: revision.revision_id, run_id: revision.run_id, unit_id: revision.unit_id,
            artifact_kind: revision.artifact_kind, artifact_schema_version: revision.artifact_schema_version,
            definition_bundle_id: revision.definition_bundle_id, definition_bundle_digest: revision.definition_bundle_digest,
            body: revision.body, body_digest: revision.body_digest, recorded_at: revision.recorded_at };
          const record: ExportRecord = { candidate_id, source_revision, occurrence,
            evidence_set: evidence, observation: grade, execution, evaluator, question };
          const redacted = redactRecord(record, policy);
          records.push(redacted.record);
          redaction_reasons = redacted.reasons;
        }
        membership.push({ candidate_id, occurrence_id: occurrence.occurrence_id as ItemOccurrenceId,
          revision_id: occurrence.revision_id as ArtifactRevisionId, revision_digest: revision.body_digest as CanonicalDigest,
          evidence_set_id: grade?.evidence_set_id as EvidenceSetId | undefined ?? null,
          evidence_set_digest, observation_id: grade?.observation_id as GradeObservationId | undefined ?? null,
          disposition: reason === "selected_complete_grade" ? "included" : "excluded", reason, redaction_reasons });
      }
    }
    membership.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
    records.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
    const manifest = makeManifest({ producer: tenant.producer, namespace: tenant.namespace, manifest_id: identity.manifest_id,
      frozen_at: identity.frozen_at, format_version: "assay-jsonl/v1", redaction_policy: policy,
      file_hashes: { "candidates.jsonl": "" }, membership });
    if (!manifest.ok) throw new Error(manifest.error.detail);
    return { manifest: manifest.value, records };
}

/** Freeze header and members atomically; the database disallows later mutation. */
export function freezeExport(db: Database, tenant: TenantScope, manifest: ExportManifest): Promise<void> {
  if (manifest.producer !== tenant.producer || manifest.namespace !== tenant.namespace) throw new Error("export tenant mismatch");
  return withTenant(db, tenant, async (trx) => {
    await trx.insertInto("observation.export_manifest").values({ producer: tenant.producer, namespace: tenant.namespace,
      manifest_id: manifest.manifest_id, frozen_at: new Date(manifest.frozen_at), membership_digest: manifest.membership_digest,
      format_version: manifest.format_version, redaction_policy: json(manifest.redaction_policy),
      file_hashes: json(manifest.file_hashes) }).execute();
    if (manifest.membership.length) await trx.insertInto("observation.export_membership").values(manifest.membership.map((member) => ({
      producer: tenant.producer, namespace: tenant.namespace, manifest_id: manifest.manifest_id,
      candidate_id: member.candidate_id, occurrence_id: member.occurrence_id, revision_id: member.revision_id,
      revision_digest: member.revision_digest, evidence_set_id: member.evidence_set_id,
      evidence_set_digest: member.evidence_set_digest, observation_id: member.observation_id,
      disposition: member.disposition, reason: member.reason,
      redaction_reasons: json(member.redaction_reasons),
    }))).execute();
  });
}
