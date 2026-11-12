import { expect, test } from "bun:test";
import { allProviderCredentialNames, configuredRunnerNames, credentialsForRunners, parseEnvFile,
  selectProviderEnvironment } from "../src/grading/provider-credentials";
import { runnerRegistry } from "../src/grading/runner";

import { machineGraders } from "../src/grading/configuration";
import { committedDefinitions, oakridgeGradingRegistry } from "./grading-fixture";

const graders = async (...runners: string[]) => {
  const [definition] = await committedDefinitions();
  const grader = machineGraders(definition!)[0]!;
  return [{ ...definition!, evaluators: runners.map((runner, index) =>
    runner === "human" ? { runner: "human" as const } : { ...grader, runner, model: `model-${index}` }) }];
};
const configured = (raw: unknown) => configuredRunnerNames(raw, oakridgeGradingRegistry);

test("every retained runner declares what it reads", () => {
  expect(allProviderCredentialNames().toSorted()).toEqual(["FASTINO_API_KEY", "FASTINO_BASE_URL", "OBSERVATION_LLM_JUDGE_API_KEY",
    "OBSERVATION_LLM_JUDGE_BASE_URL", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"]);
  expect(Object.keys(runnerRegistry).toSorted()).toEqual(["fastino_glide", "jev_direct", "llm_judge"]);
});

test("the configured runners are read from definitions once each, excluding human", async () => {
  expect(configured(await graders("jev_direct", "fastino_glide", "jev_direct", "human"))).toEqual({ ok: true, value: ["jev_direct", "fastino_glide"] });
});

test("human-only definitions select no provider settings", async () => {
  expect(configured(await graders("human"))).toEqual({ ok: true, value: [] });
  expect(configured(await graders())).toEqual({ ok: true, value: [] });
});

test("a grader without its model, instructions or cost is refused before selecting settings", async () => {
  const [definition] = await committedDefinitions();
  expect(configured([{ ...definition, evaluators: [{ runner: "jev_direct" }] }]))
    .toMatchObject({ ok: false, error: { kind: "invalid_definitions" } });
});

test("invalid definitions fail before selecting provider settings", () => {
  expect(configured({ questions: [] })).toMatchObject({ ok: false, error: { kind: "invalid_definitions" } });
});

test("an unknown capability fails before selecting provider settings", async () => {
  const [definition] = await committedDefinitions();
  expect(configured([{ ...definition!, id: "finding.relevnce", evidence: ["absent_capability"] }]))
    .toMatchObject({ ok: false, error: { operation: "provider_credentials", kind: "invalid_definitions",
      entity_id: "finding.relevnce", detail: expect.stringContaining("absent_capability") } });
});

test("an unknown runner fails instead of selecting nothing for it", () => {
  expect(credentialsForRunners(["jev_direct", "imaginary"])).toMatchObject({ ok: false, error: { kind: "unknown_runner", entity_id: "imaginary" } });
});

test("only the configured runners' settings are selected", () => {
  const requirements = credentialsForRunners(["jev_direct"]);
  if (!requirements.ok) throw new Error("jev_direct is retained");
  const entries = parseEnvFile("TYPESAFE_API_KEY=key\nTYPESAFE_BASE_URL=http://provider\nFASTINO_API_KEY=other\nOBSERVATION_DATABASE_URL=postgres://live\n");
  const selected = selectProviderEnvironment(requirements.value, entries);
  expect(selected.ok && [...selected.value]).toEqual([["TYPESAFE_API_KEY", "key"], ["TYPESAFE_BASE_URL", "http://provider"]]);
});

test("a missing required setting names the setting and no value", () => {
  const requirements = credentialsForRunners(["jev_direct", "fastino_glide"]);
  if (!requirements.ok) throw new Error("both runners are retained");
  const selected = selectProviderEnvironment(requirements.value, parseEnvFile("FASTINO_API_KEY=secret-value\nTYPESAFE_API_KEY=\n"));
  expect(selected).toMatchObject({ ok: false, error: { kind: "missing_credential", entity_id: "TYPESAFE_API_KEY" } });
  expect(JSON.stringify(selected)).not.toContain("secret-value");
});

test("no configured runner selects nothing", () => {
  const requirements = credentialsForRunners([]);
  if (!requirements.ok) throw new Error("an empty selection cannot fail");
  const selected = selectProviderEnvironment(requirements.value, parseEnvFile("TYPESAFE_API_KEY=key\n"));
  expect(selected.ok && selected.value.size).toBe(0);
});

test("assignments are read as data, never expanded or executed", () => {
  const entries = parseEnvFile([`export A="quoted value"`, `B='$(touch pwned)'`, "C=$(touch pwned)", "D=plain # comment", "# E=hidden", "not an assignment"].join("\n"));
  expect([...entries]).toEqual([["A", "quoted value"], ["B", "$(touch pwned)"], ["C", "$(touch pwned)"], ["D", "plain"]]);
});
