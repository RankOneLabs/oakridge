import type { GradeOrigin } from "../src/grading/observation";
import type { GradeDetails } from "../src/storage/grading-store";
import { captureDelivery } from "../src/storage/capture-store";
import { projectRevision, listRunItems } from "../src/storage/projection-store";
import type { JsonValue } from "../src/domain/primitives";
import { instructionDigest } from "../src/grading/evaluator";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId, QuestionId, EvidenceSetId } from "../src/domain/identity";
import type { QuestionDefinition } from "../src/grading/question";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvaluatorDefinition } from "../src/grading/evaluator";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";
const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
export const tenant = { producer: "oakridge", namespace: "grading-test" };
export const pinnedExpectation = { definition_id: "definition-1", artifact_schema_version: "1" };
export const pilotExpectations = {
  "analysis.finding_relevance": pinnedExpectation,
  "plan.criterion_traceability": pinnedExpectation,
  "brief.source_fidelity": pinnedExpectation,
  "assessment.coverage": pinnedExpectation,
};
export const question: QuestionDefinition = {
  pinned_expectation: pinnedExpectation,
  question_id: "relevance" as QuestionId, question_version: "1", target_item_kinds: ["cohort_criterion"],
  input_recipe: { source: "selected_value" }, response_kind: "boolean", allowed_values: null,
  missing_evidence_policy: "fail", abstain_semantics: "not enough evidence", unclear_semantics: "ambiguous",
  interpretation_caveats: "relevance is not acceptance", requires_repository_snapshot: false,
};
export const evidence: EvidenceSet = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ ref: "fixture", kind: "public", content: "sample", digest: null }], is_incomplete: false, incompleteness_reason: null };
export function evaluator(kind: "code" | "model" | "human"): EvaluatorDefinition {
  return { evaluator_definition_id: kind, kind, backend_kind: "local", provider: `fixture-${kind}`,
    model: kind === "model" ? "pinned" : null, instruction_text: "prompt-1", prompt_digest: instructionDigest("prompt-1"), config_digest: "config-1",
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
          artifact_kind, artifact_schema_version, definition_id, body, body_digest, recorded_at)
          VALUES (${tenant.producer}, ${tenant.namespace}, 'rev-1', 'run-1', 'unit-1', 'brief', '1', 'definition-1',
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
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

export interface CapturedFixtureRevision {
  readonly revision_id: string;
  readonly run_id?: string;
  readonly unit_id?: string;
  readonly artifact_kind: string;
  readonly body: JsonValue;
  readonly recorded_at?: string;
  readonly predecessor_id?: string;
}
/** Exercise the real capture and projection boundaries in database grading tests. */
export async function captureProjectedFixture(db: Database, input: CapturedFixtureRevision) {
  const run_id = input.run_id ?? "run-1";
  const digest = canonicalDigest(input.body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const captured = await captureDelivery(db, { local_revision_id: input.revision_id, request_key: input.revision_id,
    envelope: { format: "observation.artifact-revision/v2", source: { ...tenant, ...pinnedExpectation,
      revision_id: `${tenant.producer}:${tenant.namespace}:${input.revision_id}`, run_id, unit_id: input.unit_id ?? (input.artifact_kind === "assessment" ? "implementation/cohort" : input.artifact_kind),
      artifact_kind: input.artifact_kind, predecessor_id: input.predecessor_id ? `${tenant.producer}:${tenant.namespace}:${input.predecessor_id}` : null, subject_id: null },
      body: input.body, body_digest: digest.value, recorded_at: input.recorded_at ?? "2026-11-01T00:00:00Z" } });
  if (captured.status !== 201) throw new Error("fixture capture refused");
  await projectRevision(db, tenant, input.revision_id);
  const page = await listRunItems(db, tenant, run_id, { limit: 200, offset: 0 });
  return page.items.filter((item) => item.revision_id === input.revision_id);
}

/** Explicit facts supplied by a caller recording a human grade. */
export function humanGradeDetails(origin: GradeOrigin): GradeDetails {
  return { origin, answer: { state: "answered", kind: "boolean", value: true },
    collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false,
    probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
    decision_policy_version: null, reviewer_id: "reviewer", reviewer_details: null,
    comments: null, rationale: null, quality_flags: [], supersedes_observation_id: null };
}

/** A real captured subject for admission tests; callers send only question/evaluator context. */
export async function capturedFinding(db: Database) {
  const { deriveCapturedEvidence } = await import("../src/storage/captured-evidence-store");
  const items = await captureProjectedFixture(db, { revision_id: "captured-analysis", artifact_kind: "analysis", body: {
    findings: [{ id: "finding", description: "A bounded authored finding", severity: "info" }], requirements: [], spec_updates: [],
  } });
  const occurrence_id = items.find((item) => item.item_kind === "finding")!.occurrence_id as ItemOccurrenceId;
  const pinned: QuestionDefinition = { ...question, question_id: "fixture.finding_quality" as QuestionId, target_item_kinds: ["finding"],
    input_recipe: { judge: { rubric: "Is this finding supported?", target: "report", max_evidence_chars: 1000,
      evidence_refs: ["oakridge://revision/captured-analysis#/findings/0"] } } };
  const derived = await deriveCapturedEvidence(db, tenant, "run-1", { subject_occurrence_id: occurrence_id, question: pinned });
  if (!derived.ok || !derived.value.evidence) throw new Error("captured finding fixture has no evidence");
  return { occurrence_id, question: pinned, evidence: derived.value.evidence };
}
