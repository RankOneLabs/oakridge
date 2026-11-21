import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { CoreClient, compileWorkflow } from "../src/core-client/client";
import type { ParsedWorkflow, StepSnapshot } from "../src/core-client/core-types";
import { decodeWorkflowSource, type WorkflowDefinitionDescriptor } from "../src/core-client/source-types";
import { composePrompts, referencedPromptPaths } from "../src/runtime/definition-store";
import { selectAvailableDecisions } from "../src/projections/unit-view";
import type { RunSummaryRead, UnitSummaryRecord } from "../src/storage/read-store";
import { selectAdjudicationRefusal } from "../src/storage/commit";
import { composeReworkFeedback, isAdjudicatedArtifact, selectAdjudicatedReview, selectRecordedAdjudication, selectReviewedAssessmentId, validateAdjudication, type AdjudicatedReviewDecision, type Adjudication } from "../src/domain/adjudication";

import { dropRework, target, validAdjudication } from "./adjudication-fixture";

/** Decisions as development and study declare them on their adjudicated reviews. */
const adjudicated = (key: string, effect: AdjudicatedReviewDecision["effect"]): AdjudicatedReviewDecision => ({ key, effect, adjudication: effect === "approve" ? "accept" : "feedback", fields: [] });
const DECLARED = {
  accept: adjudicated("accept", "approve"),
  request_build_changes: adjudicated("request_build_changes", "request_changes"),
  request_changes: adjudicated("request_changes", "request_changes"),
  send_to_expander: adjudicated("send_to_expander", "request_changes"),
  request_assessment_changes: { key: "request_assessment_changes", effect: "request_changes", adjudication: null, fields: ["feedback"] },
} as const satisfies Record<string, AdjudicatedReviewDecision>;
type DeclaredDecision = keyof typeof DECLARED;
const validate = (payload: unknown, decision: DeclaredDecision = "request_build_changes") => validateAdjudication({ payload, assessment: target, decision: DECLARED[decision] });
const actionId = target.body.next_actions[0].id;
test("accepts accepted, modified, rejected and added actions across audiences", () => expect(validate(validAdjudication()).ok).toBe(true));
test("feedback includes builder actions in order and omits rejected and operator actions", () => expect(validAdjudication().rework_feedback).toBe([
  `${actionId}: first`, `${target.body.next_actions[1].id}: replacement`, "10000000-0000-4000-8000-000000000000: added",
].join("\n")));
test("empty builder actions compose to an empty string", () => expect(composeReworkFeedback([], [])).toBe(""));
test("wire entry order cannot change next_actions feedback order", () => {
  const payload = validAdjudication();
  expect(validate({ ...payload, entries: [...payload.entries].reverse() }).ok).toBe(true);
});
interface RefusalCase { name: string; mutate: (payload: Adjudication) => unknown; id: string; effect?: DeclaredDecision }
const refusalCases: RefusalCase[] = [
  { name: "payload on assessment changes", mutate: p => p, id: target.id, effect: "request_assessment_changes" },
  ...(["accept", "request_build_changes", "request_changes", "send_to_expander"] as const).map(effect => ({ name: `missing payload on ${effect}`, mutate: () => null, id: target.id, effect })),
  { name: "missing action", mutate: p => ({ ...p, entries: p.entries.slice(1) }), id: actionId },
  { name: "duplicate action", mutate: p => ({ ...p, entries: [...p.entries, p.entries[0]] }), id: actionId },
  { name: "unknown action", mutate: p => ({ ...p, entries: [{ ...p.entries[0], action_id: "unknown" }, ...p.entries.slice(1)] }), id: "unknown" },
  ...(["original_text", "audience", "source"] as const).map(field => ({ name: `mismatched ${field}`, id: actionId,
    mutate: (p: Adjudication) => ({ ...p, entries: [{ ...p.entries[0], [field]: field === "source" ? { kind: "additional_finding", id: "F1" } : field === "audience" ? "operator" : "different" }, ...p.entries.slice(1)] }) })),
  { name: "modified without final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], disposition: "modified" }, ...p.entries.slice(1)] }), id: actionId },
  { name: "modified with blank final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], disposition: "modified", final_text: "  " }, ...p.entries.slice(1)] }), id: actionId },
  { name: "accepted with changed final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], final_text: "different" }, ...p.entries.slice(1)] }), id: actionId },
  { name: "unresolvable added source", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], source: { kind: "item_assessment", id: "missing" } }] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "non UUID added id", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], action_id: "bad" }] }), id: "bad" },
  { name: "duplicate added id", mutate: p => ({ ...p, added_actions: [...p.added_actions, p.added_actions[0]] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "added id collides with assessor action", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], action_id: actionId }] }), id: actionId },
  { name: "blank added text", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], final_text: " " }] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "empty builder feedback", mutate: p => ({ ...p, rework_feedback: "" }), id: target.id, effect: "request_build_changes" },
  { name: "absent builder feedback", mutate: p => ({ ...p, rework_feedback: undefined }), id: target.id, effect: "request_build_changes" },
  { name: "forged builder feedback", mutate: p => ({ ...p, rework_feedback: "forged" }), id: target.id },
];
for (const entry of refusalCases) test(`refuses ${entry.name} with entity context`, () => {
  const result = validate(entry.mutate(validAdjudication()), entry.effect);
  expect(result.ok ? null : { operation: result.error.operation, id: result.error.entity_id }).toEqual({ operation: "validate_adjudication", id: entry.id });
});
test("all builder actions rejected permits accept but forbids requesting changes", () => {
  const payload = validAdjudication();
  const entries = payload.entries.map(entry => ({ ...entry, disposition: "rejected" as const }));
  const empty = { entries, added_actions: [], rework_feedback: "" };
  expect([validate(empty, "accept").ok, validate(empty, "request_build_changes").ok, validate(empty, "request_changes").ok, validate(empty, "send_to_expander").ok])
    .toEqual([true, false, false, false]);
});
test("assessment change feedback retains legacy fields without adjudication", () => expect(validate({ feedback: "Reassess" }, "request_assessment_changes").ok).toBe(true));

