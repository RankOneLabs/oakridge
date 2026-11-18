import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { development, prompts, root, TestRun, stageWorkflow, workspace, repository, analysis, spec, cohort, brief, assessment, buildResult, pr, validationFeedback, type AnalysisBody, type SpecBody, type PlanCohort, type BriefBody, type AssessmentBody } from "./development-test-support";
import { DEFINITION_STORE_ROOT, resolveDefinition, resolveLaunchableDefinition } from "./definition-store";
import type { DefinitionId } from "./definition-identity";

const guardReason = "Resolve every blocking finding and choose an option for every operator decision before accepting the analysis.";
async function analysisRun(body = analysis()) {
  const run = await TestRun.launch(stageWorkflow("analysis"), { spec: "Original specification", workspace });
  await run.publish("author", "analysis", body);
  await run.end("author");
  return run;
}
async function specRun(body: SpecBody) {
  const run = await analysisRun();
  await run.decide("analysis_review", "accept", "analysis");
  await run.publish("spec_editor", "spec", body);
  return run;
}
const analysisCases: {name: string; change: (body: AnalysisBody) => void; message: string}[] = [
  {name: "duplicate requirement", change: b => { b.requirements[1].id = "R1"; }, message: "Requirement ids must be unique."},
  {name: "empty source references", change: b => { b.requirements[0].source_refs = []; }, message: "Every requirement must cite at least one source reference."},
  {name: "missing findings", change: b => { b.requirements[0].findings = []; }, message: "Every requirement needs at least one finding."},
  {name: "globally repeated finding", change: b => { b.requirements[1].findings[0].id = "F1"; }, message: "Finding ids must be unique across the analysis."},
  {name: "single operator alternative", change: b => { b.requirements[0].findings[0].resolution = {kind: "operator_decision", text: "Choice", question: "Which?", alternatives: [{option: "A", consequence: "A"}]}; }, message: "An operator_decision resolution needs a question and at least two alternatives."},
];
for (const c of analysisCases) test(`analysis refuses ${c.name} with its message`, async () => {
  const body = analysis(); c.change(body);
  expect(validationFeedback(await analysisRun(body))).toContain(c.message);
});
for (const state of ["blocking", "unchosen", "blank", "unknown", "resolved"] as const) test(`analysis accept availability: ${state}`, async () => {
  const body = analysis(), finding = body.requirements[0].findings[0];
  if (state === "blocking") finding.severity = "blocking";
  else finding.resolution = {kind: "operator_decision", text: "Choose", question: "Which?", alternatives: [{option: "A", consequence: "A"}, {option: "B", consequence: "B"}], ...(state === "unchosen" ? {} : {chosen: state === "resolved" ? "A" : state === "blank" ? "" : "C"})};
  const run = await analysisRun(body);
  const accept = run.result.reviews.find(r => r.review === "analysis_review")?.decisions.find(d => d.decision === "accept");
  expect([accept ? accept.is_available ?? true : false, accept?.disabled_reason ?? null]).toEqual(state === "resolved" ? [true, null] : [false, guardReason]);
});
test("analysis findings with absent optional resolution validate and are acceptable", async () => {
  const body = analysis(); delete body.requirements[0].findings[0].resolution;
  const run = await analysisRun(body);
  expect(run.result.snapshot.decisions.filter(d => d.kind === "validation")).toEqual([]);
  const accept = run.result.reviews.find(r => r.review === "analysis_review")?.decisions.find(d => d.decision === "accept");
  expect(accept && (accept.is_available ?? true)).toBe(true);
});
const specCases: {name: string; change: (body: SpecBody) => void; message: string}[] = [
  {name: "missing requirement", change: b => { b.requirements.pop(); }, message: "Every approved analysis requirement must appear in the specification."},
  {name: "duplicate requirement", change: b => { b.requirements.push(b.requirements[0]); }, message: "Specification requirement ids must be unique."},
  {name: "unknown requirement", change: b => { b.requirements[0].id = "unknown"; }, message: "Specification requirement ids must belong to the approved analysis."},
  {name: "unknown finding", change: b => { b.requirements[0].analysis_finding_ids = ["unknown"]; }, message: "Specification finding links must name approved analysis findings."},
  {name: "no acceptance condition", change: b => { b.requirements[0].acceptance_conditions = []; }, message: "Every specification requirement needs at least one acceptance condition."},
];
for (const c of specCases) test(`spec refuses ${c.name}`, async () => {const body = spec();c.change(body);expect(validationFeedback(await specRun(body))).toContain(c.message);});
test("spec review reopens analysis and reruns the editor in revise mode", async () => {
  const run = await specRun(spec());await run.end("spec_editor");
  await run.decide("spec_review", "request_analysis_changes", "spec", {feedback: "Clarify R1"});
  expect(run.wanted("author").action.mode.kind).toBe("revise");
  const revised = analysis(); revised.requirements[0].text = "Clarified R1";
  await run.publish("author", "analysis", revised);await run.end("author");
  expect(() => run.wanted("spec_editor")).toThrow();
  await run.decide("analysis_review", "accept", "analysis");
  const editor = run.wanted("spec_editor");
  expect([editor.action.mode.kind, editor.resolved.previous?.artifact, editor.resolved.feedback.map(f => f.decision)]).toEqual(["revise", "spec", ["request_analysis_changes"]]);
  await run.publish("spec_editor", "spec", spec());await run.end("spec_editor");
  expect(() => run.wanted("spec_editor")).toThrow();
});
test("canonical analysis stage has only analysis and spec, with spec as its only outcome", () => {
  expect([Object.keys(development.stages.analysis.artifacts), development.stages.analysis.outcome, Object.keys(development.stages.analysis.reviews ?? {}), development.schemas?.tasks_body]).toEqual([["analysis", "spec"], {spec: "latest(spec)"}, ["analysis_review", "spec_review"], undefined]);
});
const planCases: {name: string; cohorts: PlanCohort[]; message: string}[] = [
  {name: "empty plan", cohorts: [], message: "The plan must name at least one cohort."},
  {name: "unallocated requirement", cohorts: [cohort("C1", ["R1"])], message: "Every specification requirement must be allocated to at least one cohort."},
  {name: "unknown requirement", cohorts: [cohort("C1", ["R1", "R2", "unknown"])], message: "Every allocation must name a canonical specification requirement."},
  {name: "duplicate allocation", cohorts: [cohort("C1", ["R1", "R2", "R2"])], message: "A requirement may be allocated only once within a cohort."},
  {name: "unknown repository", cohorts: [{...cohort(), repository_key: "unknown"}], message: "Every cohort's repository_key must be the key of one of the run's repositories."},
  {name: "missing dependency", cohorts: [cohort("C1", ["R1", "R2"], ["missing"])], message: "Cohort ids must be unique idents"},
  {name: "cycle", cohorts: [cohort("C1", ["R1"], ["C2"]), cohort("C2", ["R2"], ["C1"])], message: "Cohort ids must be unique idents"},
  {name: "empty allocations", cohorts: [cohort(), cohort("C2", [])], message: "Every cohort needs at least one allocation."},
];
for (const c of planCases) test(`plan refuses ${c.name}`, async () => {
  const run = await TestRun.launch(stageWorkflow("planning"), {spec: spec(), repositories: [repository], workspace});
  await run.publish("planner", "plan", {cohorts: c.cohorts});expect(validationFeedback(run)).toContain(c.message);
});
test("planner sees every run repository key and permits a split requirement", async () => {
  const run = await TestRun.launch(stageWorkflow("planning"), {spec: spec(), repositories: [repository, {...repository, key: "secondary"}], workspace});
  expect(run.wanted("planner").resolved.inputs).toEqual({spec: spec(), repository_keys: ["oakridge", "secondary"]});
  await run.publish("planner", "plan", {cohorts: [cohort(), cohort("C2", ["R2"])]});
  expect(run.result.snapshot.decisions).toEqual([]);
});
const briefCases: {name: string; change: (b: BriefBody) => void; message: string}[] = [
  {name: "wrong cohort", change: b => {b.cohort_id = "unknown";}, message: "The brief's cohort_id"},
  {name: "wrong repository", change: b => {b.repository_key = "unknown";}, message: "The brief's repository_key"},
  {name: "wrong dependencies", change: b => {b.depends_on = ["unknown"];}, message: "The brief's depends_on"},
  {name: "duplicate build item", change: b => {b.build_items.push(b.build_items[0]);}, message: "Build-item ids must be unique."},
  {name: "unassigned requirement", change: b => {b.build_items[0].requirement_ids.push("unknown");}, message: "Build-item requirement ids must belong to the resolved assignment."},
  {name: "uncovered requirement", change: b => {b.build_items.pop();}, message: "Every assigned requirement must appear in a build item."},
  {name: "empty requirement links", change: b => {b.build_items[0].requirement_ids = [];}, message: "Every build item needs at least one requirement and one verification entry."},
  {name: "empty verification", change: b => {b.build_items[0].verification = [];}, message: "Every build item needs at least one requirement and one verification entry."},
  {name: "empty instructions", change: b => {b.build_items[0].instructions = "";}, message: "Every build item needs nonempty instructions."},
  {name: "duplicate decision", change: b => {b.technical_decisions.push(b.technical_decisions[0]);}, message: "Technical decision ids must be unique."},
  {name: "unknown decision link", change: b => {b.technical_decisions[0].build_item_ids = ["unknown"];}, message: "Technical decision links must name brief build items."},
];
for (const c of briefCases) test(`brief refuses ${c.name}`, async () => {
  const run = await TestRun.launch(stageWorkflow("brief"), {assignment: {cohort: cohort(), requirements: spec().requirements}, workspace});
  const body = brief();c.change(body);await run.publish("writer", "brief", body);expect(validationFeedback(run)).toContain(c.message);
});
async function assessmentRun(body: AssessmentBody, integration = false) {
  const run = await TestRun.launch(stageWorkflow(integration ? "integration" : "cohort"), integration
    ? {repository, workspace, cohorts: [], briefs: [brief()], requirements: spec().requirements, final_merge_policy: "require_merge"}
    : {cohort: cohort(), brief: brief(), repository, workspace});
  if (!integration) {await run.publish("builder", "pr", pr);await run.publish("builder", "build_result", buildResult);await run.end("builder");}
  await run.publish(integration ? "integrator" : "assessor", "assessment", body);
  return run;
}
const assessmentCases: {name: string; change: (b: AssessmentBody) => void; message: string}[] = [
  {name: "missing item", change: b => {b.item_assessments.pop();}, message: "Every brief build item must be assessed."},
  {name: "unknown item", change: b => {b.item_assessments[0].subject.id = "unknown";}, message: "Cohort assessment items must name brief build items."},
  {name: "duplicate item", change: b => {b.item_assessments.push(b.item_assessments[0]);}, message: "Assessment item ids must be unique."},
  {name: "wrong kind", change: b => {b.item_assessments[0].subject.kind = "requirement";}, message: "Cohort assessment items must be build items."},
  {name: "orphan action", change: b => {b.next_actions.push({id: "00000000-0000-4000-8000-000000000001", audience: "builder", source: {kind: "additional_finding", id: "unknown"}, text: "Fix"});}, message: "Every next action source must resolve"},
  {name: "wrong head", change: b => {b.head_sha = "wrong";}, message: "Assessment head_sha must match"},
  {name: "unknown related item", change: b => {b.additional_findings.push({id: "F1", severity: "info", observation: "Note", related_build_item_ids: ["unknown"], evidence: []});}, message: "Additional finding links must name brief build items."},
  {name: "unexplained test failure", change: b => {b.test_evidence.failed = 1;}, message: "Failed tests require an unmet item"},
];
for (const c of assessmentCases) test(`assessment refuses ${c.name}`, async () => {const body = assessment();c.change(body);expect(validationFeedback(await assessmentRun(body))).toContain(c.message);});
for (const integration of [false, true]) for (const severity of ["blocking", "warning", "info"] as const) for (const verdict of ["pass", "pass_with_notes", "fail"] as const) test(`${integration ? "integration" : "cohort"} verdict ${verdict} with ${severity} finding`, async () => {
  const body = assessment(integration ? "requirement" : "build_item"); body.additional_findings = [{id: "F1", severity, observation: "Evidence", related_build_item_ids: [], evidence: []}];body.verdict = verdict;
  const run = await assessmentRun(body, integration);
  const expected = severity === "blocking" ? "fail" : severity === "warning" ? "pass_with_notes" : "pass";
  expect(validationFeedback(run).includes("Assessment verdict must match")).toBe(verdict !== expected);
});
for (const status of ["partial", "not_met"] as const) test(`${status} items require fail and explain failed tests`, async () => {
  const body = assessment();body.item_assessments[0].status = status;body.verdict = "fail";body.test_evidence.failed = 1;
  expect((await assessmentRun(body)).result.snapshot.decisions.filter(d => d.kind === "validation")).toEqual([]);
});
for (const defect of ["wrong kind", "missing", "unknown"] as const) test(`integration refuses ${defect} requirement`, async () => {
  const body = assessment("requirement");
  if (defect === "wrong kind") body.item_assessments[0].subject.kind = "build_item";
  if (defect === "missing") body.item_assessments.pop();
  if (defect === "unknown") body.item_assessments[0].subject.id = "unknown";
  expect((await assessmentRun(body, true)).result.snapshot.decisions.some(d => d.kind === "validation")).toBe(true);
});
test("adjudication preserves history and forwards only builder_feedback", async () => {
  const run = await assessmentRun(assessment());await run.end("assessor");
  const payload = {entries: [], added_actions: [], builder_feedback: "Fix X"};
  await run.decide("assessment_review", "request_build_changes", "assessment", payload);
  expect(run.wanted("builder").resolved.feedback.map(f => f.payload)).toEqual([{feedback: "Fix X"}]);
  await run.publish("builder", "build_result", {...buildResult, head_sha: "sha2"});await run.end("builder");
  expect(run.wanted("assessor").resolved.review_history?.map(f => f.payload)).toContainEqual(payload);
});
test("integration adjudication forwards builder_feedback to the integrator", async () => {
  const run = await assessmentRun(assessment("requirement"), true);await run.publish("integrator", "pr", pr);await run.end("integrator");
  await run.decide("integration_review", "request_changes", "assessment", {entries: [], added_actions: [], builder_feedback: "Fix integration"});
  expect(run.wanted("integrator").resolved.feedback.map(f => f.payload)).toEqual([{feedback: "Fix integration"}]);
});
test("previous pinned development and all of its prompt objects remain resolvable", () => {
  const previous = resolveDefinition("74de304c8c29fc50ac3596817a2aed2ffb14846ccb8ecb7ef59f91127b7f87f4" as DefinitionId, DEFINITION_STORE_ROOT);
  expect(previous.ok && Object.keys(previous.value.prompts).length > 0).toBe(true);
});
test("current definition pins every rewritten prompt", () => {
  const current = resolveLaunchableDefinition("development", DEFINITION_STORE_ROOT);
  expect(current.ok && current.value.prompts).toEqual(prompts);
});
const blocker = "If the inputs are contradictory, unimplementable or ambiguous in a way only the operator can settle, raise a blocker instead of guessing.";
for (const [stageName, stage] of Object.entries(development.stages)) for (const [workerName, worker] of Object.entries(stage.workers)) {
  if (!("kind" in worker) || worker.kind !== "agent") continue;
  for (const mode of ["initial", "revise"] as const) {
    const path = worker.prompts[mode];if (!path) continue;
    test(`${stageName}.${workerName}.${mode} includes exact blocker instruction`, () => expect(prompts[path]).toContain(blocker));
  }
}
for (const [path, prompt] of Object.entries(prompts)) test(`${path} contains no retired vocabulary`, () => {
  expect(prompt).not.toMatch(/pick a sensible path|\btasks\b|task_ids|tasks_review|acceptance_criteria|approaches_rejected|dependency_order|recommended_next_actions|needs_decision|subjects/);
});
interface CohortScenario { name: string; cohorts: PlanCohort[]; ready: string[]; waiting: string[] }
const scenarios = JSON.parse(readFileSync(resolve(root, "workflow-config/samples/development-cohorts.json"), "utf8")) as CohortScenario[];
async function planRun(cohorts: PlanCohort[]) {
  const run = await TestRun.launch(development, {title: "Contract", spec: "Original", repositories: [repository], primary_repository_key: "oakridge", final_merge_policy: "require_merge"});
  await run.publish("git", "workspace", workspace, "run/prepare/oakridge");await run.end("git", "run/prepare/oakridge");
  await run.publish("author", "analysis", analysis(), "run/analysis");await run.end("author", "run/analysis");await run.decide("analysis_review", "accept", "analysis", {}, "run/analysis");
  await run.publish("spec_editor", "spec", spec(), "run/analysis");await run.end("spec_editor", "run/analysis");await run.decide("spec_review", "accept", "spec", {}, "run/analysis");
  await run.publish("planner", "plan", {cohorts}, "run/planning");await run.end("planner", "run/planning");await run.decide("plan_review", "accept", "plan", {}, "run/planning");
  return run;
}
for (const scenario of scenarios) test(`compiled development scheduling: ${scenario.name}`, async () => {
  const run = await planRun(scenario.cohorts);
  for (const c of scenario.cohorts) {
    const assignment = {cohort: c, requirements: spec().requirements.filter(r => c.allocations.some(a => a.requirement_id === r.id))};
    expect(run.wanted("writer", `run/briefs/${c.id}`).resolved.inputs).toEqual({assignment});
    await run.publish("writer", "brief", brief(c), `run/briefs/${c.id}`);await run.end("writer", `run/briefs/${c.id}`);await run.decide("brief_review", "accept", "brief", {}, `run/briefs/${c.id}`);
  }
  expect(run.activeWanted().filter(w => w.worker === "builder").map(w => w.unit).sort()).toEqual(scenario.ready.map(id => `run/implementation/${id}`).sort());
  for (const id of scenario.waiting) expect(run.result.blocked.find(b => b.unit === `run/implementation/${id}`)?.reason.kind).toBe("waiting_on");
});

