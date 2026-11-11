import { expect, test } from "bun:test";
import { canonicalDigest } from "canonical-json";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { QuestionId } from "../src/domain/identity";
import { machineGraders, parseGradingDefinitions, planRegistration, selectedRunners,
  type GradingDefinition, type GradingDefinitions } from "../src/grading/configuration";
import { runnerRegistry } from "../src/grading/runner";
import { prepareGrading } from "../src/main";
import { oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { committedDefinitions, credentialEnv } from "./grading-fixture";

const parse = (raw: unknown) => parseGradingDefinitions(raw, oakridgeGradingRegistry);
const plan = (definitions: GradingDefinitions) => {
  const result = planRegistration(definitions, oakridgeGradingRegistry);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const editFirst = (definitions: GradingDefinitions, edit: (definition: GradingDefinition) => unknown): unknown =>
  definitions.map((definition, index) => index === 0 ? edit(definition) : definition);

test("the committed definitions load with the five target scopes, evidence declarations and original pins", async () => {
  const definitions = await committedDefinitions();
  expect(parse(definitions).ok).toBe(true);
  expect(definitions.map(({ id, target, evidence }) => ({ id, target, evidence }))).toEqual([
    { id: "finding.relevance", target: { artifact: "analysis", selector: "/findings/*", scope: "per_item" }, evidence: ["subject", "spec"] },
    { id: "assessment_finding.correctness", target: { artifact: "assessment", selector: "/findings/*", scope: "per_task", task_ids: "/task_ids" }, evidence: ["subject", "build_result", "citation", "test_evidence", "task_context"] },
    { id: "assessment_finding.evidence_support", target: { artifact: "assessment", selector: "/findings/*", scope: "per_task", task_ids: "/task_ids" }, evidence: ["subject", "citation", "test_evidence", "task_context"] },
    { id: "task.requirement_coverage", target: { artifact: "tasks", selector: "/tasks/*", scope: "per_item" }, evidence: ["subject", "spec", "spec_task", "requirement"] },
    { id: "acceptance_entry.task_coverage", target: { artifact: "plan", selector: "/cohorts/*/acceptance_criteria/*", scope: "per_item" }, evidence: ["subject", "spec", "spec_task", "requirement", "plan", "contribution_context"] },
  ]);
  expect(plan(definitions).capture.pins.map(({ question_id, item_kind }) => [question_id, item_kind])).toEqual([
    ["finding.relevance", "finding"], ["assessment_finding.correctness", "assessment_finding"],
    ["assessment_finding.evidence_support", "assessment_finding"], ["task.requirement_coverage", "task"],
    ["acceptance_entry.task_coverage", "acceptance_entry"],
  ]);
});

test("derived questions preserve the previous wording, values and semantics verbatim", async () => {
  const previous: unknown = LEGACY_QUESTIONS;
  const derived: unknown = plan(await committedDefinitions()).questions.map(({ question_version, ...question }) => question);
  expect(derived).toEqual(previous);
});

interface Refusal { readonly name: string; readonly kind: string; readonly entity_id?: string; readonly field?: string;
  readonly edit: (definition: GradingDefinition) => unknown }
const refusals: readonly Refusal[] = [
  { name: "unknown definition field", kind: "invalid_definitions", edit: (d) => ({ ...d, typo: true }) },
  { name: "unknown target field", kind: "invalid_definitions", edit: (d) => ({ ...d, target: { ...d.target, typo: true } }) },
  { name: "unknown question field", kind: "invalid_definitions", edit: (d) => ({ ...d, question: { ...d.question, typo: true } }) },
  { name: "unknown evaluator field", kind: "invalid_definitions", edit: (d) => ({ ...d, evaluators: [{ ...d.evaluators[0], typo: true }] }) },
  { name: "unknown question id", kind: "unknown_question", entity_id: "finding.relevnce", field: "id", edit: (d) => ({ ...d, id: "finding.relevnce" }) },
  { name: "unknown human-only question id", kind: "unknown_question", entity_id: "finding.relevnce", field: "id", edit: (d) => ({ ...d, id: "finding.relevnce", evaluators: [] }) },
  { name: "unknown runner", kind: "unknown_runner", entity_id: "finding.relevance:imaginary", edit: (d) => ({ ...d, evaluators: machineGraders(d).map((g) => ({ ...g, runner: "imaginary" })) }) },
  { name: "invalid runner instructions", kind: "invalid_instructions", entity_id: "finding.relevance:jev_direct", edit: (d) => ({ ...d, evaluators: machineGraders(d).map((g) => ({ ...g, instructions: { rubric: 1 } })) }) },
  { name: "duplicate grader", kind: "duplicate_grader", entity_id: "finding.relevance:jev_direct", edit: (d) => ({ ...d, evaluators: [...d.evaluators, ...d.evaluators] }) },
  { name: "duplicate explicit human", kind: "duplicate_grader", entity_id: "finding.relevance:human", edit: (d) => ({ ...d, evaluators: [{ runner: "human" }, { runner: "human" }] }) },
  { name: "unknown evidence source", kind: "unknown_evidence", field: "evidence", edit: (d) => ({ ...d, evidence: ["invented"] }) },
  { name: "unknown selector", kind: "unknown_selector", field: "target.selector", edit: (d) => ({ ...d, target: { ...d.target, selector: "/absent/*" } }) },
  { name: "selector registered for a different artifact", kind: "unknown_selector", edit: (d) => ({ ...d, target: { ...d.target, artifact: "brief" } }) },
  { name: "task_ids on per_item", kind: "invalid_task_ids", field: "target.task_ids", edit: (d) => ({ ...d, target: { ...d.target, task_ids: "/task_ids" } }) },
  { name: "missing per_task task_ids", kind: "invalid_task_ids", field: "target.task_ids", edit: (d) => ({ ...d, target: { ...d.target, scope: "per_task" } }) },
  { name: "non-pointer task_ids", kind: "invalid_task_ids", field: "target.task_ids", edit: (d) => ({ ...d, target: { ...d.target, scope: "per_task", task_ids: "task_ids" } }) },
];
for (const refusal of refusals) test(`the loader refuses ${refusal.name} with definition context`, async () => {
  const result = parse(editFirst(await committedDefinitions(), refusal.edit));
  expect(result).toMatchObject({ ok: false, error: { operation: "grader_configuration", kind: refusal.kind,
    entity_id: refusal.entity_id ?? "finding.relevance", detail: refusal.field ? expect.stringContaining(refusal.field) : expect.any(String) } });
});

test("duplicate definition ids are refused", async () => {
  const definitions = await committedDefinitions();
  expect(parse([...definitions, definitions[0]])).toMatchObject({ ok: false, error: { kind: "duplicate_definition", entity_id: definitions[0]!.id } });
});

test("registration refuses an unknown question id even without parsing first", async () => {
  const [definition] = await committedDefinitions();
  expect(planRegistration([{ ...definition!, id: "finding.relevnce" }], oakridgeGradingRegistry))
    .toMatchObject({ ok: false, error: { operation: "grader_configuration", kind: "unknown_question",
      entity_id: "finding.relevnce", detail: expect.stringContaining("evidence collector") } });
});

test("supported question ids come from the injected producer registry", async () => {
  const [definition] = await committedDefinitions();
  const question_id = "another_producer.relevance" as QuestionId;
  const registry = { ...oakridgeGradingRegistry, evidence_question_ids: [question_id] };
  const result = parseGradingDefinitions([{ ...definition!, id: question_id }], registry);
  expect(result.ok).toBe(true);
  expect(parseGradingDefinitions([definition], registry))
    .toMatchObject({ ok: false, error: { kind: "unknown_question", entity_id: definition!.id } });
});

test("malformed definitions and missing evaluator fields are refused", async () => {
  const definitions = await committedDefinitions();
  for (const raw of [{ questions: [] }, [], editFirst(definitions, (d) => ({ ...d, evaluators: [{ runner: "jev_direct" }] }))])
    expect(parse(raw)).toMatchObject({ ok: false, error: { kind: "invalid_definitions" } });
});

test("System One criteria must name exactly the question's answers", async () => {
  const definitions = await committedDefinitions();
  expect(parse(editFirst(definitions, (d) => ({ ...d, question: { ...d.question, values: ["different"] } }))))
    .toMatchObject({ ok: false, error: { kind: "invalid_instructions", detail: expect.stringContaining("criteria must name exactly") } });
});

test("question versions digest only the question block and complete target", async () => {
  const definitions = await committedDefinitions();
  const first = definitions[0]!;
  const version = (definition: GradingDefinition) => plan([{ ...definition, evaluators: [] }]).questions[0]!.question_version;
  const original = version(first);
  const digest = canonicalDigest({ question: first.question, target: first.target });
  if (!digest.ok) throw new Error(digest.error.detail);
  expect(original).toBe(digest.value);
  for (const edited of [
    { ...first, question: { ...first.question, text: "Changed wording" } },
    { ...first, target: { ...first.target, artifact: "assessment" } },
    { ...first, target: { ...first.target, selector: "/risks/*" } },
    { ...first, target: { ...first.target, scope: "per_task" as const, task_ids: "/task_ids" } },
  ]) expect(version(edited)).not.toBe(original);
  const perTask: GradingDefinition = { ...first, target: { ...first.target, scope: "per_task", task_ids: "/task_ids" } };
  expect(version({ ...perTask, target: { ...perTask.target, scope: "per_task", task_ids: "/other_ids" } })).not.toBe(version(perTask));
  const edited = definitions.map((d) => ({ ...d, evidence: ["subject"], evaluators: machineGraders(d).map((g) => ({ ...g, model: `${g.model}-next` })) }));
  expect(plan(edited).questions).toEqual(plan(definitions).questions);
  expect(plan(edited).evaluators).not.toEqual(plan(definitions).evaluators);
});

test("registration pins exactly the configured graders plus the single implicit human", async () => {
  const definitions = await committedDefinitions();
  const registration = plan(definitions);
  expect(registration.evaluators.filter((e) => e.kind === "human")).toHaveLength(1);
  for (const [index, pin] of registration.capture.pins.entries()) {
    const graders = machineGraders(definitions[index]!);
    expect(pin.evaluator_definition_ids).toHaveLength(graders.length + 1);
    for (const grader of graders) expect(registration.evaluators).toContainEqual(expect.objectContaining({ backend_kind: grader.runner, model: grader.model,
      cost_metadata: { estimated_cost_per_call: grader.estimated_cost_per_call }, instruction_text: expect.any(String) }));
  }
  expect(plan(definitions)).toEqual(plan(await committedDefinitions()));
  const explicitHuman = definitions.map((d) => ({ ...d, evaluators: [...d.evaluators, { runner: "human" as const }] }));
  expect(plan(explicitHuman)).toEqual(registration);
  expect(selectedRunners(explicitHuman)).toEqual(selectedRunners(definitions));
  const humanOnly = definitions.map((d) => ({ ...d, evaluators: [] }));
  expect(plan(humanOnly).capture.pins.every((p) => p.evaluator_definition_ids.length === 1)).toBe(true);
  expect(selectedRunners(humanOnly)).toEqual([]);
});

test("several different graders may be configured for a question and all are pinned", async () => {
  const definitions = await committedDefinitions();
  const first = definitions[0]!;
  const grader = machineGraders(first)[0]!;
  const registration = plan([{ ...first, evaluators: [...first.evaluators, { ...grader, model: `${grader.model}-second` }] }]);
  expect(registration.capture.pins[0]!.evaluator_definition_ids).toHaveLength(first.evaluators.length + 2);
});

test("startup refuses missing credentials without disclosing unrelated values", async () => {
  const definitions = await committedDefinitions();
  const env = credentialEnv(definitions);
  expect(prepareGrading(definitions, oakridgeGradingRegistry, env).ok).toBe(true);
  for (const name of Object.keys(env)) {
    const { [name]: _missing, ...rest } = env;
    const result = prepareGrading(definitions, oakridgeGradingRegistry, { ...rest, UNRELATED: "secret-value" });
    expect(result).toMatchObject({ ok: false, error: { kind: "missing_credential", entity_id: name } });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  }
});

const SOURCE_ROOT = resolve(import.meta.dir, "../src");
const RUNNER_SOURCES = [resolve(SOURCE_ROOT, "grading/runner.ts"), resolve(SOURCE_ROOT, "runners")];
function files(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => { const path = resolve(directory, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}
test("runner and model selection lives only in grading-definitions.json", async () => {
  const models = [...new Set((await committedDefinitions()).flatMap((d) => machineGraders(d).map((g) => g.model)))];
  const runnerLiteral = new RegExp(`["'\`](${Object.keys(runnerRegistry).join("|")})["'\`]`);
  const roots = [SOURCE_ROOT, resolve(import.meta.dir, "../fixtures"), resolve(import.meta.dir, "../../workflow-config/prompts")];
  const offending = roots.flatMap(files).filter((path) => !RUNNER_SOURCES.some((source) => path === source || path.startsWith(`${source}/`))).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...(runnerLiteral.test(text) ? [`${relative(SOURCE_ROOT, path)}: runner name`] : []),
      ...models.filter((model) => text.includes(model)).map((model) => `${relative(SOURCE_ROOT, path)}: ${model}`)];
  });
  expect(offending).toEqual([]);
});

// Compatibility baseline from the removed question table, excluding its hand-bumped version.
const LEGACY_QUESTIONS = [
  {
    "question_id": "finding.relevance",
    "item_kind": "finding",
    "question_text": "Is this finding relevant to the spec the run was launched with?",
    "response_kind": "choice",
    "allowed_values": [
      "relevant",
      "irrelevant",
      "unclear"
    ],
    "missing_evidence_policy": "abstain",
    "abstain_semantics": "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    "unclear_semantics": "Choose unclear when the finding and the full spec do not settle its relevance.",
    "interpretation_caveats": "Judge this one finding against the full captured spec, not the whole analysis."
  },
  {
    "question_id": "assessment_finding.correctness",
    "item_kind": "assessment_finding",
    "question_text": "Is this assessment finding correct, given its cited evidence and the build it assesses?",
    "response_kind": "choice",
    "allowed_values": [
      "supported",
      "contradicted",
      "unclear"
    ],
    "missing_evidence_policy": "abstain",
    "abstain_semantics": "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    "unclear_semantics": "Choose unclear when the available evidence cannot establish whether the finding is correct.",
    "interpretation_caveats": "Judge this one finding. Test and output citations are agent-reported; a file recorded as absent is evidence of absence. Linked task context is optional background."
  },
  {
    "question_id": "assessment_finding.evidence_support",
    "item_kind": "assessment_finding",
    "question_text": "Does this assessment finding's cited evidence support it?",
    "response_kind": "choice",
    "allowed_values": [
      "supports",
      "does_not_support",
      "unclear"
    ],
    "missing_evidence_policy": "abstain",
    "abstain_semantics": "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    "unclear_semantics": "Choose unclear when the citations cannot be judged either way, including when there are none.",
    "interpretation_caveats": "Judge only the finding and its citations. Test and output citations are agent-reported."
  },
  {
    "question_id": "task.requirement_coverage",
    "item_kind": "task",
    "question_text": "How well does this spec task account for the specification requirements it explicitly references?",
    "response_kind": "choice",
    "allowed_values": [
      "fully_covers",
      "partially_covers",
      "does_not_cover",
      "unclear"
    ],
    "missing_evidence_policy": "abstain",
    "abstain_semantics": "Abstain only when the evidence set is marked incomplete.",
    "unclear_semantics": "Choose unclear when no requirements are explicitly linked or the evidence cannot establish coverage.",
    "interpretation_caveats": "Judge the task definition, not implementation success. Only requirement_ids declares its scope; do not infer links from prose."
  },
  {
    "question_id": "acceptance_entry.task_coverage",
    "item_kind": "acceptance_entry",
    "question_text": "How well does this cohort contribution cover its assigned spec task?",
    "response_kind": "choice",
    "allowed_values": [
      "fully_covers",
      "partially_covers",
      "does_not_cover",
      "unclear"
    ],
    "missing_evidence_policy": "abstain",
    "abstain_semantics": "Abstain only when the evidence set is marked incomplete.",
    "unclear_semantics": "Choose unclear when the contribution's intended scope or coverage cannot be established.",
    "interpretation_caveats": "Judge the proposed work, not completed code. A spec task can span cohorts: evaluate the declared share in the whole plan. A brief must preserve that share and make it implementable."
  }
];
