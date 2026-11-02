import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import type { CapturedRevision } from "../src/grading/evidence-packages/capture";
import { capturedReference } from "../src/grading/evidence-packages/references";
import type { EvidenceKind } from "../src/grading/evidence";
import { runPackages } from "../src/producers/oakridge/evidence-packages";
import { persistOakridgeEligibility } from "../src/producers/oakridge/eligibility";
import { readEligibility } from "../src/storage/eligibility-store";
import { listGrades, registerGradingContext } from "../src/storage/grading-store";
import { readCoverage } from "../src/storage/coverage-store";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { buildGraph } from "./dependency-graph";
import { createApp } from "../src/http/app";
import { deriveSubjectGradeability } from "../src/producers/oakridge/gradeability";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { instructionDigest } from "../src/grading/evaluator";
import { runGradeDigest } from "../src/grading/execution";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { EvaluationJobResponse } from "../src/http/evaluations";

async function captured(kind: string, at: string): Promise<CapturedRevision> {
  const body = await Bun.file(new URL(`../fixtures/oakridge/run-slice/${kind}-revision.json`, import.meta.url)).json() as JsonValue;
  const revision_id = `${kind}-first`;
  const pass = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(kind, "1"));
  return { revision_id, unit_id: kind, collection_key: "cohort-a", artifact_kind: kind, recorded_at: new Date(at),
    items: pass.items.map(({ item }, index) => ({ ...item, occurrence_id: `${kind}-${index}` as ItemOccurrenceId, revision_id })) };
}

