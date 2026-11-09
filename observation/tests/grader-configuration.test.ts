import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseGraderConfiguration, planRegistration, type GraderConfiguration, type GraderEntry } from "../src/grading/configuration";
import { runnerRegistry } from "../src/grading/runner";
import { prepareGrading } from "../src/main";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { committedGraders, credentialEnv } from "./grading-fixture";

async function committed(): Promise<GraderConfiguration> {
  const parsed = parseGraderConfiguration(await committedGraders());
  if (!parsed.ok) throw new Error(parsed.error.detail);
  return parsed.value;
}
function plan(configuration: GraderConfiguration) {
  const planned = planRegistration(configuration, oakridgeProfile.questions);
  if (!planned.ok) throw new Error(`${planned.error.kind}: ${planned.error.detail}`);
  return planned.value;
}
/** The committed configuration with one question's graders replaced. */
function withGraders(configuration: GraderConfiguration, question_id: string, graders: (current: readonly GraderEntry[]) => readonly GraderEntry[]): GraderConfiguration {
  return { questions: configuration.questions.map((entry) => entry.question_id === question_id ? { ...entry, graders: graders(entry.graders) } : entry) };
}
const firstQuestion = async () => (await committed()).questions[0]!;

test("graders.json configures every question the producer asks, each with at least one grader", async () => {
  const configuration = await committed();
  expect(configuration.questions.map((entry) => entry.question_id).toSorted())
    .toEqual(oakridgeProfile.questions.map((question) => question.question_id).toSorted());
  for (const entry of configuration.questions) expect(entry.graders.length).toBeGreaterThan(0);
});

test("each configured grader names a retained runner, a model, instructions and an estimated cost per call", async () => {
  for (const grader of (await committed()).questions.flatMap((entry) => entry.graders)) {
    expect(Object.keys(runnerRegistry)).toContain(grader.runner);
    expect(grader.model.length).toBeGreaterThan(0);
    expect(grader.estimated_cost_per_call).toBeGreaterThanOrEqual(0);
  }
});

test("registration selects exactly the configured graders, plus one human evaluator pinned everywhere", async () => {
  const configuration = await committed();
  const registration = plan(configuration);
  for (const pin of registration.capture.pins) {
    const configured = configuration.questions.find((entry) => entry.question_id === pin.question_id)?.graders ?? [];
    const pinned = registration.evaluators.filter((evaluator) => pin.evaluator_definition_ids.includes(evaluator.evaluator_definition_id as never));
    expect(pinned.filter((evaluator) => evaluator.kind !== "human").map((evaluator) => [evaluator.backend_kind, evaluator.model]))
      .toEqual(configured.map((grader) => [grader.runner, grader.model]));
    expect(pinned.filter((evaluator) => evaluator.kind === "human")).toHaveLength(1);
  }
  const humans = registration.evaluators.filter((evaluator) => evaluator.kind === "human");
  expect(humans).toHaveLength(1);
  expect(humans[0]).toMatchObject({ model: null, cost_metadata: null });
});

test("each pin carries its question's version and item kind", async () => {
  const registration = plan(await committed());
  expect(registration.capture.pins.map(({ question_id, question_version, item_kind }) => ({ question_id, question_version, item_kind })))
    .toEqual(oakridgeProfile.questions.map(({ question_id, question_version, item_kind }) => ({ question_id, question_version, item_kind })));
});

test("a definition carries its runner's provider, the configured instructions and the estimated cost", async () => {
  const configuration = await committed();
  const grader = configuration.questions[0]!.graders[0]!;
  const evaluator = plan(configuration).evaluators.find((candidate) => candidate.backend_kind === grader.runner)!;
  expect(evaluator).toMatchObject({ kind: "model", provider: runnerRegistry[grader.runner as keyof typeof runnerRegistry].provider,
    model: grader.model, cost_metadata: { estimated_cost_per_call: grader.estimated_cost_per_call } });
  expect(JSON.parse(evaluator.instruction_text)).toEqual(grader.instructions);
});

test("several graders may be configured for one question, and all are pinned", async () => {
  const question = await firstQuestion();
  const [grader] = question.graders;
  const configuration = withGraders(await committed(), question.question_id, (current) => [...current, { ...grader!, model: `${grader!.model}-second` }]);
  const pin = plan(configuration).capture.pins.find((candidate) => candidate.question_id === question.question_id)!;
  expect(pin.evaluator_definition_ids).toHaveLength(question.graders.length + 2);
});

test("the same configuration always yields the same definitions; any edit yields new ones", async () => {
  const configuration = await committed();
  const ids = (value: GraderConfiguration) => plan(value).evaluators.map((evaluator) => evaluator.evaluator_definition_id).toSorted();
  expect(ids(configuration)).toEqual(ids(await committed()));
  const question = await firstQuestion();
  const edits: readonly ((grader: GraderEntry) => GraderEntry)[] = [
    (grader) => ({ ...grader, model: `${grader.model}-next` }),
    (grader) => ({ ...grader, estimated_cost_per_call: grader.estimated_cost_per_call + 0.5 }),
    (grader) => ({ ...grader, instructions: JSON.parse(JSON.stringify(grader.instructions).replace("Judge", "Assess")) }),
  ];
  for (const edit of edits) {
    const edited = plan(withGraders(configuration, question.question_id, (current) => current.map(edit)));
    const before = plan(configuration).capture.pins.find((pin) => pin.question_id === question.question_id)!;
    const after = edited.capture.pins.find((pin) => pin.question_id === question.question_id)!;
    expect(after.evaluator_definition_ids).not.toEqual(before.evaluator_definition_ids);
    // The human evaluator and the other questions' graders are untouched by the edit.
    expect(after.evaluator_definition_ids.at(-1)).toBe(before.evaluator_definition_ids.at(-1)!);
  }
});

