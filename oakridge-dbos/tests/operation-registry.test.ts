import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient, compileWorkflow } from "../src/core-client/client";
import type { TypeExpression } from "../src/core-client/core-types";
import { OPERATION_REGISTRY, TYPE_VARIABLE } from "../src/operations/registry";
import { createOperationRunner } from "../src/operations/runner";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";

test("the registry declares the in-process operations, and session.run is not one", () => {
  expect(OPERATION_REGISTRY.map((operation) => operation.key)).toEqual(["repository.prepare", "pull_request.observe", "value.publish"]);
  for (const operation of OPERATION_REGISTRY)
    expect(Object.keys(operation).sort()).toEqual(["error_codes", "input_schema", "key", "output_schema"]);
});

test("the checked-in registry data is the registry the compiler is given", async () => {
  const exported = await Bun.file(resolve(import.meta.dir, "../../workflow-config/operation-registry.json")).json();
  expect(exported).toEqual(JSON.parse(JSON.stringify(OPERATION_REGISTRY)));
});

test("a code worker of each registered operation compiles against its declared contract", async () => {
  const started = CoreClient.start();
  if (!started.ok) throw new Error("core WASM did not load");
  const core = started.value;
  try {
    // A generic operation's type variable stands for whatever the workflow binds it to; here, text.
    const bound = (schema: unknown): TypeExpression => JSON.parse(JSON.stringify(schema).replaceAll(`"${TYPE_VARIABLE}"`, `"text"`));
    const compiled = await Promise.all(OPERATION_REGISTRY.map((operation) => {
      const inputs = Object.fromEntries(Object.keys(operation.input_schema).map((field) => [field, `input.${field}`]));
      return compileWorkflow(core, { prompts: {}, workflow: { workflow: "operation_contract", input: bound(operation.input_schema),
        run: { units: { only: { stage: "only", input: inputs } }, outcome: {} },
        stages: { only: { input: bound(operation.input_schema), artifacts: { output: { schema: bound(operation.output_schema) } },
          workers: { call: { kind: "code", operation: operation.key, inputs, creates: ["output"] } }, done_when: "published(output)", outcome: {} } } } });
    }));
    expect(compiled.map((result) => result.ok ? "compiled" : result.error.detail)).toEqual(["compiled", "compiled", "compiled"]);
  } finally { core.close(); }
});

test("an unregistered operation or a malformed input fails the attempt rather than throwing", async () => {
  const runner = createOperationRunner({ git: new BunGitCommandRunner(), pull_requests: null });
  const outcomes = await Promise.all([runner.run({ operation: "session.run", inputs: {} }), runner.run({ operation: "repository.prepare", inputs: { repository_path: 7 } })]);
  expect(outcomes.map((outcome) => outcome.kind === "failed" ? outcome.code : outcome.kind)).toEqual(["invalid_instruction", "invalid_instruction"]);
});

test("pull_request.observe without a reader fails as discovery_unsupported", async () => {
  const runner = createOperationRunner({ git: new BunGitCommandRunner(), pull_requests: null });
  const outcome = await runner.run({ operation: "pull_request.observe",
    inputs: { query: { owner: "o", name: "n", head_owner: "o", head_branch: "b", base_branch: "main", pr_url: "https://github.com/o/n/pull/1" } } });
  expect(outcome.kind === "failed" ? outcome.code : outcome.kind).toBe("discovery_unsupported");
});

test("value.publish returns its input value as the artifact body", async () => {
  const runner = createOperationRunner({ git: new BunGitCommandRunner(), pull_requests: null });
  const outcomes = await Promise.all([runner.run({ operation: "value.publish", inputs: { value: { title: "brief" } } }),
    runner.run({ operation: "value.publish", inputs: {} })]);
  expect(outcomes).toEqual([{ kind: "succeeded", body: { title: "brief" } },
    { kind: "failed", code: "invalid_instruction", detail: "inputs do not match value.publish's input schema" }]);
});
