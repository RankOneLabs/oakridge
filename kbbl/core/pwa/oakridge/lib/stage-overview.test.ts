import { sampleUnits as units, withUnitFields } from "../__fixtures__/read-models";
import type { ObservationRunStageRead } from "../grading-contracts/grading/task-stages";
import { expect, test } from "vitest";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { ObservationGradeableItemRow } from "../grading-contracts/grading/item-reads";
import { selectStageInputs, selectStageExecution, selectStageEvaluation, selectUnitFindings, type StageOverviewSource } from "./stage-overview";
const unit = units.find((unit) => unit.attempts.length > 0 && unit.artifacts.some((artifact) => artifact.latest_revision));
if (!unit) throw new Error("captured fixture requires a unit with an attempt and a published artifact");
const revisions = unit.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision] : []);
const revision = revisions[0];
if (!revision) throw new Error("captured stage fixture requires a published revision");
const source: StageOverviewSource = { unit, index: { run_id: unit.run_id, units, revisions }, artifacts: unit.artifacts.map((artifact) => ({ ...artifact, revisions: artifact.latest_revision ? [artifact.latest_revision] : [] })) as unknown as OperatorArtifactDetail[] };
test("Inputs retains resolved input and recorded per-attempt instructions", () => {
  const inputs = selectStageInputs(source);
  expect({ input: inputs.resolved_input, attempts: inputs.attempts.map((attempt) => attempt.id) }).toEqual({ input: unit.input, attempts: unit.attempts.map((attempt) => attempt.id) });
});
test("Execution includes attempts, session identities, all revisions and decisions", () => {
  const execution = selectStageExecution(source);
  expect({ attempts: execution.attempts.length, revisions: execution.outputs.flatMap((output) => output.revisions).map(({ revision }) => revision.id), decisions: execution.recorded_decisions }).toEqual({ attempts: unit.attempts.length, revisions: revisions.map((revision) => revision.id), decisions: unit.recorded_decisions });
});
test("Evaluation filters findings by revision ids rather than labels or stage names", () => {
  const findings = [{ item: { source_revision_id: revision.id }, links: { items: [] } }, { item: { source_revision_id: "foreign", stage: unit.stage }, links: { items: [] } }] as unknown as ObservationGradeableItemRow[];
  expect(selectUnitFindings(source, findings)).toEqual([findings[0]]);
});
test("Evaluation preserves unavailable reads distinctly from an empty successful read", () => {
  const result = selectStageEvaluation({ source, stages: { state: "loaded", value: [] }, findings: { state: "unavailable" }, tasks: { state: "pending" }, statuses: [] });
  expect([result.stages, result.findings, result.tasks]).toEqual([{ state: "loaded", value: [] }, { state: "unavailable" }, { state: "pending" }]);
});

import { itemStatus, supportQuestion, paged } from "../__fixtures__/grading";
import { selectEvaluationQuestions } from "./stage-overview";
import { itemSelectionKey } from "./grading";
test("evaluation carries questions, frozen evidence and evaluator identities while hiding answers and results until revealed", () => {
  const status = itemStatus([supportQuestion()]);
  const hidden = selectEvaluationQuestions(status, new Set())[0];
  const selection = { source_revision_id: status.item.source_revision_id, item_path: status.item.item_path };
  const shown = selectEvaluationQuestions(status, new Set([itemSelectionKey(selection)]))[0];
  const question = status.questions.items[0];
  if (!hidden || !shown || !question) throw new Error("grading fixture requires a question and both visibility projections");
  expect({ question: hidden.question, evidence: hidden.evidence, evaluators: hidden.evaluators, answers: hidden.answers, machine: hidden.machine, revealed_answers: shown.answers }).toEqual({
    question: question.question, evidence: question.evidence,
    evaluators: question.machine.items.map(({ evaluator_definition_id, backend_kind, model }) => ({ evaluator_definition_id, backend_kind, model })),
    answers: null, machine: null, revealed_answers: question.answers });
});
test("evaluation exposes recorded task associations and a question target on a selected unit revision", () => {
  const status = itemStatus([supportQuestion()]);
  const item = { ...status.item, source_revision_id: revision.id as typeof status.item.source_revision_id };
  const findings = [{ item, links: paged([]) }];
  const evaluation = selectStageEvaluation({ source, stages: { state: "loaded", value: [] }, findings: { state: "loaded", value: findings }, tasks: { state: "loaded", value: [] }, statuses: [{ state: "loaded", value: { ...status, item } }] });
  expect(evaluation.links.filter((link) => link.kind === "grading_subject" && link.resolution.state === "resolved").length).toBe(2);
});

test("Inputs exposes an agent's recorded prompt pin and exact input revision link", () => {
  const attempt = unit.attempts[0];
  const revision = revisions[0];
  if (!attempt || !revision) throw new Error("captured fixture requires an attempt and revision");
  const prompt = { path: "prompts/recorded-agent.md", digest: "sha256:recorded-prompt" };
  const recordedUnit = withUnitFields(unit, { attempts: [{ ...attempt, intent: { input_provenance: { status: "unresolved" as const },
    inputs: { source: { revision_id: revision.id } },
    engine_inputs: { previous: null, feedback: [], subject: null }, prompt,
  } }] });
  const inputs = selectStageInputs({ ...source, unit: recordedUnit });
  const link = inputs.links.find((link) => link.kind === "effect_input_revision");
  expect({ prompt: inputs.attempts[0]?.intent?.prompt, reference: link?.raw_reference,
    target: link?.resolution.state === "resolved" ? link.resolution.target : null }).toMatchObject({
    prompt, reference: revision.id,
    target: { run_id: revision.run_id, unit_id: revision.unit_id, revision_id: revision.id,
      pane: { kind: "artifact", revision_id: revision.id } },
  });
});

test("Evaluation retains run grading stages whose labels differ from the authority unit stage", () => {
  const stages: readonly ObservationRunStageRead[] = [
    { stage: "observation-artifact-stage", artifact_kinds: ["recorded-artifact"], state: "linked" },
    { stage: "other-observation-stage", artifact_kinds: ["other-artifact"], state: "pending" },
  ];
  const evaluation = selectStageEvaluation({ source, stages: { state: "loaded", value: stages },
    findings: { state: "loaded", value: [] }, tasks: { state: "loaded", value: [] }, statuses: [] });
  expect(evaluation.stages).toEqual({ state: "loaded", value: stages });
});
