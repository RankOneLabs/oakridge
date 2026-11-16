import { expect, it } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionSummary } from "../operator-contracts/projections/definition-view";
import { publishedConfig } from "../__tests__/grading-config-fixture";
import { selectWorkflowGradingGroups, gradingEditorHref, selectWorkflowArtifactTargets, selectGradingMatches, selectArtifactGrading, selectGradingRequirements } from "./grading-applicability";
const definition = fixture.definition as unknown as OperatorDefinitionSummary;
const artifacts = selectWorkflowArtifactTargets(definition);
const source = { id: "brief.correctness", targets: [{ artifact: "brief", selector: "/build_items/*" }, { artifact: "brief", selector: "/acceptance_criteria/*" }] };
it("matches a contract once carrying both selectors", () => {
  expect(selectGradingMatches([source], artifacts).map(match => ({ stage: match.artifact.stage, artifact: match.artifact.artifact, selectors: match.selectors }))).toEqual([{ stage: "brief", artifact: "brief", selectors: ["/build_items/*", "/acceptance_criteria/*"] }]);
});
it("deduplicates every invoking stage's artifact keys and excludes root", () => {
  // Explicit captured contracts: adding or omitting a unit artifact must change this expectation.
  const expected = [
    "analysis/analysis", "analysis/spec", "analysis/tasks", "brief/brief",
    "cohort/assessment", "cohort/build_result", "cohort/observed_state", "cohort/pr", "cohort/pr_state",
    "integration/assessment", "integration/manual_merge_target", "integration/observed_state", "integration/pr", "integration/pr_state",
    "planning/plan", "prepare/workspace",
  ];
  expect(artifacts.map(target => `${target.stage}/${target.artifact}`)).toEqual(expected);
});
it("shares source references across matching artifacts", () => {
  const shared = { id: "shared", targets: [{ artifact: "brief", selector: "/a" }, { artifact: "assessment", selector: "/b" }] };
  const matches = selectGradingMatches([shared], artifacts);
  expect(matches.map(match => ({ stage: match.artifact.stage, artifact: match.artifact.artifact, selectors: match.selectors }))).toEqual([
    { stage: "brief", artifact: "brief", selectors: ["/a"] },
    { stage: "cohort", artifact: "assessment", selectors: ["/b"] },
    { stage: "integration", artifact: "assessment", selectors: ["/b"] },
  ]);
  expect(matches.every(match => match.source === shared)).toBe(true);
});
it("supports newly declared artifacts without a named workflow rule", () => {
  const release = { id: "release", targets: [{ artifact: "release_note", selector: "/" }] };
  expect(selectGradingMatches([release], artifacts)).toEqual([]);
  expect(selectGradingMatches([release], [...artifacts, { definition_id: "new", workflow: "new", stage: "ship", artifact: "release_note" }])).toHaveLength(1);
});
it("uses the same inputs regardless of per-run grading enablement", () => {
  const disabledRun = { config: { grading_enabled: false }, definition };
  const enabledRun = { config: { grading_enabled: true }, definition };
  expect(selectGradingMatches([source], selectWorkflowArtifactTargets(disabledRun.definition))).toEqual(selectGradingMatches([source], selectWorkflowArtifactTargets(enabledRun.definition)));
});
it("selects just the inspected contract", () => {
  expect(selectArtifactGrading(selectGradingMatches([source], artifacts), { definition_id: definition.definition_id, stage: "plan", artifact: "plan" })).toEqual([]);
});
it("normalizes typed requirements including human and parameterized evidence", () => {
  const original = publishedConfig().definitions[0];
  expect(selectGradingRequirements({ ...original, evaluators: [{ runner: "human" }, { runner: "judge", model: "model", instructions: {}, estimated_cost_per_call: 0 }], evidence: ["subject", { capability: "code", params: { path: "src" } }] })).toEqual({ question_text: original.question.text, response: original.question.response, scope: original.scope, evaluators: [{ runner: "human", model: null }, { runner: "judge", model: "model" }], evidence: [{ capability: "subject", params: null }, { capability: "code", params: { path: "src" } }] });
});
it("encodes a stable editor definition target", () => {
  expect(gradingEditorHref("brief.build_item correctness")).toMatch(/\/definitions\/brief.build_item%20correctness$/);
});

it("groups matches by shared source in definition order with every matching contract", () => {
  const other = { id: "assessment", targets: [{ artifact: "assessment", selector: "/items/*" }] };
  const absent = { id: "absent", targets: [{ artifact: "missing", selector: "/" }] };
  const matches = selectGradingMatches([source, other, absent], artifacts);
  const groups = selectWorkflowGradingGroups(matches);
  expect(groups.map(group => ({ id: group.source.id, artifacts: group.matches.map(match => `${match.artifact.stage}/${match.artifact.artifact}`) }))).toEqual([
    { id: source.id, artifacts: ["brief/brief"] },
    { id: other.id, artifacts: ["cohort/assessment", "integration/assessment"] },
  ]);
  expect(groups[0]?.source).toBe(source);
  expect(groups[1]?.source).toBe(other);
});
it("has no groups when no definitions match", () => {
  expect(selectWorkflowGradingGroups([])).toEqual([]);
});
