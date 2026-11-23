import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { compileWorkflow } from "../../oakridge-dbos/src/core-client/client";
import type { Event, StepSnapshot } from "../../oakridge-dbos/src/core-client/core-types";
import authoredPlan from "../samples/study-fact-shapes-plan.json";
import { core, expandedPrompts, repository, root, workspace, readAuthoredWorkflow } from "./development-test-support";

const study = readAuthoredWorkflow("study");
const fixture = { ...authoredPlan, full_study_repeats: 2 };

const prompts = expandedPrompts(study);
const STAGE = "design";
const unit = "run/unit";
const design = study.stages[STAGE];
const input = design.input;
if (typeof input === "string") throw new Error("Expected record stage input");

const workflow = {
  ...study,
  label: undefined,
  input,
  run: {
    units: { unit: { stage: STAGE, input: Object.fromEntries(Object.keys(input).map(key => [key, `input.${key}`])) } },
    outcome: {},
  },
};

type Plan = typeof fixture;
interface SliceLimits {
  slice_case_limit: number;
  slice_cap_cents: number;
}
const defaultLimits: SliceLimits = { slice_case_limit: 6, slice_cap_cents: 1000 };

async function launchPlan(plan: Plan, limits = defaultLimits) {
  const compiled = await compileWorkflow(core, { workflow, prompts });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const digest = compiled.value.digest;

  async function step(snapshot: StepSnapshot, event: Event) {
    const result = await core.request("step", {
      workflow_digest: digest, snapshot, incoming: { event, writer: { kind: "engine" } },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (result.value.kind !== "stepped") throw new Error("Expected step result");
    return result.value.value;
  }

  const empty: StepSnapshot = {
    run: { id: "run", root: "run" }, units: [], attempts: [], revisions: [], decisions: [], retry_events: [],
  };
  const launched = await step(empty, {
    kind: "launched",
    input: { spec: fixture.question, repository, workspace, ...limits, approved_plan: null },
  });
  const designer = launched.snapshot.attempts.find(attempt =>
    attempt.unit === unit && attempt.worker === "designer" && attempt.status.kind === "pending"
  );
  if (!designer) throw new Error("Missing pending designer attempt");
  const published = await step(launched.snapshot, {
    kind: "revision_published", unit, artifact: "plan", body: plan,
    by: { action: designer.action_id, seq: designer.seq }, predecessor: null, subject: null,
  });
  const revision = published.snapshot.revisions.find(revision => revision.unit === unit && revision.artifact === "plan");
  if (!revision) throw new Error("Missing plan revision");
  return {
    decisions: published.snapshot.decisions.filter(decision => decision.target === revision.id),
    review: published.reviews.find(review => review.unit === unit && review.review === "plan_review" && review.target === revision.id),
  };
}

const checks = {
  nonemptyOutcomes: "len(plan.outcomes) > 0",
  nonemptyDecisionRule: "len(plan.decision_rule) > 0",
  nonemptyCriteria: "len(plan.pilot_selection.criteria) > 0",
  nonemptyTriggers: "len(plan.iteration_triggers) > 0",
  positiveFullRepeats: "plan.full_study_repeats > 0",
  nonemptyPlan: "len(plan.cases) > 0 and len(plan.hypotheses) > 0",
  knownSliceCases: "every(plan.pilot_selection.case_ids, contains(map(plan.cases, item.id), item))",
  sliceCaseLimit: "len(plan.pilot_selection.case_ids) <= input.slice_case_limit",
  sliceControl: "len(filter(plan.cases, item.is_control == true)) == 0 or len(filter(plan.cases, item.is_control == true and contains(plan.pilot_selection.case_ids, item.id))) > 0",
  paidCap: "plan.slice_paid.cap_cents > 0 and plan.slice_paid.cap_cents <= input.slice_cap_cents",
  uniqueCaseIds: "unique(map(plan.cases, item.id))",
  uniqueMembership: "unique(flatten(map(plan.groups, item.case_ids)))",
  knownGroupCases: "every(flatten(map(plan.groups, item.case_ids)), contains(map(plan.cases, item.id), item))",
  declaredMembership: "every(plan.cases, contains(map(plan.groups, item.id), item.group) and contains(require(lookup(plan.groups, id, item.group)).case_ids, item.id))",
  knownPaidModels: "every(plan.slice_paid.paid_model_ids, contains(map(plan.planned_models, item.id), item))",
  uniqueGroupAndHypothesisIds: "unique(map(plan.groups, item.id)) and unique(map(plan.hypotheses, item.id))",
  nonemptySlice: "len(plan.pilot_selection.case_ids) > 0",
  nonemptyPaidModels: "len(plan.slice_paid.paid_model_ids) > 0",
  positiveRepeats: "plan.slice_paid.repeats > 0",
  distinctCriteriaAndTriggers: "unique(map(plan.pilot_selection.criteria, item.id)) and unique(map(plan.iteration_triggers, item.id)) and every(plan.pilot_selection.criteria, not contains(map(plan.iteration_triggers, item.id), item.id))",
};
type PlanCheck = keyof typeof checks;

function expectedMessage(check: PlanCheck): string {
  const validation = design.artifacts.plan.validate?.find(entry => entry.check === checks[check]);
  if (!validation) throw new Error(`Missing plan validation check: ${check}`);
  return validation.message;
}

test("study offers approval for the fact-shapes plan with six slice cases", async () => {
  const { decisions, review } = await launchPlan(structuredClone(fixture));
  expect(decisions.filter(decision => decision.kind === "validation")).toEqual([]);
  const accept = review?.decisions.find(decision => decision.decision === "accept" && decision.target === review.target);
  expect(accept && (accept.is_available ?? true)).toBe(true);
});

interface RefusalCase {
  name: string;
  change?: (plan: Plan) => void;
  limits?: Partial<SliceLimits>;
  expected_check: readonly PlanCheck[];
}

const stageAdd = "fact-shapes-stage-additive";
const stageRename = "fact-shapes-stage-rename";
const refusals: RefusalCase[] = [
  { name: "no outcomes", change: plan => { plan.outcomes = []; }, expected_check: ["nonemptyOutcomes"] },
  { name: "no decision rules", change: plan => { plan.decision_rule = []; }, expected_check: ["nonemptyDecisionRule"] },
  { name: "no slice criteria", change: plan => { plan.pilot_selection.criteria = []; }, expected_check: ["nonemptyCriteria"] },
  { name: "no triggers", change: plan => { plan.iteration_triggers = []; }, expected_check: ["nonemptyTriggers"] },
  { name: "zero full-study repeats", change: plan => { plan.full_study_repeats = 0; }, expected_check: ["positiveFullRepeats"] },
  {
    name: "no hypotheses",
    change: plan => { plan.hypotheses = []; },
    expected_check: ["nonemptyPlan"],
  },
  {
    name: "no cases",
    change: plan => { plan.cases = []; plan.groups = []; plan.pilot_selection.case_ids = []; },
    expected_check: ["nonemptyPlan", "nonemptySlice"],
  },
  {
    name: "unknown slice case",
    change: plan => { plan.pilot_selection.case_ids[1] = `${stageAdd}.ghost`; },
    expected_check: ["knownSliceCases"],
  },
  {
    name: "more slice cases than allowed",
    limits: { slice_case_limit: 5 },
    expected_check: ["sliceCaseLimit"],
  },
  {
    name: "slice with no control",
    change: plan => { plan.pilot_selection.case_ids = plan.pilot_selection.case_ids.filter(id => id !== `${stageAdd}.type_enforced`); },
    expected_check: ["sliceControl"],
  },
  {
    name: "zero paid slice cap",
    change: plan => { plan.slice_paid.cap_cents = 0; },
    expected_check: ["paidCap"],
  },
  {
    name: "paid slice cap above the input limit",
    limits: { slice_cap_cents: 999 },
    expected_check: ["paidCap"],
  },
  {
    name: "case missing from its group",
    change: plan => { plan.groups[0].case_ids.pop(); },
    expected_check: ["declaredMembership"],
  },
  {
    name: "case also listed by a second group",
    change: plan => { plan.groups[1].case_ids.push(`${stageAdd}.reference`); },
    expected_check: ["uniqueMembership"],
  },
  {
    name: "unknown case listed by a group",
    change: plan => { plan.groups[1].case_ids.push(`${stageRename}.ghost`); },
    expected_check: ["knownGroupCases"],
  },
  {
    name: "duplicate case id",
    change: plan => { plan.cases.push(plan.cases[0]); },
    expected_check: ["uniqueCaseIds"],
  },
  {
    name: "unknown paid slice model",
    change: plan => { plan.slice_paid.paid_model_ids.push("ghost"); },
    expected_check: ["knownPaidModels"],
  },
  {
    name: "duplicate hypothesis id",
    change: plan => { plan.hypotheses.push(plan.hypotheses[0]); },
    expected_check: ["uniqueGroupAndHypothesisIds"],
  },
  {
    name: "no paid slice models",
    change: plan => { plan.slice_paid.paid_model_ids = []; },
    expected_check: ["nonemptyPaidModels"],
  },
  {
    name: "zero paid slice repeats",
    change: plan => { plan.slice_paid.repeats = 0; },
    expected_check: ["positiveRepeats"],
  },
  {
    name: "a criterion and iteration trigger sharing an id",
    change: plan => { plan.iteration_triggers[0].id = plan.pilot_selection.criteria[0].id; },
    expected_check: ["distinctCriteriaAndTriggers"],
  },
];

for (const { name, change, limits, expected_check } of refusals) {
  test(`study refuses a plan with ${name}`, async () => {
    const plan = structuredClone(fixture);
    change?.(plan);
    const { decisions } = await launchPlan(plan, { ...defaultLimits, ...limits });
    const messages = decisions.filter(decision => decision.kind === "validation").map(decision => decision.messages);
    expect(messages).toEqual([expected_check.map(expectedMessage)]);
  });
}


test("the design prompt includes every plan validation message", () => {
  const prompt = readFileSync(resolve(root, "workflow-config/prompts/study/design.md"), "utf8");
  expect(design.artifacts.plan.validate?.filter(({ message }) => !prompt.includes(message))).toEqual([]);
});

test("study hosts appear only in executing role includes", () => {
  const directory = resolve(root, "workflow-config/prompts/study");
  for (const file of readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
    const text = readFileSync(resolve(file.parentPath, file.name), "utf8");
    expect(text).not.toMatch(/assay/);
    if (!file.parentPath.endsWith("/shared") || !file.name.startsWith("hosts-")) expect(text).not.toMatch(/otto|mcclure/);
  }
  for (const [path, prompt] of Object.entries(prompts)) {
    if (/^study\/(design|slice-assess|expand-assess|integrate)/.test(path)) expect(prompt).not.toMatch(/otto|mcclure/);
  }
});

interface ValidationPublication {
  readonly worker: string;
  readonly artifact: string;
  readonly body: unknown;
  readonly subject?: string | null;
}

async function validationRun(stageName: string, stageInput: object) {
  const stage = study.stages[stageName];
  if (typeof stage.input === "string") throw new Error("Expected a record input");
  const source = { ...study, label: undefined, input: stage.input, run: {
    units: { unit: { stage: stageName, input: Object.fromEntries(Object.keys(stage.input).map((key) => [key, `input.${key}`])) } }, outcome: {},
  } };
  const compiled = await compileWorkflow(core, { workflow: source, prompts });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const digest = compiled.value.digest;
  const empty: StepSnapshot = { run: { id: "run", root: "run" }, units: [], attempts: [], revisions: [], decisions: [], retry_events: [] };
  async function apply(snapshot: StepSnapshot, event: Event): Promise<StepSnapshot> {
    const result = await core.request("step", { workflow_digest: digest, snapshot, incoming: { event, writer: { kind: "engine" } } });
    if (!result.ok || result.value.kind !== "stepped") throw new Error(JSON.stringify(result));
    return result.value.value.snapshot;
  }
  const launched = await apply(empty, { kind: "launched", input: stageInput });
  const latest = (snapshot: StepSnapshot, artifact: string) =>
    snapshot.revisions.filter((revision) => revision.unit === unit && revision.artifact === artifact).at(-1);
  async function publish(snapshot: StepSnapshot, publication: ValidationPublication) {
    const { worker, artifact, body, subject = null } = publication;
    const producer = snapshot.attempts.filter((attempt) => attempt.unit === unit && attempt.worker === worker).at(-1);
    if (!producer) throw new Error(`Missing producer ${worker}`);
    const published = await apply(snapshot, { kind: "revision_published", unit, artifact, body, subject,
      by: { action: producer.action_id, seq: producer.seq }, predecessor: latest(snapshot, artifact)?.id ?? null });
    const revision = latest(published, artifact);
    const messages = published.decisions.flatMap((decision) =>
      decision.kind === "validation" && decision.target === revision?.id ? decision.messages : []);
    return { published, revision, messages };
  }
  async function complete(snapshot: StepSnapshot, publication: ValidationPublication) {
    const { published, messages } = await publish(snapshot, publication);
    if (messages.length) throw new Error(messages.join("\n"));
    const action = published.attempts.filter((attempt) => attempt.unit === unit && attempt.worker === publication.worker).at(-1);
    if (!action) throw new Error(`Missing attempt ${publication.worker}`);
    return apply(published, { kind: "worker_ended", action: action.action_id, result: { kind: "succeeded" } });
  }
  async function approve(snapshot: StepSnapshot, review: string, decision: string, artifact: string) {
    const target = latest(snapshot, artifact);
    if (!target) throw new Error(`Missing ${artifact}`);
    return apply(snapshot, { kind: "operator_decided", unit, review, decision, target: target.id, payload: {} });
  }
  return { launched, latest, publish, complete, approve };
}

const digest = "test_digest";
const digest_recipe = { files: ["generate.py"], digest_command: "sha256sum generate.py" };
const build = (cohort_id: string) => ({ cohort_id, title: cohort_id, head_sha: "head", summary: "Worked", changed_files: [] });
const qualification = (case_id: string) => ({ case_id, reference_passes: true, omissions_isolated: true, controls_replayed: true, detail: "Qualified" });
const plannedCase = fixture.pilot_selection.case_ids[0];
const sliceBuild = { build: build("slice"), generator_digest: digest, case_ids: fixture.pilot_selection.case_ids,
  qualifications: fixture.pilot_selection.case_ids.map(qualification), digest_recipe };
const spendRequest = { cohort_file: "slice.json", attempt_count: 1, cap_cents: fixture.slice_paid.cap_cents,
  generator_digest: digest, case_ids: fixture.pilot_selection.case_ids };
const paidResult = { case_id: plannedCase, model_id: fixture.slice_paid.paid_model_ids[0], outcome: "scored", detail: "Scored", spend_cents: 1,
  launch_command: "run", store_path: "/runs/test" };
const sliceReport = { generator_digest: digest, run_key: "test", qualifications: sliceBuild.qualifications,
  paid_results: [paidResult], criteria_marks: fixture.pilot_selection.criteria.map(({ id }) => ({ id, status: "met", evidence: "Measured" })),
  trigger_marks: fixture.iteration_triggers.map(({ id }) => ({ id, status: "not_fired", evidence: "Measured" })), proposed_changes: [] };
const assessItem = (kind: string, id: string, status = "met") =>
  ({ subject: { kind, id }, status, observation: "Verified", evidence: [{ kind: "test", ref: id }] });
const baseAssessment = (item_assessments: readonly ReturnType<typeof assessItem>[]) => ({
  head_sha: "head", item_assessments, additional_findings: [], proposals: [], verifications: [],
  test_evidence: { passed: 1, failed: 0 }, verdict: "pass",
});
const sliceAssessment = { ...baseAssessment([
  ...fixture.pilot_selection.criteria.map(({ id }) => assessItem("criterion", id)),
  ...fixture.iteration_triggers.map(({ id }) => assessItem("trigger", id, "not_met")),
  assessItem("case", plannedCase),
]), run_key: sliceReport.run_key };
const findings = (kind: string, id: string) =>
  [{ id: "finding", severity: "info", observation: "Linked", evidence: [], related_subjects: [{ kind, id }] }];
const studyPr = { change_request_link: "https://github.com/acme/study/pull/1", summary: "Built", branch: "slice" };

test("slice qualification, paid evidence, and task-link checks report specific refusals", async () => {
  const harness = await validationRun("design", { spec: fixture.question, repository, workspace, ...defaultLimits, approved_plan: null });
  const designed = await harness.complete(harness.launched, { worker: "designer", artifact: "plan", body: fixture });
  const approved = await harness.approve(designed, "plan_review", "accept", "plan");
  const buildPublication = { worker: "slice_builder", artifact: "slice_build" };
  for (const flag of ["reference_passes", "omissions_isolated", "controls_replayed"] as const) {
    const qualifications = sliceBuild.qualifications.map((entry, index) => index === 0 ? { ...entry, [flag]: false } : entry);
    expect((await harness.publish(approved, { ...buildPublication, body: { ...sliceBuild, qualifications } })).messages)
      .toContain("Every slice case must pass qualification: reference passes, omissions isolated and controls replayed.");
  }
  const built = await harness.publish(approved, { ...buildPublication, body: sliceBuild });
  expect(built.messages).toEqual([]);
  const delivered = await harness.complete(built.published, { worker: "slice_builder", artifact: "pr", body: studyPr });
  const requested = await harness.complete(delivered, { worker: "spend_requester", artifact: "spend_request", body: spendRequest, subject: built.revision?.id });
  const authorized = await harness.approve(requested, "spend_request_review", "approve", "spend_request");
  const reportPublication = { worker: "slice_runner", artifact: "slice_report", subject: harness.latest(authorized, "spend_request")?.id };
  const reportRefusals = [
    [{ ...sliceReport, paid_results: [] }, "The paid run produced no results. Revise the report from the same execution; do not request new spend."],
    [{ ...sliceReport, paid_results: [{ ...paidResult, model_id: "unknown" }] }, "Paid results may name only the plan's paid slice models."],
    [{ ...sliceReport, paid_results: [paidResult, paidResult] }, "A report may hold at most the approved attempt count of results."],
    [{ ...sliceReport, criteria_marks: [...sliceReport.criteria_marks, { id: "unknown", status: "met", evidence: "Measured" }] },
      "Criterion marks may name only plan slice criteria."],
    [{ ...sliceReport, trigger_marks: [...sliceReport.trigger_marks, { id: "unknown", status: "not_fired", evidence: "Measured" }] },
      "Trigger marks may name only plan iteration triggers."],
  ] as const;
  for (const [body, message] of reportRefusals) {
    expect((await harness.publish(authorized, { ...reportPublication, body })).messages).toContain(message);
  }
  const reported = await harness.complete(authorized, { ...reportPublication, body: sliceReport });
  const assessmentPublication = { worker: "slice_assessor", artifact: "slice_assessment", subject: harness.latest(reported, "slice_report")?.id };
  expect((await harness.publish(reported, { ...assessmentPublication, body: sliceAssessment })).messages).toEqual([]);
  const allowed = [
    ["case", plannedCase, "Case subjects and related subjects must resolve within the reviewed scope."],
    ["criterion", fixture.pilot_selection.criteria[0].id, "Criterion subjects and related subjects must resolve within the reviewed scope."],
    ["trigger", fixture.iteration_triggers[0].id, "Trigger subjects and related subjects must resolve within the reviewed scope."],
    ["cohort_file", "unknown", "Slice assessments cannot link cohort_file subjects."],
  ] as const;
  for (const [kind, id, message] of allowed) {
    if (kind !== "cohort_file") expect((await harness.publish(reported, { ...assessmentPublication,
      body: { ...sliceAssessment, additional_findings: findings(kind, id) } })).messages).toEqual([]);
    for (const extra of [
      { item_assessments: [...sliceAssessment.item_assessments, assessItem(kind, "unknown")] },
      { additional_findings: findings(kind, "unknown") },
    ]) expect((await harness.publish(reported, { ...assessmentPublication, body: { ...sliceAssessment, ...extra } })).messages).toContain(message);
  }
});

const coveringFreeze = { build: build("freeze"), generator_digest: digest, image_digest: "image", is_byte_identical: true,
  cohorts: [{ id: "full", file: "full.json", digest: "manifest", attempt_count: 10, cap_cents: 10,
    cost_basis: "measured", case_ids: fixture.cases.map(({ id }) => id), groups: fixture.groups.map(({ id }) => id) }] };

test("freeze requires exactly the plan case set and coverage for every plan group", async () => {
  const harness = await validationRun("freeze", { plan: fixture, generator_digest: digest, digest_recipe,
    slice_report: sliceReport, expansions: [], repository, workspace });
  const [covering] = coveringFreeze.cohorts;
  const check = (cohort: typeof covering) => harness.publish(harness.launched, {
    worker: "freezer", artifact: "freeze", body: { ...coveringFreeze, cohorts: [cohort] },
  });
  expect((await check(covering)).messages).toEqual([]);
  for (const case_ids of [covering.case_ids.slice(1), [...covering.case_ids, "unknown"]]) {
    expect((await check({ ...covering, case_ids })).messages).toContain("The frozen cohorts' cases must be exactly the plan's cases.");
  }
  expect((await check({ ...covering, groups: covering.groups.slice(1) })).messages).toContain("Every plan group must be named by a frozen cohort.");
  expect((await check({ ...covering, groups: [...covering.groups, "unknown"] })).messages).toContain("Frozen cohorts may name only plan groups.");
});

test("expansion and integration resolve their task links against their own inputs", async () => {
  const group = fixture.groups[0];
  const expansionHarness = await validationRun("expand", { group_id: group.id, case_ids: group.case_ids,
    generator_digest: digest, digest_recipe, plan: fixture, repository, workspace });
  const body = { build: build(group.id), generator_digest: digest, case_ids: group.case_ids, qualifications: group.case_ids.map(qualification) };
  const expanded = await expansionHarness.publish(expansionHarness.launched, { worker: "expander", artifact: "expansion", body });
  expect(expanded.messages).toEqual([]);
  expect((await expansionHarness.publish(expansionHarness.launched, { worker: "expander", artifact: "expansion",
    body: { ...body, qualifications: [...body.qualifications, qualification("unknown")] } })).messages)
    .toContain("Expansion qualifications must name allocated case ids.");
  const finished = await expansionHarness.complete(expanded.published, { worker: "expander", artifact: "pr", body: studyPr });
  const expansionItems = group.case_ids.map((id) => assessItem("case", id));
  const checkExpansion = (extra: object) => expansionHarness.publish(finished, { worker: "assessor", artifact: "assessment",
    subject: expanded.revision?.id, body: { ...baseAssessment(expansionItems), ...extra } });
  expect((await checkExpansion({ additional_findings: findings("case", group.case_ids[0]) })).messages).toEqual([]);
  for (const extra of [{ item_assessments: [...expansionItems, assessItem("case", "unknown")] }, { additional_findings: findings("case", "unknown") }]) {
    expect((await checkExpansion(extra)).messages).toContain("Expansion case subjects and related subjects must resolve to allocated cases.");
  }

  const cohort = { repository_key: repository.key, ...studyPr, build_result: build("slice") };
  const integration = await validationRun("integration", { cases: fixture.cases, freeze: coveringFreeze,
    slice_cohort: cohort, expansion_cohorts: [], freeze_cohort: cohort, repository, workspace, final_merge_policy: "require_merge" });
  const publishedPr = await integration.publish(integration.launched, { worker: "integrator", artifact: "pr", body: studyPr });
  const integrated = [...fixture.cases.map(({ id }) => assessItem("case", id)), assessItem("cohort_file", "full")];
  const checkIntegration = (extra: object) => integration.publish(publishedPr.published, { worker: "integrator", artifact: "assessment",
    subject: publishedPr.revision?.id, body: { ...baseAssessment(integrated), ...extra } });
  for (const [kind, id, message] of [
    ["case", fixture.cases[0].id, "Case subjects and related subjects must resolve within the reviewed scope."],
    ["cohort_file", "full", "Cohort_file subjects and related subjects must resolve within the reviewed scope."],
  ]) {
    expect((await checkIntegration({ additional_findings: findings(kind, id) })).messages).toEqual([]);
    for (const extra of [{ item_assessments: [...integrated, assessItem(kind, "unknown")] }, { additional_findings: findings(kind, "unknown") }]) {
      expect((await checkIntegration(extra)).messages).toContain(message);
    }
  }
});