test("redirected decisions resolve the assessment that existed when the event was recorded", () => {
  const revisions = [
    { id: "build:1", unit_id: "unit", artifact: "build_result", seq: 1, created_at: new Date(0) },
    { id: "assessment:1", unit_id: "unit", artifact: "assessment", seq: 1, created_at: new Date(1) },
    { id: "assessment:2", unit_id: "unit", artifact: "assessment", seq: 2, created_at: new Date(3) },
  ];
  const review = { assessment_artifact: "assessment", decisions: [DECLARED.accept, DECLARED.request_build_changes] };
  expect(selectReviewedAssessmentId({ decision: { review: "assessment_review", unit_id: "unit", target_revision_id: "build:1", created_at: new Date(2) }, review, revisions })).toBe("assessment:1");
});
test("a send-back resolves its assessment through whichever artifact the review declares it redirects to", () => {
  const revisions = [
    { id: "expansion:1", unit_id: "unit", artifact: "expansion", seq: 1 },
    { id: "assessment:1", unit_id: "unit", artifact: "assessment", seq: 1 },
  ];
  const review = { assessment_artifact: "assessment", decisions: [DECLARED.accept, DECLARED.send_to_expander] };
  const decision = { review: "expansion_review", unit_id: "unit", target_revision_id: "expansion:1" };
  expect([selectReviewedAssessmentId({ decision, review, revisions }), selectReviewedAssessmentId({ decision, review: null, revisions })]).toEqual(["assessment:1", null]);
});

const acceptRefusal = "accept cannot keep rework actions; drop them or send them";
const detail = (result: ReturnType<typeof validateAdjudication>) => result.ok ? null : result.error.detail;

