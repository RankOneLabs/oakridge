import { expect, test } from "bun:test";
import { buildDevelopmentRun } from "../development";
import { configureSchemas, configureScope, DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY } from "./policies";
import type { ScopeDefinition } from "../source-contracts";

function implementationScope(): ScopeDefinition {
  const scope = buildDevelopmentRun(DEVELOPMENT_POLICY).scopes.find((item) => item.key === "implementation");
  if (!scope) throw new Error("implementation scope missing");
  return scope;
}

test("a run can change capacity without selecting the independent-siblings example", () => {
  const run = buildDevelopmentRun({ ...DEVELOPMENT_POLICY, implementation_capacity: 8 });
  expect(run.scopes.find((scope) => scope.key === "implementation")?.pools)
    .toEqual([{ key: "implementation_slots", limit: 8 }]);
});

test("alternate schema ordering preserves newly declared fields and finds schemas by name", () => {
  const schemas = buildDevelopmentRun(DEVELOPMENT_POLICY).schemas;
  const repository = schemas.find((schema) => schema.key === "repo_result");
  if (!repository || repository.shape.kind !== "record") throw new Error("repository result missing");
  const extended = { ...repository, shape: { ...repository.shape,
    fields: [{ key: "extra", schema: "text", required: false }, ...repository.shape.fields] } };
  const configured = configureSchemas([extended, ...schemas.filter((schema) => schema.key !== repository.key)], INDEPENDENT_SIBLINGS_POLICY);
  const result = configured.find((schema) => schema.key === "repo_result");
  expect(result?.shape.kind === "record" ? result.shape.fields.map((field) => field.key) : null)
    .toEqual(["repository_path", "head", "push_remote_owner", "extra"]);
});

test("alternate provider input ordering follows the selected worker after worker reordering", () => {
  const scope = implementationScope();
  const configured = configureScope({ ...scope, workers: [...scope.workers].reverse() }, INDEPENDENT_SIBLINGS_POLICY);
  const input = configured.workers.find((worker) => worker.key === "pr_observer")?.actions[0]?.input;
  const query = input?.kind === "record" ? input.fields.find((field) => field.key === "query")?.value : null;
  expect(query?.kind === "record" ? query.fields.map((field) => field.key) : null)
    .toEqual(["owner", "name", "head_branch", "base_branch", "head_owner"]);
});

test("editing one built run does not change subsequently built configuration", () => {
  const first = implementationScope();
  const pool = first.pools.find((pool) => pool.key === "implementation_slots");
  if (!pool) throw new Error("implementation capacity missing");
  first.pools.splice(0, first.pools.length);
  expect(implementationScope().pools).toEqual([{ key: "implementation_slots", limit: 4 }]);
});
