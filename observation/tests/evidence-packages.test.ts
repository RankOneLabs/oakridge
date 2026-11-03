import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const questions = oakridgeQuestions(pilotExpectations);
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import type { CapturedRevision } from "../src/grading/evidence-packages/capture";
import { capturedReference } from "../src/grading/evidence-packages/references";
import type { EvidenceKind } from "../src/grading/evidence";
import { runPackages } from "../src/producers/oakridge/evidence-packages";
import { persistOakridgeEligibility } from "../src/producers/oakridge/eligibility";
import { readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { tenant, evidence, evaluator, scratchGrading, captureProjectedFixture } from "./grading-fixture";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { buildGraph } from "./dependency-graph";

async function captured(kind: string, at: string): Promise<CapturedRevision> {
  const body = await Bun.file(new URL(`../fixtures/oakridge/run-slice/${kind}-revision.json`, import.meta.url)).json() as JsonValue;
  const revision_id = `${kind}-first`;
  const pass = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(kind, "1", { unit_id: "implementation/slice" }));
  return { ...pilotExpectations["plan.criterion_traceability"], revision_id, unit_id: kind, artifact_kind: kind, recorded_at: new Date(at),
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
  const result = runPackages([analysis, plan, brief, assessment, laterPlan], questions);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const manifest = result.value;
  const first = manifest.packages.find((item) => item.question_id === "plan.criterion_traceability" && item.revision_id === plan.revision_id);
  expect(first?.evidence.references.map((ref) => ref.ref.split(":")[0])).toEqual(["plan_criterion", "plan_decision"]);
  expect(first?.evidence.references.every((ref) => ref.digest?.startsWith("canonical-json/v1:")
    && ref.kind === "internal" && ref.content !== null && ref.deep_link?.startsWith("oakridge://revision/"))).toBe(true);
  const briefPackage = manifest.packages.find((item) => item.question_id === "brief.source_fidelity");
  const planSource = plan.items.find((item) => item.item_kind === "criterion" && item.producer_local_id === briefPackage?.subject.producer_local_id);
  const firstDigest = canonicalDigest(planSource?.selected_value);
  expect(briefPackage?.evidence.references[0]?.digest).toBe(firstDigest.ok ? firstDigest.value : null);
  expect(manifest.selection_policy).toBe("live_all_revisions");
  const missingLink = runPackages([plan, { ...brief, items: brief.items.map((item) => item.item_kind === "criterion"
    ? { ...item, links: [] } : item) }], questions);
  expect(missingLink.ok && missingLink.value.exclusions.every((excluded) => excluded.reason.kind !== "dangling_citation")).toBe(true);
  expect(missingLink.ok && missingLink.value.exclusions.some((excluded) => excluded.reason.kind === "unlinked")).toBe(true);
  const coverage = manifest.packages.filter((pack) => pack.question_id === "assessment.coverage");
  expect(coverage.map((pack) => pack.evidence.references.map((ref) => ref.ref.split(":")[0]))
    .sort((a, b) => b.length - a.length)).toEqual([
    ["brief_criterion", "assessment_finding"], ["brief_criterion", "assessment_finding"],
  ]);
  expect(manifest.eligibility.filter((row) => row.question_id === "assessment.coverage")
    .every((row) => row.decision.tag === "eligible")).toBe(true);
  const withoutAssessment = runPackages([plan, brief], questions);
  expect(withoutAssessment.ok && withoutAssessment.value.eligibility.filter((row) => row.question_id === "assessment.coverage")
    .every((row) => row.decision.tag === "missing_evidence" && row.decision.payload.kind === "unevidenced")).toBe(true);
  const laterAssessment: CapturedRevision = { ...assessment, revision_id: "assessment-later",
    recorded_at: new Date("2026-10-23T17:45:00Z"), items: assessment.items.map((item, index) => ({ ...item,
      revision_id: "assessment-later", occurrence_id: `assessment-later-${index}` as ItemOccurrenceId })) };
  const repeatedCoverage = runPackages([plan, brief, assessment, laterAssessment], questions);
  expect(repeatedCoverage.ok && repeatedCoverage.value.packages.filter((pack) => pack.question_id === "assessment.coverage").length).toBe(4);
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
  const briefB: CapturedRevision = { ...pilotExpectations["brief.source_fidelity"], revision_id: "brief-b", unit_id: "briefs/other", artifact_kind: "brief",
    recorded_at: new Date("2026-10-23T17:32:00Z"),
    items: briefA.items.map((item, index) => ({ ...item, revision_id: "brief-b",
      occurrence_id: `brief-b-${index}` as ItemOccurrenceId,
      producer_local_id: item.producer_local_id === null ? null : `${item.producer_local_id}-b` })) };

  const result = runPackages([plan, briefA, briefB, assessmentA], questions);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  // A's criteria keep their assessment rather than being marked unevidenced.
  const aOccurrences = new Set(briefA.items.filter((item) => item.item_kind === "criterion")
    .map((item) => item.occurrence_id));
  const aCoverage = result.value.eligibility.filter((row) => row.question_id === "assessment.coverage"
    && aOccurrences.has(row.occurrence_id));
  expect(aCoverage.length).toBeGreaterThan(0);
  expect(aCoverage.every((row) => row.decision.tag === "eligible")).toBe(true);

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

for (const has_findings of [true, false]) {
  test(`an unsupported successor closes coverage's assessment window with ${has_findings ? "stable criterion links" : "no findings"}`, async () => {
    const brief = await captured("brief", "2026-10-23T17:29:56Z");
    const successor: CapturedRevision = { ...brief, definition_id: "other-definition", revision_id: "brief-successor",
      recorded_at: new Date("2026-10-23T17:32:00Z"), items: brief.items.map((item, index) => ({ ...item,
        revision_id: "brief-successor", occurrence_id: `brief-successor-${index}` as ItemOccurrenceId })) };
    const captured_assessment = await captured("assessment", "2026-10-23T17:40:00Z");
    const assessment = { ...captured_assessment, items: has_findings ? captured_assessment.items : [] };
    const result = runPackages([brief, successor, assessment], { "assessment.coverage": questions["assessment.coverage"] });
    if (!result.ok) throw new Error(result.error.detail);
    const supported_ids = new Set(brief.items.filter((item) => item.item_kind === "criterion").map((item) => item.occurrence_id));
    const unsupported_ids = new Set(successor.items.filter((item) => item.item_kind === "criterion").map((item) => item.occurrence_id));
    expect(result.value.eligibility.filter((row) => supported_ids.has(row.occurrence_id)).map((row) => row.decision))
      .toEqual([...supported_ids].map(() => ({ tag: "missing_evidence", payload: { kind: "unevidenced" } })));
    expect(result.value.eligibility.filter((row) => unsupported_ids.has(row.occurrence_id)).map((row) => row.decision.tag))
      .toEqual([...unsupported_ids].map(() => "inapplicable"));
    expect(result.value.packages).toEqual([]);
  });
}

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("typed missing evidence decisions persist", async () => scratchGrading(async (db) => {
  const findings = await captureProjectedFixture(db, { revision_id: "missing-analysis", artifact_kind: "analysis", body: {
    findings: [{ id: "finding", description: "needs source", severity: "info" }], requirements: [], proposed_spec_updates: [], risks: [],
  } });
  const criteria = await captureProjectedFixture(db, { revision_id: "missing-brief", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "criterion", text: "needs assessment" }],
  } });
  const analysis = "analysis.finding_relevance" as const;
  const assessment = "assessment.coverage" as const;
  for (const question_id of [analysis, assessment]) {
    const pinned = { ...questions[question_id].definition,
      requires_repository_snapshot: question_id === assessment };
    expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  }
  const manifest = { selection_policy: "live_all_revisions" as const, packages: [], exclusions: [], eligibility: [
    { question_id: analysis, question_version: "v1", occurrence_id: findings.find((item) => item.item_kind === "finding")!.occurrence_id as ItemOccurrenceId, decision: { tag: "missing_evidence" as const,
      payload: { kind: "missing_source" as const, detail: "no excerpt source" } } },
    { question_id: assessment, question_version: "v1", occurrence_id: criteria.find((item) => item.item_kind === "criterion")!.occurrence_id as ItemOccurrenceId, decision: { tag: "missing_evidence" as const,
      payload: { kind: "missing_source" as const, detail: "too few repository content references" } } },
  ] };
  const saved = await persistOakridgeEligibility(db, tenant, manifest);
  expect(saved).toEqual({ ok: true, value: 2 });
  expect((await readEligibility(db, tenant, { run_id: "run-1", question_id: analysis, question_version: "v1", limit: 200, offset: 0 })).items[0]?.tag).toBe("missing_evidence");
  expect((await readEligibility(db, tenant, { run_id: "run-1", question_id: assessment, question_version: "v1", limit: 200, offset: 0 })).items[0]?.payload).toEqual({ kind: "missing_source", detail: "too few repository content references" });
}));