for (const mode of ["accepted", "modified", "added"] as const) {
  test(`accept refuses ${mode} rework`, () => {
    const valid = validAdjudication();
    const dropped = dropRework(valid);
    const payload = mode === "added" ? { ...dropped, added_actions: valid.added_actions } :
      { ...dropped, entries: dropped.entries.map((entry, index) =>
        index === 0 ? { ...entry, disposition: mode, final_text: mode === "modified" ? "Edit" : entry.original_text } : entry) };
    expect(detail(validate(payload, "accept"))).toBe(acceptRefusal);
  });
}

test("accept keeps operator actions while dropping rework", () => {
  expect(validate(dropRework(validAdjudication()), "accept").ok).toBe(true);
});

test("feedback requires rework even when the supplied feedback is non-empty", () => {
  expect(detail(validate({ ...dropRework(validAdjudication()), rework_feedback: "forged" })))
    .toBe("feedback requires non-empty rework_feedback");
});

test("feedback must match the composed value", () => {
  expect(detail(validate({ ...validAdjudication(), rework_feedback: "forged" })))
    .toBe("rework_feedback differs from composeReworkFeedback");
});

test("builder is an invalid wire audience", () => {
  const payload = validAdjudication();
  expect(detail(validate({ ...payload, entries: [{ ...payload.entries[0], audience: "builder" }, ...payload.entries.slice(1)] })))
    .toBe("invalid adjudication payload");
});

for (const artifact of ["build_result", "slice_report", "slice_build"]) {
  test(`${artifact} resolves the latest assessment in the unit as of the decision`, () => {
    const review = { assessment_artifact: "assessment", decisions: [DECLARED.accept] };
    const revisions = [
      { id: "target", unit_id: "unit", artifact, seq: 1, created_at: new Date(1) },
      { id: "old", unit_id: "unit", artifact: "assessment", seq: 1, created_at: new Date(1) },
      { id: "current", unit_id: "unit", artifact: "assessment", seq: 2, created_at: new Date(2) },
      { id: "future", unit_id: "unit", artifact: "assessment", seq: 3, created_at: new Date(3) },
      { id: "other", unit_id: "other", artifact: "assessment", seq: 4, created_at: new Date(2) },
    ];
    const decision = { review: "review", unit_id: "unit", target_revision_id: "target", created_at: new Date(2) };
    expect(selectReviewedAssessmentId({ decision, review, revisions })).toBe("current");
    expect(selectReviewedAssessmentId({ decision: { ...decision, target_revision_id: "old" }, review, revisions })).toBe("old");
  });
}

const promptRoot = resolve(import.meta.dir, "../../workflow-config/prompts");
const promptSources = Object.fromEntries(readdirSync(promptRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const path = resolve(entry.parentPath, entry.name);
    return [relative(promptRoot, path), readFileSync(path, "utf8")];
  }));

async function compile(source: WorkflowDefinitionDescriptor): Promise<ParsedWorkflow> {
  const core = unwrap(CoreClient.start());
  try {
    const composed = unwrap(composePrompts(referencedPromptPaths(source), promptSources));
    const prompts = Object.fromEntries(Object.entries(composed.prompts).map(([key, prompt]) => [key, prompt.text]));
    return unwrap(await compileWorkflow(core, { workflow: source, prompts })).workflow;
  } finally {
    core.close();
  }
}

function unwrap<Value>(result: { ok: true; value: Value } | { ok: false; error: unknown }): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function bundle(name: "development" | "study"): WorkflowDefinitionDescriptor {
  const source = decodeWorkflowSource(JSON.parse(readFileSync(resolve(import.meta.dir, `../../workflow-core/fixtures/bundles/${name}.json`), "utf8")));
  if (!source) throw new Error(`invalid ${name} source`);
  return source;
}

function snapshot(stage: string, assessment: string, artifacts: readonly string[]): Pick<StepSnapshot, "units" | "revisions"> {
  return {
    units: [{ id: "unit", kind: { kind: "stage", stage }, declaration: stage, after: [], status: { kind: "active" } }],
    revisions: [assessment, ...artifacts].map(artifact => ({ id: `${artifact}:1`, artifact, unit: "unit", seq: 1,
      body: artifact === assessment ? target.body : {} })),
  };
}

