import { expect, test } from "bun:test";
import type { ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const OAKRIDGE_QUESTIONS = oakridgeQuestions(pilotExpectations);
import type { CapturedRevision } from "../src/grading/evidence-packages/capture";
import { pinnedInputRecipe, pinnedPilotRecipe, type PilotEvidenceRecipe } from "../src/grading/evidence-packages/pilot-recipe";
import type { QuestionDefinition } from "../src/grading/question";
import { runPackages } from "../src/producers/oakridge/evidence-packages";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";

function captured(artifact_kind: string, revision_id: string, body: JsonValue, at: string): CapturedRevision {
  const pass = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(artifact_kind, "development-v1"));
  return { ...pilotExpectations["brief.source_fidelity"], revision_id, unit_id: `briefs/${artifact_kind}`,
    artifact_kind, recorded_at: new Date(at),
    items: pass.items.map(({ item }, index) => ({ ...item, revision_id,
      occurrence_id: `${revision_id}-${index}` as ItemOccurrenceId })) };
}

const plan = captured("plan", "plan-1", { cohorts: [{ id: "cohort", decisions: [],
  acceptance_criteria: [{ id: "criterion", text: "Works", task_ids: [], decision_ids: [] }] }] },
  "2026-10-31T00:00:00Z");
const brief = captured("brief", "brief-1", { cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
  acceptance_criteria: [{ id: "criterion", text: "Works" }] }, "2026-11-01T00:00:00Z");
const briefCriterion = brief.items.find((item) => item.item_kind === "criterion")!;

/** An assessment whose `assesses` links name the brief criterion above. The extractor derives a
 * link's target scope from the assessment body, which carries no cohort scope here, so the links
 * are retargeted at the captured criterion — these tests cover the window and the slot counts,
 * not scope derivation. */
function assessment(revision_id: string, findings: readonly JsonValue[], at: string): CapturedRevision {
  const revision = captured("assessment", revision_id, { head_sha: "reviewed", findings }, at);
  return { ...revision, unit_id: "implementation/cohort",
    items: revision.items.map((item) => ({ ...item, links: item.links.map((link) => ({ ...link,
      target_scope: briefCriterion.item_scope, target_local_id: briefCriterion.producer_local_id ?? "" })) })) };
}

function question(question_id: string, recipe: PilotEvidenceRecipe,
  overrides: Partial<QuestionDefinition> = {}): QuestionDefinition {
  return { ...OAKRIDGE_QUESTIONS["brief.source_fidelity"].definition, question_id: question_id as QuestionId,
    input_recipe: pinnedInputRecipe(recipe), ...overrides };
}

const subjectBinding = { artifact_kind: "brief", item_kind: "criterion" } as const;

test("a linked_sources pin naming an inward relation is not a readable pin", () => {
  // linked_sources resolves against the newest source captured at or before the subject, so an
  // inward relation — whose items are captured after the subject — would silently resolve to
  // nothing. The pin is refused rather than walked incorrectly.
  const inward: PilotEvidenceRecipe = {
    recipe_version: "v1", subject: subjectBinding,
    build: { kind: "linked_sources", undeclared: "unlinked", uncaptured_source: "dangling" },
    input: [{ role: "assessment_finding", min_count: 1, max_count: 1,
      source: { from: "linked", link_type: "assesses", direction: "in", artifact_kind: "assessment", item_kind: "assessment_finding" } }],
    output: [{ role: "brief_criterion", min_count: 1, max_count: 1, source: { from: "subject" } }],
  };
  const refused = question("custom.inbound_coverage", inward);
  expect(pinnedPilotRecipe(refused)).toBeNull();
  expect(runPackages([brief], { "custom.inbound_coverage": { definition: refused, text: "" } }))
    .toMatchObject({ ok: false, error: { detail: "question has no supported captured evidence recipe" } });
});


test("a window whose latest package fails its slot counts admits no earlier package for that subject", () => {
  // The window builder marks only the latest source eligible. When that package is short, an
  // earlier satisfied package must not survive: the repository pass matches a decision by
  // subject alone and would overwrite the shortfall from it.
  const capped = question("assessment.coverage",
    { ...OAKRIDGE_QUESTIONS["assessment.coverage"].definition.input_recipe as unknown as PilotEvidenceRecipe,
      recipe_version: "v1", subject: subjectBinding, build: { kind: "assessment_window" },
      input: [{ role: "brief_criterion", min_count: 1, max_count: 1, source: { from: "subject" } }],
      output: [{ role: "assessment_finding", min_count: 0, max_count: 1,
        source: { from: "linked", link_type: "assesses", direction: "in", artifact_kind: "assessment", item_kind: "assessment_finding" } }] },
    { response_kind: "boolean", allowed_values: null, missing_evidence_policy: "fail" });
  const result = runPackages([brief,
    assessment("assessment-early", [{ criterion_id: "criterion", evidence: [] }], "2026-11-01T01:00:00Z"),
    assessment("assessment-late", [{ criterion_id: "criterion", evidence: [] }, { criterion_id: "criterion", evidence: [] }],
      "2026-11-01T02:00:00Z"),
  ], { "assessment.coverage": { definition: capped, text: "" } });
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.packages.filter((item) => item.subject.occurrence_id === briefCriterion.occurrence_id)).toEqual([]);
  expect(result.value.eligibility.find((item) => item.occurrence_id === briefCriterion.occurrence_id)?.decision)
    .toMatchObject({ tag: "missing_evidence", payload: { kind: "missing_source",
      detail: "pinned recipe is unsatisfied for assessment_finding" } });
});

test("an unreadable pinned repository minimum is an error, not a silent fall back to one", () => {
  const snapshot = question("brief.source_fidelity",
    OAKRIDGE_QUESTIONS["brief.source_fidelity"].definition.input_recipe as unknown as PilotEvidenceRecipe,
    { requires_repository_snapshot: true });
  const result = runPackages([plan, brief], { "brief.source_fidelity": { definition: {
    ...snapshot, input_recipe: { ...OAKRIDGE_QUESTIONS["brief.source_fidelity"].definition.input_recipe,
      minimum_repository_content: "two" } }, text: "" } });
  expect(result).toMatchObject({ ok: false,
    error: { detail: "minimum_repository_content must be a positive integer" } });
});
