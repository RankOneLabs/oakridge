import { test, expect } from "bun:test";
import { createBriefWritingCohorts, createFinalIntegrationCohorts, createImplementationCohorts, createRepositoryPreparationCohorts,
  createPlanningCohorts, createSpecAnalysisCohorts, type StageMaterializationSource } from "../src/decision/materialize-stage";
import { cohortIdFor } from "../src/decision/ids";
import type { BuildBriefBody, PlanBody } from "../src/domain/dev-flow-artifacts";
import type { ArtifactId, CohortKey, CommitSha, RepositoryKey, StageInstanceId } from "../src/domain/primitives";
const ref = (key: string) => ({ id: key as ArtifactId, version: 1 });
const plan: PlanBody = { summary: "two ordered cohorts", cohorts: ["first", "second"].map((id, index) => ({
  id, repository_key: "used", title: id, scope: "code", depends_on: index ? ["first"] : [], description: null,
  files_in_scope: [], decisions: [], acceptance_criteria: [id],
})), scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [] };
const brief = (id: string, dependencies: readonly string[]): BuildBriefBody => ({ cohort_id: id, repository_key: "used", title: id,
  depends_on: dependencies, goal: id, files_in_scope: [], decisions_made: [], approaches_rejected: [], acceptance_criteria: [id], next_action: "build" });
const source = (): StageMaterializationSource => ({ stage_instance_id: "10000000-0000-4000-8000-000000000001" as StageInstanceId,
  run: { brief_notes: "build", base_branch: "epic/test", planner: { runtime: "codex", model: null, effort: null },
    builder: { runtime: "codex", model: null, effort: null }, repositories: ["used", "unused"].map((key) => ({
      key: key as RepositoryKey, path: `/repo/${key}`, integration_branch: "main", forge_repository: null })) },
  repositories: ["used", "unused"].map((key) => ({ ref: ref(key), body: { repository_key: key as RepositoryKey,
    repository_path: `/repo/${key}`, integration_branch: "main", base_branch: "epic/test", base_head_sha: "base" as CommitSha } })),
  analysis: ref("analysis"), plan: { ref: ref("plan"), body: plan },
  briefs: [{ ref: ref("brief-second"), body: brief("second", ["first"]) }, { ref: ref("brief-first"), body: brief("first", []) }],
  completed: plan.cohorts.map((cohort) => ({ cohort_key: cohort.id as CohortKey, repository_key: "used" as RepositoryKey,
    brief: ref(`brief-${cohort.id}`), assessment: ref(`assessment-${cohort.id}`),
    build: { outputs: { build_result: ref(`build-${cohort.id}`), pr_summary: ref(`pr-${cohort.id}`) }, head_sha: "head" as CommitSha,
      pr_url: `https://github.com/owner/repo/pull/${cohort.id === "first" ? 1 : 2}` } })),
});

test("the three review stages freeze accepted upstream references", () => {
  const input = source();
  const analysis = createSpecAnalysisCohorts(input);
  const planning = createPlanningCohorts(input);
  const briefs = createBriefWritingCohorts(input);
  if (!analysis.ok || !planning.ok || !briefs.ok) throw new Error("valid inputs failed");
  expect([analysis.value[0]?.frozen_inputs, planning.value[0]?.frozen_inputs, briefs.value[0]?.frozen_inputs]).toEqual([
    { brief_notes: "build", repositories: input.repositories.map((repository) => ({ repository_key: repository.body.repository_key, ref: repository.ref })) },
    { spec_analysis: ref("analysis"), repositories: input.repositories.map((repository) => ({ repository_key: repository.body.repository_key, ref: repository.ref })) },
    { plan: ref("plan"), repositories: input.repositories.map((repository) => ({ repository_key: repository.body.repository_key, ref: repository.ref })) },
  ]);
});

test("implementation membership follows plan order and frozen cohort identities regardless of brief publication order", () => {
  const input = source();
  const result = createImplementationCohorts(input);
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.map((cohort) => ({ key: cohort.cohort_key, depends_on: cohort.depends_on, brief: "brief" in cohort.frozen_inputs ? cohort.frozen_inputs.brief : null })))
    .toEqual([{ key: "first", depends_on: [], brief: ref("brief-first") },
      { key: "second", depends_on: [cohortIdFor(input.stage_instance_id, "first")], brief: ref("brief-second") }]);
  expect(createImplementationCohorts(input)).toEqual(result);
});

test("an incomplete or altered brief collection produces no implementation membership", () => {
  const input = source();
  for (const briefs of [input.briefs.slice(0, 1), [...input.briefs, input.briefs[0]!],
    input.briefs.map((member) => ({ ...member, body: { ...member.body, repository_key: "unused" } }))]) {
    expect(createImplementationCohorts({ ...input, briefs }).ok).toBe(false);
  }
});

test("final integration creates only used repository cohorts with their accepted completion records", () => {
  const input = source();
  const result = createFinalIntegrationCohorts(input);
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.map((cohort) => ({ key: cohort.cohort_key, inputs: cohort.frozen_inputs })))
    .toEqual([{ key: "used", inputs: { repository: input.repositories[0]?.body, completed_cohorts: input.completed } }]);
});

test("empty preparation and incomplete final completion are refused", () => {
  const input = source();
  expect(createRepositoryPreparationCohorts({ ...input, run: { ...input.run, repositories: [] } }).ok).toBe(false);
  expect(createFinalIntegrationCohorts({ ...input, completed: input.completed.slice(0, 1) }).ok).toBe(false);
});

test("illegal keys are rejected rather than rewritten into colliding branch names", () => {
  const input = source();
  const changed: PlanBody = { ...plan, cohorts: plan.cohorts.map((cohort) => ({ ...cohort, id: "first/second" })) };
  expect(createImplementationCohorts({ ...input, plan: { ref: ref("plan"), body: changed } }).ok).toBe(false);
});
