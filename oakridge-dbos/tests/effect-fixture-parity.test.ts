import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { operationBundle, sessionBundle } from "./effect-fixture";

test("effect fixture worker result schemas equal their shipped declarations", async () => {
  const shipped: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
  const expected = [
    shipped.scopes.find((scope) => scope.key === "repository_preparation")!.workers.find((worker) => worker.key === "preparation")!.result_schema,
    shipped.scopes.find((scope) => scope.key === "implementation")!.workers.find((worker) => worker.key === "pr_observer")!.result_schema,
    shipped.scopes.find((scope) => scope.key === "spec_analysis")!.workers.find((worker) => worker.key === "author")!.result_schema,
  ];
  const fixtures = [await operationBundle("repository.prepare"), await operationBundle("pull_request.observe"), await sessionBundle()];
  expect(fixtures.map((bundle) => bundle.scopes[0]!.workers[0]!.result_schema)).toEqual(expected);
  const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  try {
    for (const bundle of fixtures) expect(await started.value.request("compile", { bundle })).toMatchObject({ ok: true, value: { kind: "compiled" } });
  } finally { started.value.close(); }
});