test("a question graders.json omits is pinned to the human evaluator alone", async () => {
  const question = await firstQuestion();
  const configuration = { questions: (await committed()).questions.filter((entry) => entry.question_id !== question.question_id) };
  const registration = plan(configuration);
  const pin = registration.capture.pins.find((candidate) => candidate.question_id === question.question_id)!;
  expect(pin.evaluator_definition_ids).toHaveLength(1);
  expect(registration.evaluators.find((evaluator) => evaluator.evaluator_definition_id === pin.evaluator_definition_ids[0])?.kind).toBe("human");
});

test("an unknown runner, question, unusable instructions or a repeated grader is refused", async () => {
  const configuration = await committed();
  const question = await firstQuestion();
  const refused = (value: GraderConfiguration) => planRegistration(value, oakridgeProfile.questions);
  expect(refused(withGraders(configuration, question.question_id, (current) => current.map((grader) => ({ ...grader, runner: "stub_model" })))))
    .toMatchObject({ ok: false, error: { kind: "unknown_runner", entity_id: "stub_model" } });
  expect(refused({ questions: [...configuration.questions, { ...question, question_id: "risk.severity" }] }))
    .toMatchObject({ ok: false, error: { kind: "unknown_question", entity_id: "risk.severity" } });
  expect(refused({ questions: [...configuration.questions, question] })).toMatchObject({ ok: false, error: { kind: "duplicate_question" } });
  expect(refused(withGraders(configuration, question.question_id, (current) => [...current, ...current])))
    .toMatchObject({ ok: false, error: { kind: "duplicate_grader" } });
  expect(refused(withGraders(configuration, question.question_id, (current) => current.map((grader) => ({ ...grader, instructions: { rubric: 1 } })))))
    .toMatchObject({ ok: false, error: { kind: "invalid_instructions" } });
});

test("System One criteria must name exactly the question's answers", async () => {
  const question = await firstQuestion();
  const configuration = withGraders(await committed(), question.question_id, (current) => current.map((grader) => {
    const recipe = grader.instructions as { system_one: { criteria: Record<string, string> } };
    const { unclear: _dropped, ...criteria } = recipe.system_one.criteria;
    return { ...grader, instructions: { system_one: { ...recipe.system_one, criteria } } };
  }));
  expect(planRegistration(configuration, oakridgeProfile.questions)).toMatchObject({ ok: false, error: { kind: "invalid_instructions",
    detail: expect.stringContaining("criteria must name exactly") } });
});

test("misspelt or missing fields are refused rather than ignored", async () => {
  const question = await firstQuestion();
  const grader = question.graders[0]!;
  expect(parseGraderConfiguration({ questions: [{ ...question, graders: [{ ...grader, modle: "x" }] }] }))
    .toMatchObject({ ok: false, error: { kind: "invalid_graders" } });
  const { estimated_cost_per_call: _cost, ...uncosted } = grader;
  expect(parseGraderConfiguration({ questions: [{ ...question, graders: [uncosted] }] })).toMatchObject({ ok: false, error: { kind: "invalid_graders" } });
  expect(parseGraderConfiguration({ questions: [] })).toMatchObject({ ok: false, error: { kind: "invalid_graders" } });
});

test("startup preparation fails on a missing required setting, naming the setting and no value", async () => {
  const graders = await committedGraders();
  const env = credentialEnv(graders);
  expect(prepareGrading(graders, oakridgeProfile, env).ok).toBe(true);
  for (const name of Object.keys(env)) {
    const { [name]: _missing, ...rest } = env;
    const prepared = prepareGrading(graders, oakridgeProfile, { ...rest, UNRELATED: "secret-value" });
    expect(prepared).toMatchObject({ ok: false, error: { kind: "missing_credential", entity_id: name } });
    expect(JSON.stringify(prepared)).not.toContain("secret-value");
  }
});

const SOURCE_ROOT = resolve(import.meta.dir, "../src");
/** The registry and the implementations it registers name themselves; neither selects a grader. */
const RUNNER_SOURCES = [resolve(SOURCE_ROOT, "grading/runner.ts"), resolve(SOURCE_ROOT, "runners")];
function files(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("no code, fixture or prompt selects a grader: runner names live only in the registry, models only in graders.json", async () => {
  const configuration = await committed();
  const models = [...new Set(configuration.questions.flatMap((entry) => entry.graders.map((grader) => grader.model)))];
  const runnerLiteral = new RegExp(`["'\`](${Object.keys(runnerRegistry).join("|")})["'\`]`);
  const roots = [SOURCE_ROOT, resolve(import.meta.dir, "../fixtures"), resolve(import.meta.dir, "../../workflow-config/prompts")];
  const offending = roots.flatMap(files).filter((path) => !RUNNER_SOURCES.some((source) => path === source || path.startsWith(`${source}/`))).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...(runnerLiteral.test(text) ? [`${relative(SOURCE_ROOT, path)}: runner name`] : []),
      ...models.filter((model) => text.includes(model)).map((model) => `${relative(SOURCE_ROOT, path)}: ${model}`)];
  });
  expect(offending).toEqual([]);
});