test("integration resolves a shared canonical requirement once across contributions", async () => {
  const cohorts = [cohort(), cohort("C2", ["R2"])];
  const run = await planRun(cohorts);
  for (const c of cohorts) {
    const unit = `run/briefs/${c.id}`;
    await run.publish("writer", "brief", brief(c), unit);await run.end("writer", unit);await run.decide("brief_review", "accept", "brief", {}, unit);
  }
  for (const c of cohorts) {
    const unit = `run/implementation/${c.id}`;
    await run.publish("builder", "pr", {...pr, branch: c.id}, unit);await run.publish("builder", "build_result", buildResult, unit);await run.end("builder", unit);
    const body = assessment();if (c.id === "C2") body.item_assessments = [body.item_assessments[0]];
    await run.publish("assessor", "assessment", body, unit);await run.end("assessor", unit);await run.decide("assessment_review", "accept", "assessment", {entries: [], added_actions: [], builder_feedback: ""}, unit);
    await run.decide("merge_confirmation", "confirm_merged", "pr", {}, unit);
  }
  expect(run.wanted("integrator", "run/integration/oakridge").resolved.inputs).toMatchObject({requirements: spec().requirements});
});

test("assessment decisions declare typed adjudication only on accept and builder return", () => {
  const review = development.stages.cohort.reviews?.assessment_review;
  if (!review || "template" in review || "set" in review.decisions) throw new Error("Expected explicit review decisions");
  expect([review.decisions.accept.payload, review.decisions.request_build_changes.payload, review.decisions.request_assessment_changes.payload, review.decisions.request_build_changes.feedback_field]).toEqual(["adjudication", "adjudication", undefined, "builder_feedback"]);
});

test("duplicate additional finding ids are refused", async () => {
  const body = assessment();
  const finding = {id: "F1", severity: "info" as const, observation: "Note", related_build_item_ids: [], evidence: [] as []};
  body.additional_findings = [finding, finding];
  expect(validationFeedback(await assessmentRun(body))).toContain("Additional finding ids must be unique.");
});
