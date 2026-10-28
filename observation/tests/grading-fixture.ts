import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { ItemOccurrenceId, QuestionId, EvidenceSetId } from "../src/domain/identity";
import type { QuestionDefinition } from "../src/grading/question";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvaluatorDefinition } from "../src/grading/evaluator";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
export const tenant = { producer: "oakridge", namespace: "grading-test" };
export const question: QuestionDefinition = {
  question_id: "relevance" as QuestionId, question_version: "1", target_item_kinds: ["cohort_criterion"],
  input_recipe: { source: "selected_value" }, response_kind: "boolean", allowed_values: null,
  missing_evidence_policy: "fail", abstain_semantics: "not enough evidence", unclear_semantics: "ambiguous",
  interpretation_caveats: "relevance is not acceptance", requires_repository_snapshot: false,
};
export const evidence: EvidenceSet = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ ref: "fixture", content: "sample", digest: null }], is_incomplete: false, incompleteness_reason: null };
export function evaluator(kind: "code" | "model" | "human"): EvaluatorDefinition {
  return { evaluator_definition_id: kind, kind, backend_kind: "local", provider: `fixture-${kind}`,
    model: kind === "model" ? "pinned" : null, prompt_digest: "prompt-1", config_digest: "config-1",
    runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null };
}
export async function scratchGrading(work: (db: Database, occurrence_id: ItemOccurrenceId) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_grading_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try {
      await migrateEmptyDatabase(db);
      const id = canonicalDigest(["grading-fixture"]);
      if (!id.ok) throw new Error(id.error.detail);
      const occurrence_id = id.value as unknown as ItemOccurrenceId;
      await withTenant(db, tenant, async (trx) => {
        await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
          artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
          VALUES (${tenant.producer}, ${tenant.namespace}, 'rev-1', 'run-1', 'unit-1', 'brief', '1', 'bundle', 'digest',
          '{}'::jsonb, ${id.value}, now())`.execute(trx);
        await sql`INSERT INTO observation.extractor_definition (producer, namespace, artifact_kind, schema_version,
          extractor_id, extractor_version, item_kind, item_selector) VALUES
          (${tenant.producer}, ${tenant.namespace}, 'brief', '1', 'fixture', '1', 'cohort_criterion', '/criterion')`.execute(trx);
        await sql`INSERT INTO observation.item_occurrence (producer, namespace, occurrence_id, revision_id, run_id,
          artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
          VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, 'rev-1', 'run-1', 'brief', '1',
          'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-1', '{}'::jsonb)`.execute(trx);
      });
      await work(db, occurrence_id);
    } finally { await db.destroy(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
  } finally { await admin.end(); }
}
