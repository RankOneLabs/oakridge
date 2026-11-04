import { expect, test } from "bun:test";
import { deriveCriterionComposite, type CompositeItem, type CompositeInput, type CompositeJudgment, type CriterionComposite } from "../src/grading/decision-policy";
import type { ItemOccurrenceId, QuestionId, GradeObservationId } from "../src/domain/identity";
import { scratchGrading, tenant, captureProjectedFixture, question, evidence, evaluator, humanGradeDetails } from "./grading-fixture";
import { createApp } from "../src/http/app";
import { registerGradingContext, recordHumanGrade } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";

const item = (id: string, kind = "assessment_finding", stage = "implementation/a"): CompositeItem => ({ occurrence_id: id as ItemOccurrenceId,
  item_kind: kind, stage, revision_id: `rev-${id}`, artifact_kind: kind === "criterion" ? "brief" : "assessment",
  logical_item_id: null, definition_id: "d", artifact_schema_version: "1", recorded_at: "2026-11-01T00:00:00Z" });
const criterion = item("criterion", "criterion");
const first = item("first"), second = item("second", "assessment_finding", "implementation/b"), lookalike = item("lookalike");
const link = (source: string, target = "criterion", type = "assesses") => ({ relation_id: `${source}->${target}`,
  source_occurrence_id: source, target_occurrence_id: target, source_logical_item_id: null, target_logical_item_id: null,
  type, asserted_by: "producer_explicit" });
const judgment = (id: string, subject: string, value: boolean, grader = "human"): CompositeJudgment => ({ observation_id: id as GradeObservationId,
  subject_occurrence_id: subject as ItemOccurrenceId, execution_id: `x-${id}`, evidence_set_id: "e", question_id: "finding.question" as QuestionId,
  question_version: "v1", evaluator_definition_id: grader,
  evaluator: { kind: "human", provider: "local", model: null, config_digest: "c", runtime_revision: "v1" },
  answer: { state: "answered", kind: "boolean", value }, supersedes_observation_id: null, recorded_at: "2026-11-01T01:00:00Z" });
const base: CompositeInput = { criterion, run_id: "run", as_of: "2026-11-02T00:00:00Z",
  items: [criterion, first, second, lookalike], relations: [link("first"), link("second")], judgments: [], support: [] };

