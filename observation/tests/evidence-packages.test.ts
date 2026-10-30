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
import { registerGradingContext } from "../src/storage/grading-store";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { buildGraph } from "./dependency-graph";

async function captured(kind: string, at: string): Promise<CapturedRevision> {
  const body = await Bun.file(new URL(`../fixtures/oakridge/run-slice/${kind}-revision.json`, import.meta.url)).json() as JsonValue;
  const revision_id = `${kind}-first`;
  const pass = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(kind, "1"));
  return { revision_id, unit_id: kind, artifact_kind: kind, recorded_at: new Date(at),
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
    && ref.kind === "internal" && ref.content === null && ref.deep_link?.startsWith("oakridge://revision/"))).toBe(true);
  const briefPackage = manifest.packages.find((item) => item.question_id === "brief.source_fidelity");
  const planSource = plan.items.find((item) => item.item_kind === "criterion" && item.producer_local_id === briefPackage?.subject.producer_local_id);
  const firstDigest = canonicalDigest(planSource?.selected_value);
  expect(briefPackage?.evidence.references[0]?.digest).toBe(firstDigest.ok ? firstDigest.value : null);
  expect(manifest.selection_policy).toBe("live_all_revisions");
  const missingLink = runPackages([plan, { ...brief, items: brief.items.map((item) => item.item_kind === "criterion"
    ? { ...item, links: [] } : item) }]);
  expect(missingLink.ok && missingLink.value.exclusions.every((excluded) => excluded.reason.kind !== "dangling_citation")).toBe(true);
  expect(missingLink.ok && missingLink.value.exclusions.some((excluded) => excluded.reason.kind === "unlinked")).toBe(true);
  expect(manifest.eligibility.filter((row) => row.question_id === "assessment.coverage")
    .every((row) => row.decision.tag === "blocked_dependency" && row.decision.payload.dependency === "ArtifactSource.collect")).toBe(true);
  expect(manifest.eligibility.some((row) => row.question_id === "analysis.finding_relevance"
    && row.decision.tag === "missing_evidence")).toBe(true);
  const graph = buildGraph([resolve(import.meta.dir, "../src/producers/oakridge/evidence-packages.ts")]);
  expect([...graph.values()].filter((node) => node.path.includes("/src/langfuse/") || node.packages.some((name) => name.includes("langfuse")))).toEqual([]);
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("deferred pilot questions persist missing evidence and blocked dependency", async () => scratchGrading(async (db, occurrence_id) => {
  const analysis = "analysis.finding_relevance" as const;
  const assessment = "assessment.coverage" as const;
  for (const question_id of [analysis, assessment]) {
    const pinned = { ...question, question_id: question_id as QuestionId, question_version: "v1" };
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