type DecisionCheck = Parameters<typeof selectAdjudicationRefusal>[0];
function refusal(check: Omit<DecisionCheck, "event">, review: string, decision: string, artifact: string, payload: unknown): string | null {
  return selectAdjudicationRefusal({ ...check, event: { kind: "operator_decided", unit: "unit", review, decision, target: `${artifact}:1`, payload } });
}

test("study slice decisions use the bound assessment and guard plain decisions before resolving it", async () => {
  const workflow = await compile(bundle("study"));
  const stage = workflow.stages.design;
  const review = selectAdjudicatedReview({ workflow, stage: "design", review: "slice_report_review" });
  expect(review?.assessment_artifact).toBe("slice_assessment");
  expect(isAdjudicatedArtifact(stage, "slice_assessment")).toBe(true);
  expect(isAdjudicatedArtifact(stage, "slice_report")).toBe(false);
  const check = { workflow, snapshot: snapshot("design", "slice_assessment", ["slice_report", "slice_build", "plan"]),
    expected_assessment_revision_id: undefined };
  const slice = "slice_report_review";
  const valid = validAdjudication();
  expect(refusal({ ...check, expected_assessment_revision_id: "slice_assessment:1" }, slice, "expand", "slice_report",
    { ...valid, entries: valid.entries.slice(1) })).toContain("every target action requires exactly one entry");
  expect(refusal(check, slice, "send_feedback_to_builder", "slice_build", valid)).toContain("expected_assessment_revision_id must match slice_assessment:1");
  expect(refusal({ ...check, expected_assessment_revision_id: "slice_assessment:1" }, slice, "send_feedback_to_builder", "slice_build", valid)).toBeNull();
  for (const [decision, artifact] of [["send_to_builder", "slice_build"], ["change_design", "plan"]]) {
    const plain = { ...check, snapshot: snapshot("design", "unused", [artifact]) };
    expect(refusal(plain, slice, decision, artifact, { feedback: "Fix X" })).toBeNull();
    expect(refusal({ ...plain, expected_assessment_revision_id: "slice_assessment:1" }, slice, decision, artifact, {}))
      .toContain("plain decision takes no assessment revision");
  }
  expect(refusal({ ...check, expected_assessment_revision_id: "old" }, "spend_request_review", "approve", "spend_request", {}))
    .toContain("plain decision takes no assessment revision");
});

test("unit decisions expose each role and the assessment bound to their review", async () => {
  const workflow = await compile(bundle("study"));
  const read = { definition: { parsed_workflow: workflow } } as RunSummaryRead;
  const unit = { id: "unit", stage: "design", declaration: "design" } as UnitSummaryRecord;
  const decisions = selectAvailableDecisions(read, unit, {
    unit_id: unit.id, blocked: null, run_stalls: [], stalled: [],
    awaiting: [
      { unit_id: unit.id, review: "slice_report_review", target: "report", prompt: "", decisions: [
        { decision: "expand", target: "report" }, { decision: "send_feedback_to_builder", target: "build" },
        { decision: "send_to_builder", target: "build" }, { decision: "change_design", target: "plan" },
      ] },
      { unit_id: unit.id, review: "spend_request_review", target: "spend", prompt: "",
        decisions: [{ decision: "approve", target: "spend" }] },
    ],
  });
  expect(decisions.map(({ key, adjudication, assessment }) => [key, adjudication, assessment])).toEqual([
    ["change_design", null, "slice_assessment"], ["expand", "accept", "slice_assessment"],
    ["send_feedback_to_builder", "feedback", "slice_assessment"], ["send_to_builder", null, "slice_assessment"],
    ["approve", null, null],
  ]);
});

