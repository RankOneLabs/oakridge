import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Result } from "canonical-json";
import YAML from "yaml";
import { DEFINITION_STORE_ROOT, resolveLaunchableDefinition, selectDiscardedFields } from "./definition-store";

const root = resolve(import.meta.dir, "../..");
const promptDirectory = resolve(root, "workflow-config/prompts/development");

interface AuthoredStage {
  readonly input: Record<string, string> | string;
  readonly workers: Record<string, { readonly inputs?: Record<string, string> }>;
  readonly reviews?: Record<string, { readonly inputs?: Record<string, string> }>;
}
interface AuthoredDevelopment {
  readonly schemas: Record<string, Record<string, string>>;
  readonly run: { readonly units: Record<string, { readonly input: Record<string, string> }> };
  readonly stages: Record<string, AuthoredStage>;
}
function unwrap<Value, Failure>(result: Result<Value, Failure>): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const development = YAML.parse(readFileSync(resolve(root, "workflow-config/development.yaml"), "utf8")) as AuthoredDevelopment;
const readPrompt = (name: string): string => readFileSync(resolve(promptDirectory, `${name}.md`), "utf8");
const selectPromptNames = (): string[] => readdirSync(promptDirectory).map((file) => file.replace(/\.md$/, ""));
const planningPrompts = ["plan", "plan-revise", "plan-review", "brief", "brief-revise", "brief-review"];
const assessmentPrompts = ["assess", "assess-revise", "integrate", "integrate-revise"];
const integrationPrompts = ["integrate", "integrate-revise", "integration-review"];

test("an acceptance entry declares exactly its task id, text and decision links", () => {
  expect(Object.keys(development.schemas.task_acceptance).sort()).toEqual(["decision_ids", "id", "text"]);
});

test("plan cohorts and briefs share the acceptance entry", () => {
  expect([development.schemas.plan_cohort.acceptance_criteria, development.schemas.brief_body.acceptance_criteria])
    .toEqual(["list(task_acceptance)", "list(task_acceptance)"]);
});

test("the replaced criterion schema is gone", () => {
  expect(development.schemas.plan_criterion).toBeUndefined();
});

test("a finding declares a required list of task links and no criterion fields", () => {
  expect(development.schemas.assessment_finding).toEqual({
    task_ids: "list(ident)",
    status: "optional(enum(met, not_met, partial))",
    evidence: "list(evidence_ref)",
    description: "optional(text)",
  });
});

test("the assessment keeps its head, verdict and citation vocabulary", () => {
  expect({ head_sha: development.schemas.assessment_body.head_sha, verdict: development.schemas.assessment_body.verdict, kind: development.schemas.evidence_ref.kind })
    .toEqual({ head_sha: "text", verdict: "enum(pass, pass_with_notes, fail)", kind: "enum(file, test, output)" });
});

test("integration selects briefs by exact repository key", () => {
  expect(development.run.units.integration.input.briefs).toBe("filter(map(briefs, briefs.outcome.brief), item.repository_key == each.key)");
});

test("the integrator and its review both read the briefs", () => {
  const { workers, reviews } = development.stages.integration;
  expect([workers.integrator.inputs?.briefs, reviews?.integration_review.inputs?.briefs]).toEqual(["input.briefs", "input.briefs"]);
});

test("the plan review reads the approved task list", () => {
  expect(development.stages.planning.reviews?.plan_review.inputs?.tasks).toBe("input.tasks");
});

for (const name of selectPromptNames()) {
  test(`${name}.md names no criterion id field`, () => {
    expect(readPrompt(name)).not.toContain("criterion_id");
  });

  test(`${name}.md allocates no id namespace and no run-wide uniqueness`, () => {
    expect(readPrompt(name)).not.toMatch(/allocate criterion|unique within (this|the) whole run|\bAC-?\d/);
  });
}

for (const name of planningPrompts) {
  test(`${name}.md never asks for task_ids on an acceptance entry`, () => {
    expect(readPrompt(name)).not.toContain("task_ids");
  });
}

for (const name of ["plan", "plan-revise", "brief", "brief-revise"]) {
  test(`${name}.md states the exact acceptance entry shape`, () => {
    expect(readPrompt(name)).toContain("{ id, text, decision_ids }");
  });
}

for (const name of assessmentPrompts) {
  test(`${name}.md allows several findings, shared findings and unlinked findings`, () => {
    expect(readPrompt(name)).toContain("`task_ids: []`");
  });
}

for (const name of integrationPrompts) {
  test(`${name}.md renders the repository's briefs`, () => {
    expect(readPrompt(name)).toContain("{{briefs}}");
  });
}

for (const name of ["integrate", "integrate-revise"]) {
  test(`${name}.md groups shared tasks and requires no build subject`, () => {
    const prompt = readPrompt(name);
    expect([prompt.includes("Group the entries by `id`"), prompt.includes("no build result subject")]).toEqual([true, true]);
  });
}

test("the launchable development definition carries the task contracts", () => {
  const { source } = unwrap(resolveLaunchableDefinition("development", DEFINITION_STORE_ROOT));
  const text = JSON.stringify(source);
  expect([text.includes("criterion_id"), text.includes("plan_criterion"), text.includes("task_acceptance")]).toEqual([false, false, true]);
});

test("the launchable development definition pins the rewritten prompts", () => {
  const { prompts } = unwrap(resolveLaunchableDefinition("development", DEFINITION_STORE_ROOT));
  const scoped = [...planningPrompts, ...assessmentPrompts, ...integrationPrompts];
  expect(scoped.filter((name) => prompts[`development/${name}.md`] !== readPrompt(name))).toEqual([]);
});

test("no retained definition carries a discarded worker field", () => {
  const directory = resolve(DEFINITION_STORE_ROOT, "workflows");
  const carrying = readdirSync(directory).filter((file) => selectDiscardedFields(JSON.parse(readFileSync(resolve(directory, file), "utf8"))).length > 0);
  expect(carrying).toEqual([]);
});
