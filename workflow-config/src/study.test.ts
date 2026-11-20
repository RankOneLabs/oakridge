import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { compileWorkflow } from "../../oakridge-dbos/src/core-client/client";
import type { Event, StepSnapshot } from "../../oakridge-dbos/src/core-client/core-types";
import { decodeWorkflowSource } from "../../oakridge-dbos/src/core-client/source-types";
import fixture from "../samples/study-fact-shapes-plan.json";
import { core, expandedPrompts, repository, root, workspace } from "./development-test-support";

const study = decodeWorkflowSource(YAML.parse(readFileSync(resolve(root, "workflow-config/study.yaml"), "utf8")));
if (!study) throw new Error("Invalid study source");

const prompts = expandedPrompts(study);
const STAGE = "design";
const unit = "run/unit";
const design = study.stages[STAGE];
const input = design.input;
if (typeof input === "string") throw new Error("Expected record stage input");

const workflow = {
  ...study,
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
    by: designer.action_id, predecessor: null, subject: null,
  });
  const revision = published.snapshot.revisions.find(revision => revision.unit === unit && revision.artifact === "plan");
  if (!revision) throw new Error("Missing plan revision");
  return {
    decisions: published.snapshot.decisions.filter(decision => decision.target === revision.id),
    review: published.reviews.find(review => review.unit === unit && review.review === "plan_review" && review.target === revision.id),
  };
}

const checks = {
  nonemptyPlan: "len(plan.cases) > 0 and len(plan.hypotheses) > 0",
  knownSliceCases: "every(plan.slice.case_ids, contains(map(plan.cases, item.id), item))",
  sliceCaseLimit: "len(plan.slice.case_ids) <= input.slice_case_limit",
  sliceControl: "len(filter(plan.cases, item.is_control == true)) == 0 or len(filter(plan.cases, item.is_control == true and contains(plan.slice.case_ids, item.id))) > 0",
  paidCap: "plan.slice_paid.cap_cents > 0 and plan.slice_paid.cap_cents <= input.slice_cap_cents",
  uniqueCaseIds: "unique(map(plan.cases, item.id))",
  uniqueMembership: "unique(flatten(map(plan.groups, item.case_ids)))",
  knownGroupCases: "every(flatten(map(plan.groups, item.case_ids)), contains(map(plan.cases, item.id), item))",
  declaredMembership: "every(plan.cases, contains(map(plan.groups, item.id), item.group) and contains(require(lookup(plan.groups, id, item.group)).case_ids, item.id))",
  knownPaidModels: "every(plan.slice_paid.models, contains(map(plan.models, item.id), item))",
  uniqueGroupAndHypothesisIds: "unique(map(plan.groups, item.id)) and unique(map(plan.hypotheses, item.id))",
  nonemptySlice: "len(plan.slice.case_ids) > 0",
  nonemptyPaidModels: "len(plan.slice_paid.models) > 0",
  positiveRepeats: "plan.slice_paid.repeats > 0",
  distinctCriteriaAndTriggers: "unique(map(plan.slice.criteria, item.id)) and unique(map(plan.iteration_triggers, item.id)) and every(plan.slice.criteria, not contains(map(plan.iteration_triggers, item.id), item.id))",
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
  {
    name: "no hypotheses",
    change: plan => { plan.hypotheses = []; },
    expected_check: ["nonemptyPlan"],
  },
  {
    name: "no cases",
    change: plan => { plan.cases = []; plan.groups = []; plan.slice.case_ids = []; },
    expected_check: ["nonemptyPlan", "nonemptySlice"],
  },
  {
    name: "unknown slice case",
    change: plan => { plan.slice.case_ids[1] = `${stageAdd}.ghost`; },
    expected_check: ["knownSliceCases"],
  },
  {
    name: "more slice cases than allowed",
    limits: { slice_case_limit: 5 },
    expected_check: ["sliceCaseLimit"],
  },
  {
    name: "slice with no control",
    change: plan => { plan.slice.case_ids = plan.slice.case_ids.filter(id => id !== `${stageAdd}.type_enforced`); },
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
    change: plan => { plan.slice_paid.models.push("ghost"); },
    expected_check: ["knownPaidModels"],
  },
  {
    name: "duplicate hypothesis id",
    change: plan => { plan.hypotheses.push(plan.hypotheses[0]); },
    expected_check: ["uniqueGroupAndHypothesisIds"],
  },
  {
    name: "no paid slice models",
    change: plan => { plan.slice_paid.models = []; },
    expected_check: ["nonemptyPaidModels"],
  },
  {
    name: "zero paid slice repeats",
    change: plan => { plan.slice_paid.repeats = 0; },
    expected_check: ["positiveRepeats"],
  },
  {
    name: "a criterion and iteration trigger sharing an id",
    change: plan => { plan.iteration_triggers[0].id = plan.slice.criteria[0].id; },
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