test("a plain decision naming the adjudication schema carries no adjudication", async () => {
  const workflow = await compile(bundle("study"));
  const design = workflow.stages.design;
  const slice = design.reviews?.slice_report_review;
  if (!slice) throw new Error("missing slice review");
  const plain = { ...slice, assessment: null, decisions: { expand: { ...slice.decisions.expand, adjudication: null } } };
  const stage = { ...design, reviews: { plain } };
  const plainWorkflow = { ...workflow, stages: { design: stage } };
  expect(selectAdjudicatedReview({ workflow: plainWorkflow, stage: "design", review: "plain" })).toBeNull();
  const check = { workflow: plainWorkflow, snapshot: snapshot("design", "slice_assessment", ["slice_report"]), expected_assessment_revision_id: undefined };
  expect(refusal(check, "plain", "expand", "slice_report", validAdjudication())).toBeNull();
  expect(refusal(check, "plain", "expand", "slice_report", { ...validAdjudication(), stray: true }))
    .toContain("plain decision does not accept payload field stray");
  expect(selectRecordedAdjudication({ assessment_artifact: "slice_assessment", decisions: [DECLARED.request_assessment_changes] },
    "request_assessment_changes", validAdjudication())).toBeNull();
});

test("renaming adjudication schemas, reviews and decisions preserves authority outcomes", async () => {
  const source = bundle("development");
  const { adjudication, ...schemas } = source.schemas ?? {};
  if (!adjudication) throw new Error("missing adjudication schema");
  const decisionNames = new Map([["accept", "ok"], ["request_build_changes", "send"], ["request_assessment_changes", "ask"]]);
  const stages = Object.fromEntries(Object.entries(source.stages).map(([stageKey, stage]) => [stageKey, {
    ...stage,
    reviews: Object.fromEntries(Object.entries(stage.reviews ?? {}).map(([reviewKey, review]) => {
      if ("template" in review || "set" in review.decisions) return [reviewKey, review];
      const shouldRename = stageKey === "cohort" && reviewKey === "assessment_review";
      const decisions = Object.fromEntries(Object.entries(review.decisions).map(([key, decision]) => [
        shouldRename ? decisionNames.get(key) ?? key : key,
        { ...decision, payload: decision.payload === "adjudication" ? "verdict" : decision.payload },
      ]));
      return [shouldRename ? "ar" : reviewKey, { ...review, decisions }];
    })),
  }]));
  const renamed: WorkflowDefinitionDescriptor = { ...source, schemas: { ...schemas, verdict: adjudication }, stages };
  const valid = validAdjudication();
  const dropped = dropRework(valid);
  const outcomes = await Promise.all([
    { source, review: "assessment_review", accept: "accept", feedback: "request_build_changes", plain: "request_assessment_changes" },
    { source: renamed, review: "ar", accept: "ok", feedback: "send", plain: "ask" },
  ].map(async names => {
    const workflow = await compile(names.source);
    const review = selectAdjudicatedReview({ workflow, stage: "cohort", review: names.review });
    expect(review?.assessment_artifact).toBe("assessment");
    const accept = review?.decisions.find(decision => decision.key === names.accept);
    if (!accept) throw new Error("missing accept decision");
    const check = { workflow, snapshot: snapshot("cohort", "assessment", ["build_result"]), expected_assessment_revision_id: "assessment:1" };
    return [
      detail(validateAdjudication({ payload: dropped, assessment: target, decision: accept })),
      refusal(check, names.review, names.accept, "assessment", dropped),
      refusal(check, names.review, names.accept, "assessment", valid),
      refusal(check, names.review, names.feedback, "build_result", dropped),
      refusal(check, names.review, names.plain, "assessment", { feedback: "Fix X" }),
      refusal({ ...check, expected_assessment_revision_id: "old" }, names.review, names.accept, "assessment", dropped),
    ];
  }));
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[0]).toEqual([null, null, expect.stringContaining(acceptRefusal),
    expect.stringContaining("feedback requires non-empty rework_feedback"), expect.stringContaining("plain decision takes no assessment revision"),
    expect.stringContaining("reviewed assessment changed")]);
});