test("run-slice produces a dry-run manifest without Langfuse dependencies", async () => {
  await Bun.file(new URL("../fixtures/oakridge/run-slice/events.json", import.meta.url)).json();
  await Bun.file(new URL("../fixtures/oakridge/run-slice/operator-decisions.json", import.meta.url)).json();
  const plan = await captured("plan", "2026-10-23T17:23:49Z");
  expect(capturedReference("plan_criterion", plan.items[0]!, undefined as unknown as EvidenceKind).ok).toBe(false);
  const brief = await captured("brief", "2026-10-23T17:29:56Z");
  const assessment = await captured("assessment", "2026-10-23T17:35:00Z");
  const analysis: CapturedRevision = { ...assessment, revision_id: "analysis-first", artifact_kind: "analysis",
    items: assessment.items.filter((item) => item.item_kind === "assessment_finding")
      .map((item) => ({ ...item, item_kind: "finding" })) };
  const laterPlan: CapturedRevision = { ...plan, revision_id: "plan-later", recorded_at: new Date("2026-10-23T18:00:00Z"),
    items: plan.items.map((item) => ({ ...item, revision_id: "plan-later", selected_value: { changed: true } })) };
  const result = runPackages([analysis, plan, brief, assessment, laterPlan]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const manifest = result.value;
  const first = manifest.packages.find((item) => item.question_id === "plan.criterion_traceability" && item.revision_id === plan.revision_id);
  expect(first?.evidence.references.map((ref) => ref.ref.split(":")[0])).toEqual(["plan_criterion", "plan_decision"]);
  expect(first?.evidence.references.every((ref) => ref.digest?.startsWith("canonical-json/v1:")
    && ref.kind === "internal" && ref.content !== null && ref.deep_link?.startsWith("oakridge://revision/"))).toBe(true);
  const briefPackage = manifest.packages.find((item) => item.question_id === "brief.source_fidelity");
  const planSource = laterPlan.items.find((item) => item.item_kind === "criterion" && item.producer_local_id === briefPackage?.subject.producer_local_id);
  const firstDigest = canonicalDigest(planSource?.selected_value);
  expect(briefPackage?.evidence.references[0]?.digest).toBe(firstDigest.ok ? firstDigest.value : null);
  expect(manifest.selection_policy).toBe("live_all_revisions");
  const missingLink = runPackages([plan, { ...brief, items: brief.items.map((item) => item.item_kind === "criterion"
    ? { ...item, links: [] } : item) }]);
  expect(missingLink.ok && missingLink.value.exclusions.every((excluded) => excluded.reason.kind !== "dangling_citation")).toBe(true);
  expect(missingLink.ok && missingLink.value.exclusions.some((excluded) => excluded.reason.kind === "unlinked")).toBe(true);
  const coverage = manifest.packages.filter((pack) => pack.question_id === "assessment.coverage");
  expect(coverage).toEqual([]);
  expect(manifest.eligibility.filter((row) => row.question_id === "assessment.coverage")
    .every((row) => row.decision.tag === "invalid_reference"
      && row.decision.payload.kind === "dangling_citation")).toBe(true);
  const withoutAssessment = runPackages([plan, brief]);
  expect(withoutAssessment.ok && withoutAssessment.value.eligibility.filter((row) => row.question_id === "assessment.coverage")
    .every((row) => row.decision.tag === "missing_evidence" && row.decision.payload.kind === "unevidenced")).toBe(true);
  const laterAssessment: CapturedRevision = { ...assessment, revision_id: "assessment-later",
    recorded_at: new Date("2026-10-23T17:45:00Z"), items: assessment.items.map((item, index) => ({ ...item,
      revision_id: "assessment-later", occurrence_id: `assessment-later-${index}` as ItemOccurrenceId })) };
  const repeatedCoverage = runPackages([plan, brief, assessment, laterAssessment]);
  expect(repeatedCoverage.ok && repeatedCoverage.value.packages.filter((pack) => pack.question_id === "assessment.coverage").length).toBe(0);
  expect(repeatedCoverage.ok && repeatedCoverage.value.eligibility.filter((row) => row.question_id === "assessment.coverage").length).toBe(2);
  expect(manifest.eligibility.some((row) => row.question_id === "analysis.finding_relevance"
    && row.decision.tag === "missing_evidence")).toBe(true);
  const graph = buildGraph([resolve(import.meta.dir, "../src/producers/oakridge/evidence-packages.ts")]);
  expect([...graph.values()].filter((node) => node.path.includes("/src/langfuse/") || node.packages.some((name) => name.includes("langfuse")))).toEqual([]);
});

test("a concurrent cohort's brief does not close another brief's assessment window", async () => {
  const plan = await captured("plan", "2026-10-23T17:23:49Z");
  const briefA = await captured("brief", "2026-10-23T17:29:56Z");
  const assessmentA = await captured("assessment", "2026-10-23T17:40:00Z");
  // Brief B belongs to a second cohort: its own unit, its own criterion ids, captured between
  // brief A and A's assessment. Nothing of A's is assessed by B and vice versa.
  const briefB: CapturedRevision = { revision_id: "brief-b", unit_id: "briefs/other", collection_key: "cohort-b", artifact_kind: "brief",
    recorded_at: new Date("2026-10-23T17:32:00Z"),
    items: briefA.items.map((item, index) => ({ ...item, revision_id: "brief-b",
      occurrence_id: `brief-b-${index}` as ItemOccurrenceId,
      producer_local_id: item.producer_local_id === null ? null : `${item.producer_local_id}-b` })) };

  const result = runPackages([plan, briefA, briefB, assessmentA]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  // A's assessment is owned by A, where its dangling citation is reported.
  const aOccurrences = new Set(briefA.items.filter((item) => item.item_kind === "criterion")
    .map((item) => item.occurrence_id));
  const aCoverage = result.value.eligibility.filter((row) => row.question_id === "assessment.coverage"
    && aOccurrences.has(row.occurrence_id));
  expect(aCoverage.length).toBeGreaterThan(0);
  expect(aCoverage.every((row) => row.decision.tag === "invalid_reference"
    && row.decision.payload.kind === "dangling_citation")).toBe(true);

  // B's criteria are unevidenced: A's assessment assesses none of them, so it supplies no
  // empty coverage package for B.
  const bOccurrences = new Set(briefB.items.filter((item) => item.item_kind === "criterion")
    .map((item) => item.occurrence_id));
  const bCoverage = result.value.eligibility.filter((row) => row.question_id === "assessment.coverage"
    && bOccurrences.has(row.occurrence_id));
  expect(bCoverage.length).toBeGreaterThan(0);
  expect(bCoverage.every((row) => row.decision.tag === "missing_evidence"
    && row.decision.payload.kind === "unevidenced")).toBe(true);
  expect(result.value.packages.filter((pack) => pack.question_id === "assessment.coverage"
    && bOccurrences.has(pack.subject.occurrence_id))).toEqual([]);
});

test("a findings-free assessment belongs only to its collection", async () => {
  const briefA = await captured("brief", "2026-10-23T17:29:56Z");
  const briefB: CapturedRevision = { ...briefA, revision_id: "brief-b", unit_id: "briefs/b",
    collection_key: "cohort-b", recorded_at: new Date("2026-10-23T17:32:00Z"),
    items: briefA.items.map((item, index) => ({ ...item, revision_id: "brief-b",
      occurrence_id: `brief-b-${index}` as ItemOccurrenceId,
      producer_local_id: item.producer_local_id === null ? null : `${item.producer_local_id}-b` })) };
  const assessmentA = { ...await captured("assessment", "2026-10-23T17:40:00Z"), items: [] };
  const result = runPackages([briefA, briefB, assessmentA]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const a = new Set(briefA.items.map((item) => item.occurrence_id));
  const b = new Set(briefB.items.map((item) => item.occurrence_id));
  expect(result.value.eligibility.filter((row) => row.question_id === "assessment.coverage" && a.has(row.occurrence_id))
    .every((row) => row.decision.tag === "eligible")).toBe(true);
  expect(result.value.eligibility.filter((row) => row.question_id === "assessment.coverage" && b.has(row.occurrence_id))
    .every((row) => row.decision.tag === "missing_evidence" && row.decision.payload.kind === "unevidenced")).toBe(true);
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("ingested revisions change derived HTTP gradeability from missing to eligible", async () =>
  scratchGrading(async (db) => {
    const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }],
      read: [{ ...tenant, token: "read" }, { producer: "oakridge", namespace: "other", token: "other" }],
      grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }] } });
    const deliver = async (kind: "brief" | "plan", revision = 1) => {
      const body = await Bun.file(new URL(`../fixtures/oakridge/run-slice/${kind}-revision.json`, import.meta.url)).json();
      if (kind === "plan" && revision === 2)
        body.cohorts[0].acceptance_criteria[0].text = "Lineage is explicit and revised";
      const body_digest = canonicalDigest(body);
      if (!body_digest.ok) throw new Error(body_digest.error.detail);
      const response = await app.request("/v1/sources/oakridge/sync", { method: "POST",
        headers: { authorization: "Bearer ingest", "content-type": "application/json", "idempotency-key": `gradeability-${kind}-${revision}` },
        body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
          revision_id: `oakridge:${tenant.namespace}:gradeability-${kind}-${revision}`, run_id: "gradeability-run",
          unit_id: `${kind}s/cohort-a`, collection_key: "cohort-a", artifact_kind: kind,
          artifact_schema_version: "development-v1", definition_bundle: { id: "development", digest: "fixture" } },
          recorded_at: kind === "brief" ? "2026-10-23T17:29:56Z"
            : revision === 1 ? "2026-10-23T17:23:49Z" : "2026-10-23T18:00:00Z",
          body, body_digest: body_digest.value }) });
      expect(response.status).toBe(201);
    };
    const path = "/v1/evaluation-eligibility?question_id=brief.source_fidelity&question_version=v2&run_id=gradeability-run";
    await deliver("brief");
    const missing = await app.request(path, { headers: { authorization: "Bearer read" } });
    expect(missing.status).toBe(200);
    const missingRows = (await missing.json()).items as { tag: string; payload: { kind: string }; subject_occurrence_id: string }[];
    expect(missingRows.some((row) => row.tag === "missing_evidence" && row.payload.kind === "unevidenced")).toBe(true);
    await deliver("plan");
    const eligible = await app.request(path, { headers: { authorization: "Bearer read" } });
    expect(eligible.status).toBe(200);
    const rows = (await eligible.json()).items as { tag: string; subject_occurrence_id: ItemOccurrenceId;
      payload: { evidence_set_id: string } }[];
    const row = rows.find((item) => item.tag === "eligible" && !!item.payload.evidence_set_id);
    expect(row).toBeDefined();
    if (!row) return;
    const derived = await deriveSubjectGradeability(db, tenant, row.subject_occurrence_id,
      "brief.source_fidelity" as QuestionId, "v2");
    expect(derived.ok && derived.value.evidence?.references.map((ref) => ref.ref.split(":")[0]))
      .toEqual(["plan_criterion", "brief_criterion"]);
    if (!derived.ok || !derived.value.evidence) return;
    expect(derived.value.evidence.references.every((ref) => ref.content !== null && !!ref.digest && !!ref.deep_link)).toBe(true);
    const question = LANGFUSE_PILOT_QUESTIONS["brief.source_fidelity"].definition;
    const values = question.allowed_values!.map(String);
    const instruction_text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge fidelity",
      criteria: Object.fromEntries(values.map((value) => [value, value])) } });
    const model = { ...evaluator("model"), model: "jev-1.14.0", instruction_text,
      prompt_digest: instructionDigest(instruction_text) };
    const context = { question, evidence: derived.value.evidence, evaluator: model };
    expect((await registerGradingContext(db, tenant, context)).ok).toBe(true);
    const assignment = await app.request("/v1/blind-assignments", { method: "POST",
      headers: { authorization: "Bearer grade", "content-type": "application/json" },
      body: JSON.stringify({ subject_occurrence_id: row.subject_occurrence_id,
        evidence_set_id: derived.value.evidence.evidence_set_id,
        question_id: "brief.source_fidelity", question_version: "v2" }) });
    expect(assignment.status).toBe(201);
    const identity = { subject_occurrence_id: row.subject_occurrence_id,
      evidence_set_id: derived.value.evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: model.evaluator_definition_id,
      config_digest: model.config_digest, attempt_label: "pilot-first" };
    let providerCalls = 0;
    const runner = createJevDirectRunner({ api_key: "controlled", base_url: "https://provider.test/v1",
      transport: async (_url, init) => {
        providerCalls++;
        const state = (JSON.parse(String(init.body)) as { state: Record<string, unknown> }).state;
        expect(Object.keys(state).sort()).toEqual(derived.value.evidence!.references.map((ref) => ref.ref).sort());
        const choice = providerCalls === 3 ? "unclear" : providerCalls === 4 ? "insufficient_evidence" : "faithful";
        return Response.json({ model: "jev-1.14.0", answers: { [question.question_id]: {
          type: "choice", choice, confidence: 0.8,
          probabilities: Object.fromEntries(values.map((value) => [value, value === "faithful" ? 0.7 : 0.1])) } },
          usage: { input_tokens: 10, output_tokens: 2 }, cost: 0.01, id: `provider-${providerCalls}` });
      } });
    const digests: string[] = [];
    for (const reviewed_commit of [undefined, "commit-1"]) {
      const selectedIdentity = identity;
      const jobResponse = await app.request("/v1/evaluation-jobs", { method: "POST",
        headers: { authorization: "Bearer grade", "content-type": "application/json" },
        body: JSON.stringify({ identity: selectedIdentity, context, runner: "jev_direct", estimated_cost: 0.01,
          reviewed_commit }) });
      expect(jobResponse.status).toBe(201);
      const job = await jobResponse.json() as EvaluationJobResponse;
      const expected = runGradeDigest(selectedIdentity, reviewed_commit);
      expect(job.idempotency_digest).toBe(expected.ok ? expected.value : "invalid digest");
      digests.push(job.idempotency_digest);
      await workOneJob(db, tenant, { ...gradingLimits(), run_spend: 10, stage_spend: 10 },
        `worker-${reviewed_commit ?? "first"}`, runner);
      const result = await app.request(`/v1/evaluations/by-digest/${encodeURIComponent(job.idempotency_digest)}`,
        { headers: { authorization: "Bearer read" } });
      expect(result.status).toBe(200);
      expect((await result.json()).observation?.answer_state).toBe("answered");
    }
    expect(digests[0]).not.toBe(digests[1]);
    for (const [choice, answer_state] of [["unclear", "unclear"], ["insufficient_evidence", "abstain"]] as const) {
      const selectedIdentity = { ...identity, attempt_label: choice };
      const response = await app.request("/v1/evaluation-jobs", { method: "POST",
        headers: { authorization: "Bearer grade", "content-type": "application/json" },
        body: JSON.stringify({ identity: selectedIdentity, context, runner: "jev_direct", estimated_cost: 0.01 }) });
      expect(response.status).toBe(201);
      const job = await response.json() as EvaluationJobResponse;
      await workOneJob(db, tenant, { ...gradingLimits(), run_spend: 10, stage_spend: 10 }, `worker-${choice}`, runner);
      const result = await app.request(`/v1/evaluations/by-digest/${encodeURIComponent(job.idempotency_digest)}`,
        { headers: { authorization: "Bearer read" } });
      expect((await result.json()).observation?.answer_state).toBe(answer_state);
    }
    expect(providerCalls).toBe(4);
    const humanGrade = await app.request("/v1/grades", { method: "POST",
      headers: { authorization: "Bearer grade", "content-type": "application/json" },
      body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "human", attempt_label: "human-old" },
        context: { ...context, evaluator: evaluator("human") }, details: {
          answer: { state: "answered", kind: "choice", value: "faithful" }, collection_mode: "in_context",
          model_answers_visible: false, workflow_decisions_visible: false } }) });
    expect(humanGrade.status).toBe(201);
    const coverageSelection = { run_id: "gradeability-run", revision_id: null,
      question_id: question.question_id, question_version: question.question_version };
    expect((await readCoverage(db, tenant, coverageSelection)).questions[0]?.graded).toBe(1);
    await deliver("plan", 2);
    const currentCoverage = await readCoverage(db, tenant, coverageSelection);
    expect(currentCoverage.questions[0]?.graded).toBe(0);
    const history = await listGrades(db, tenant, row.subject_occurrence_id, { limit: 20, offset: 0 });
    expect(history?.items.some((item) => item.observation.evidence_set_id === identity.evidence_set_id
      && item.observation.evaluator_definition_id === "human")).toBe(true);
    expect((await app.request(path)).status).toBe(403);
    const crossTenant = await app.request(path, { headers: { authorization: "Bearer other" } });
    expect(crossTenant.status).toBe(403);
  }));