test("unsupported captured provenance stops before subject or evidence interpretation", async () => {
  const plan = await captured("plan", "2026-10-23T17:23:49Z");
  const unsupported = { ...plan, definition_id: "b".repeat(64), items: plan.items.map((item) => ({ ...item,
    item_scope: null, producer_local_id: null, selected_value: "obsolete layout", links: [] })) };
  const result = runPackages([unsupported], { "plan.criterion_traceability": questions["plan.criterion_traceability"] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.packages).toEqual([]);
  expect(result.value.exclusions).toEqual([]);
  expect(result.value.eligibility.length).toBeGreaterThan(0);
  expect(result.value.eligibility.every((row) => row.decision.tag === "inapplicable"
    && row.decision.payload.reason.includes(`recorded="${unsupported.definition_id}"`)
    && row.decision.payload.reason.includes('pinned="definition-1"'))).toBe(true);
});

test("captured derivation refuses a question with no supported evidence recipe", async () => {
  const plan = await captured("plan", "2026-10-23T17:23:49Z");
  const entry = questions["plan.criterion_traceability"];
  const result = runPackages([plan], { "plan.criterion_traceability": { ...entry,
    definition: { ...entry.definition, input_recipe: {} } } });
  expect(result).toMatchObject({ ok: false, error: { detail: "question has no supported captured evidence recipe" } });
});

integration("repository questions follow explicit addresses into captured content, never a checkout", async () => scratchGrading(async (db) => {
  const { captureProjectedFixture } = await import("./grading-fixture");
  const { deriveCapturedEvidence } = await import("../src/storage/captured-evidence-store");
  const { CaptureArtifactSource } = await import("../src/storage/capture-artifact-source");
  for (const scenario of ["complete", "absent", "wrong-run", "missing-commit", "truncated"] as const) {
    const run_id = `repository-${scenario}`;
    const source_revision = `source-${scenario}`;
    if (scenario !== "absent") await captureProjectedFixture(db, { run_id: scenario === "wrong-run" ? "other-run" : run_id,
      revision_id: source_revision, artifact_kind: "repository_content", body: {
        ...(scenario === "missing-commit" ? {} : { head_sha: "reviewed-commit" }),
        ...(scenario === "truncated" ? { is_truncated: true } : {}),
        content: "export const captured = true;",
      } });
    const items = await captureProjectedFixture(db, { run_id, revision_id: `brief-${scenario}`, artifact_kind: "brief", body: {
      cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "criterion", text: "Works" }],
    } });
    const findings = await captureProjectedFixture(db, { run_id, revision_id: `assessment-${scenario}`, artifact_kind: "assessment",
      body: { head_sha: "reviewed-commit", findings: [{ criterion_id: "criterion", evidence: [
        { kind: "file", ref: `oakridge://revision/${source_revision}#/content` },
      ] }] }, recorded_at: "2026-11-01T01:00:00Z" });
    const subject = items.find((item) => item.item_kind === "criterion")!;
    const question = { ...questions["assessment.coverage"].definition, requires_repository_snapshot: true };
    const result = await deriveCapturedEvidence(db, tenant, run_id, {
      subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId, question,
    });
    if (!result.ok) throw new Error(result.error.detail);
    if (scenario === "complete") {
      expect(result.value.decision.tag).toBe("eligible");
      expect(result.value.revision_id).toBe("assessment-complete");
      const repository = result.value.evidence?.references.find((ref) => ref.kind === "repository_content");
      const digest = canonicalDigest("export const captured = true;");
      expect(repository).toMatchObject({ content: "export const captured = true;", digest: digest.ok ? digest.value : null,
        reviewed_commit: "reviewed-commit", deep_link: "oakridge://revision/source-complete#/content" });
      const source = new CaptureArtifactSource(db, tenant, run_id);
      const finding = findings.find((item) => item.item_kind === "assessment_finding")!;
      expect(await source.read(finding.occurrence_id as ItemOccurrenceId)).toMatchObject({ occurrence_id: finding.occurrence_id });
      expect(await new CaptureArtifactSource(db, tenant, "other-run").read(finding.occurrence_id as ItemOccurrenceId)).toBeNull();
      await captureProjectedFixture(db, { run_id, revision_id: "new-repository-content", artifact_kind: "repository_content",
        body: { head_sha: "other-commit", content: "changed" }, predecessor_id: source_revision,
        recorded_at: "2026-11-01T02:00:00Z" });
      expect(await deriveCapturedEvidence(db, tenant, run_id, { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId, question }))
        .toEqual(result);
    } else {
      expect(result.value.decision).toMatchObject({ tag: "missing_evidence", payload: { kind: "missing_source",
        detail: scenario === "missing-commit" ? "repository reference has no matching reviewed commit"
          : scenario === "truncated" ? "repository excerpt lacks canonical digest or incompleteness reason"
            : "too few repository content references" } });
    }
  }
}));