test("membership spans stages, follows criterion lineage and excludes co-residence and inferred links", () => {
  const plan = { ...item("plan", "criterion", "plan"), artifact_kind: "plan" };
  const composite = deriveCriterionComposite({ ...base, items: [...base.items, plan], relations: [link("criterion", "plan", "derived_from"),
    link("first", "plan"), link("second"), { ...link("lookalike"), asserted_by: "inferred" }] });
  expect(composite.constituents.map((row) => row.item.occurrence_id)).toEqual([first.occurrence_id, second.occurrence_id]);
});
test("an empty criterion returns a gap and no invented scalar", () => {
  const composite = deriveCriterionComposite({ ...base, relations: [] });
  expect(composite.result).toEqual({ state: "incomplete", judgment_counts: [], coverage: { measured: 0, expected: 0 }, has_disagreement: false });
  expect(composite.gaps.map((row) => row.kind)).toEqual(["no_constituents"]);
});
test("corrections and retries select once; replay is deterministic and evaluator disagreement stays visible", () => {
  const original = judgment("a", "first", true);
  const correction = { ...judgment("b", "first", false), supersedes_observation_id: original.observation_id };
  const other = judgment("c", "first", true, "model");
  const input = { ...base, judgments: [original, correction, correction, other] };
  const result = deriveCriterionComposite(input);
  expect(result.constituents[0]?.judgments.map((row) => row.observation_id)).toEqual([correction.observation_id, other.observation_id]);
  expect(result.result).toMatchObject({ coverage: { measured: 1, expected: 2 }, has_disagreement: true });
  expect(deriveCriterionComposite({ ...input, judgments: [...input.judgments].reverse() })).toEqual(result);
});
test("revision selection is per explicit logical item and stage; path-only items remain distinct", () => {
  const old = { ...first, logical_item_id: "logical" };
  const next = { ...first, occurrence_id: "new" as ItemOccurrenceId, revision_id: "new-rev", logical_item_id: "logical", recorded_at: "2026-11-02T00:00:00Z" };
  expect(deriveCriterionComposite({ ...base, items: [criterion, old, next, second], relations: [link("first"), link("new"), link("second")] })
    .constituents.map((row) => row.item.occurrence_id)).toEqual([next.occurrence_id, second.occurrence_id]);
});
test("missing, unsupported, pending, failed, and unready parts retain their individual gaps", () => {
  const row = { subject_occurrence_id: first.occurrence_id, question_id: "q" as QuestionId, question_version: "v1",
    provenance: { definition_id: "d", artifact_schema_version: "1" }, support: { state: "supported" as const },
    readiness: { state: "unready" as const, reason: "pinned evidence missing" } };
  const result = deriveCriterionComposite({ ...base, support: [
    { ...row, execution: { state: "pending", job_id: "job", execution_id: null } },
    { ...row, question_id: "q2" as QuestionId, execution: { state: "failed", job_id: "failed", execution_id: "x" } },
  ] });
  expect(new Set(result.gaps.map((row) => row.kind))).toEqual(new Set(["unmeasured", "unsupported", "unready", "pending", "failed"]));
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("composite HTTP read recomputes corrections without writing a job or observation, with tenant and as-of scope", () => scratchGrading(async (db) => {
  const brief = await captureProjectedFixture(db, { revision_id: "composite-brief", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "criterion", text: "Works", task_ids: [], decision_ids: [] }],
  } });
  const findings = await captureProjectedFixture(db, { revision_id: "composite-assessment", artifact_kind: "assessment",
    body: { head_sha: "commit", findings: [0, 1].map(() => ({ criterion_id: "criterion", evidence: [] })) }, recorded_at: "2026-11-01T01:00:00Z" });
  const subjects = findings.filter((row) => row.item_kind === "assessment_finding");
  const pinned = { ...question, question_id: "finding.question" as QuestionId, target_item_kinds: ["assessment_finding"], input_recipe: {
    judge: { rubric: "Is the finding supported?", evidence_refs: subjects.map((row) => `oakridge://revision/composite-assessment#${row.json_pointer}`),
      max_evidence_chars: 1000, target: "report" },
  } };
  expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const record = (subject: string, label: string, value: boolean, supersedes: GradeObservationId | null = null) => recordHumanGrade(db, tenant, {
    subject_occurrence_id: subject as ItemOccurrenceId, evidence_set_id: evidence.evidence_set_id, question_id: pinned.question_id,
    question_version: pinned.question_version, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: label,
    details: { ...humanGradeDetails("human_rubric_answer"), answer: { state: "answered", kind: "boolean", value }, supersedes_observation_id: supersedes },
  });
  const original = await record(subjects[0]!.occurrence_id, "first", true);
  expect(original.ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }, { ...tenant, namespace: "other", token: "other" }] } });
  const path = `/v1/items/${encodeURIComponent(brief.find((row) => row.item_kind === "criterion")!.occurrence_id)}/criterion-composite/v1`;
  const read = async () => await (await app.request(path, { headers: { authorization: "Bearer read" } })).json() as CriterionComposite;
  const before = await read();
  expect(before.result.coverage).toEqual({ measured: 1, expected: 2 });
  expect(before.constituents.every((row) => row.item.item_kind === "assessment_finding")).toBe(true);
  expect((await app.request(path, { headers: { authorization: "Bearer ingest" } })).status).toBe(403);
  expect((await app.request(path, { headers: { authorization: "Bearer other" } })).status).toBe(404);
  expect((await app.request(`${path}?as_of=2020-01-01T00:00:00Z`, { headers: { authorization: "Bearer read" } })).status).toBe(404);
  const oldId = original.ok ? original.value.observation!.observation_id as GradeObservationId : null;
  const correction = await record(subjects[0]!.occurrence_id, "corrected", false, oldId);
  expect(correction.ok).toBe(true);
  const corrected = await read();
  expect(corrected.constituents.flatMap((row) => row.judgments).map((row) => row.answer)).toEqual([{ state: "answered", kind: "boolean", value: false }]);
  const snapshot = await app.request(`${path}?as_of=${encodeURIComponent(before.as_of)}`, { headers: { authorization: "Bearer read" } });
  expect((await snapshot.json() as CriterionComposite).constituents.flatMap((row) => row.judgments).map((row) => row.observation_id)).toEqual([oldId!]);
  expect((await record(subjects[1]!.occurrence_id, "second-finding", true)).ok).toBe(true);
  for (const subject of subjects) {
    const response = await app.request(`/v1/items/${encodeURIComponent(subject.occurrence_id)}/grades`, { headers: { authorization: "Bearer read" } });
    const body = await response.json() as { items: { observation: { subject_occurrence_id: string }; criterion_references: { occurrence_id: string }[] }[] };
    expect(body.items.every((row) => row.observation.subject_occurrence_id === subject.occurrence_id
      && row.criterion_references[0]?.occurrence_id === before.criterion.occurrence_id)).toBe(true);
  }
  const counts = await withTenant(db, tenant, async (trx) => ({ grades: await trx.selectFrom("observation.grade_observation").selectAll().execute(),
    jobs: await trx.selectFrom("observation.grading_job").selectAll().execute() }));
  expect({ grades: counts.grades.length, jobs: counts.jobs.length }).toEqual({ grades: 3, jobs: 0 });
}));

test("conflicting judgments on different constituents remain marked without a scalar", () => {
  const composite = deriveCriterionComposite({ ...base, judgments: [judgment("positive", "first", true), judgment("negative", "second", false)] });
  expect(composite.result.has_disagreement).toBe(true);
  expect(composite.constituents.every((row) => row.has_disagreement)).toBe(true);
  expect(composite.result.judgment_counts.map((row) => row.count)).toEqual([1, 1]);
});