integration("typed missing evidence and dependency decisions persist", async () => scratchGrading(async (db, occurrence_id) => {
  const analysis = "analysis.finding_relevance" as const;
  const assessment = "assessment.coverage" as const;
  for (const question_id of [analysis, assessment]) {
    const pinned = { ...question, question_id: question_id as QuestionId, question_version: "v1",
      requires_repository_snapshot: question_id === assessment };
    expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  }
  const manifest = { selection_policy: "live_all_revisions" as const, packages: [], exclusions: [], eligibility: [
    { question_id: analysis, occurrence_id, decision: { tag: "missing_evidence" as const,
      payload: { kind: "missing_source" as const, detail: "no excerpt source" } } },
    { question_id: assessment, occurrence_id, decision: { tag: "blocked_dependency" as const,
      payload: { dependency: "ArtifactSource.collect", detail: "no implementor" } } },
  ] };
  const saved = await persistOakridgeEligibility(db, tenant, manifest);
  expect(saved).toEqual({ ok: true, value: 2 });
  expect((await readEligibility(db, tenant, analysis, "v1"))[0]?.tag).toBe("missing_evidence");
  expect((await readEligibility(db, tenant, assessment, "v1"))[0]?.payload).toEqual({ dependency: "ArtifactSource.collect", detail: "no implementor" });
}));
