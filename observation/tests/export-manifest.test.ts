import { createHash } from "node:crypto";
import { sql } from "kysely";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { jsonlExporter } from "../src/export/jsonl";
import { membershipDigest, type ExportManifest, type ExportRecord, type RedactionPolicy } from "../src/export/manifest";
import { prepareRows, type ExportRows } from "../src/storage/export-store";
import { createApp } from "../src/http/app";
import { recordHumanGrade, registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { tenant as gradingTenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const tenant = { producer: "oakridge", namespace: "export-test" };
const noRedaction: RedactionPolicy = { target_name: "assay", allow_raw_build_output: false, allow_raw_test_output: false,
  allow_repository_content: false };
const all = { run_id: null, occurrence_ids: null };
const id = (value: unknown): string => {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};
const body = { output: "PRIVATE BUILD", tests: { output: "PRIVATE TEST" }, repository_content: "PRIVATE SOURCE" };
const revisionDigest = id(body);
const occurrenceId = id(["fixture occurrence"]);

function rows(): ExportRows {
  return {
    revisions: [{ ...tenant, revision_id: "rev-1", artifact_kind: "build_result", body_digest: revisionDigest, body }],
    occurrences: [{ ...tenant, occurrence_id: occurrenceId, revision_id: "rev-1", run_id: "run-1",
      selected_value: { output: "PRIVATE BUILD", tests: { output: "PRIVATE TEST" }, repository_content: "PRIVATE SOURCE" } }],
    evidences: [{ ...tenant, evidence_set_id: "evidence-1", evidence_refs: [{ ref: "repo-snapshot", kind: "repository_content", content: "PRIVATE SOURCE" }],
      is_incomplete: false, incompleteness_reason: null }],
    grades: [{ ...tenant, observation_id: "grade-1", execution_id: "exec-1", subject_occurrence_id: occurrenceId,
      evidence_set_id: "evidence-1", question_id: "relevance", question_version: "1", evaluator_definition_id: "human",
      answer_state: "answered", answer_payload: { state: "answered", kind: "boolean", value: true } }],
    executions: [{ ...tenant, execution_id: "exec-1", question_id: "relevance", evaluator_definition_id: "human" }],
    evaluators: [{ ...tenant, evaluator_definition_id: "human", kind: "human", identity_digest: id("human") }],
    questions: [{ ...tenant, question_id: "relevance", question_version: "1", input_recipe: {}, response_kind: "boolean" }],
  } as unknown as ExportRows;
}
const identity = (manifest_id: string) => ({ manifest_id, frozen_at: "2026-01-01T00:00:00.000Z" });

test("identical inputs reproduce the digest; a later grade changes only a new manifest", () => {
  const input = rows();
  const frozen = prepareRows(input, tenant, all, noRedaction, identity("manifest-1"));
  const replay = prepareRows(input, tenant, all, noRedaction, identity("manifest-2"));
  expect(replay.manifest.membership_digest).toBe(frozen.manifest.membership_digest);
  const later = { ...input, grades: [...input.grades, { ...input.grades[0]!, observation_id: "grade-2", execution_id: "exec-2" }],
    executions: [...input.executions, { ...input.executions[0]!, execution_id: "exec-2" }] };
  const fresh = prepareRows(later, tenant, all, noRedaction, identity("manifest-3"));
  expect(frozen.manifest.membership.map((member) => String(member.observation_id))).toEqual(["grade-1"]);
  expect(frozen.manifest.membership_digest).toBe(replay.manifest.membership_digest);
  expect(fresh.manifest.manifest_id).not.toBe(frozen.manifest.manifest_id);
  expect(fresh.manifest.membership_digest).not.toBe(frozen.manifest.membership_digest);
});

test("standalone files verify their membership digest, file hash, and pinned references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observation-export-test-"));
  try {
    const prepared = prepareRows(rows(), tenant, all, noRedaction, identity("manifest-1"));
    const output = await jsonlExporter.export({ ...prepared, directory });
    const manifest = JSON.parse(await readFile(output.manifest_path, "utf8")) as ExportManifest;
    const data = await readFile(output.data_path, "utf8");
    for (const secret of ["PRIVATE BUILD", "PRIVATE TEST", "PRIVATE SOURCE"]) expect(data).not.toContain(secret);
    expect(new Set(manifest.membership[0]?.redaction_reasons.map((reason) => reason.reason)))
      .toEqual(new Set(["raw_build_output", "raw_test_output", "repository_content"]));
    const records = data.trim().split("\n").map((line) => JSON.parse(line) as ExportRecord);
    expect(membershipDigest(manifest.membership)).toEqual({ ok: true, value: manifest.membership_digest });
    expect(manifest.file_hashes["candidates.jsonl"]).toBe(`sha256:${createHash("sha256").update(data).digest("hex")}`);
    for (const member of manifest.membership.filter((candidate) => candidate.disposition === "included")) {
      const record = records.find((entry) => entry.candidate_id === member.candidate_id);
      if (!record) throw new Error(`missing exported record ${member.candidate_id}`);
      expect([record.occurrence.occurrence_id, record.source_revision.revision_id,
        record.evidence_set.evidence_set_id, record.observation.observation_id])
        .toEqual([String(member.occurrence_id), String(member.revision_id),
          String(member.evidence_set_id), String(member.observation_id)]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a selection matching nothing records every considered candidate and its exclusion", () => {
  const prepared = prepareRows(rows(), tenant, { run_id: "no-such-run", occurrence_ids: null }, noRedaction, identity("empty"));
  expect(prepared.records).toHaveLength(0);
  expect(prepared.manifest.membership.map((member) => [member.disposition, member.reason]))
    .toEqual([["excluded", "run_id_mismatch"]]);
});

test("an unresolved evidence reference excludes the candidate from offline data", () => {
  const input = rows();
  const unresolved = { ...input, evidences: [{ ...input.evidences[0]!, evidence_refs: [{ ref: "external-only", content: null, digest: "sha256:abc" }] }] };
  const prepared = prepareRows(unresolved, tenant, all, noRedaction, identity("unresolved"));
  expect(prepared.records).toHaveLength(0);
  expect(prepared.manifest.membership[0]?.reason).toBe("unresolved_evidence_content");
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;
integration("the assay route freezes files and membership when another grade is appended", async () => {
  const root = await mkdtemp(join(tmpdir(), "observation-route-export-"));
  try {
    await scratchGrading(async (db, occurrence_id) => {
      const registered = await registerGradingContext(db, gradingTenant, { question, evidence, evaluator: evaluator("human") });
      expect(registered.ok).toBe(true);
      const gradeInput = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
        question_id: question.question_id, question_version: question.question_version,
        evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "first",
        details: { answer: { state: "answered", kind: "boolean", value: true } as const,
          probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
          decision_policy_version: null, reviewer_id: "reviewer", reviewer_details: null, comments: null,
          rationale: null, quality_flags: [], supersedes_observation_id: null } };
      expect((await recordHumanGrade(db, gradingTenant, gradeInput)).ok).toBe(true);
      const app = createApp({ db, credentials: { ingest: [], read: [{ ...gradingTenant, token: "read-token" }] }, exportRoot: root });
      const request = () => app.request("/v1/exports/assay", { method: "POST", headers: {
        authorization: "Bearer read-token", "content-type": "application/json" }, body: "{}" });
      const firstResponse = await request();
      expect(firstResponse.status).toBe(201);
      const first = await firstResponse.json() as { manifest: ExportManifest; files: { data: string; manifest: string } };
      const frozenRows = await withTenant(db, gradingTenant, (trx) => trx.selectFrom("observation.export_membership")
        .selectAll().where("manifest_id", "=", first.manifest.manifest_id).execute());
      expect(frozenRows).toHaveLength(1);
      expect((await recordHumanGrade(db, gradingTenant, { ...gradeInput, attempt_label: "later" })).ok).toBe(true);
      const stillFrozen = await withTenant(db, gradingTenant, (trx) => trx.selectFrom("observation.export_membership")
        .selectAll().where("manifest_id", "=", first.manifest.manifest_id).execute());
      expect(stillFrozen).toEqual(frozenRows);
      await expect(withTenant(db, gradingTenant, (trx) => sql`INSERT INTO observation.export_membership
        (producer, namespace, manifest_id, candidate_id, occurrence_id, revision_id, revision_digest,
         disposition, reason, redaction_reasons)
        VALUES (${gradingTenant.producer}, ${gradingTenant.namespace}, ${first.manifest.manifest_id},
          ${id(["late candidate"])}, ${occurrence_id}, 'rev-1', ${id({})}, 'excluded', 'late', '[]'::jsonb)`.execute(trx)))
        .rejects.toThrow("new manifest");
      await expect(withTenant(db, gradingTenant, (trx) => sql`UPDATE observation.export_membership
        SET reason = 'rewritten' WHERE manifest_id = ${first.manifest.manifest_id}`.execute(trx)))
        .rejects.toThrow("immutable");
      const secondResponse = await request();
      expect(secondResponse.status).toBe(201);
      const second = await secondResponse.json() as { manifest: ExportManifest };
      expect(second.manifest.manifest_id).not.toBe(first.manifest.manifest_id);
      expect(second.manifest.membership_digest).not.toBe(first.manifest.membership_digest);
      const fileManifest = JSON.parse(await readFile(first.files.manifest, "utf8")) as ExportManifest;
      expect(fileManifest.membership_digest).toBe(first.manifest.membership_digest);
      expect(membershipDigest(fileManifest.membership)).toEqual({ ok: true, value: first.manifest.membership_digest });
      expect((await readFile(first.files.data, "utf8")).trim().split("\n")).toHaveLength(1);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

integration("raw allowances require the tenant's raw export credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "observation-raw-auth-"));
  try {
    await scratchGrading(async (db) => {
      const app = createApp({ db, exportRoot: root, credentials: { ingest: [],
        read: [{ ...gradingTenant, token: "read-token" }],
        export_raw: [{ ...gradingTenant, token: "raw-token" }] } });
      const body = JSON.stringify({ target: { name: "assay", redaction_policy: {
        allow_raw_build_output: true, allow_raw_test_output: false, allow_repository_content: false } } });
      const request = (token: string) => app.request("/v1/exports/assay", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
      expect((await request("read-token")).status).toBe(403);
      expect((await request("raw-token")).status).toBe(201);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
