import { expect, test } from "bun:test";
import { buildDevelopmentRun } from "../development";
import { configureSchemas, configureScope, DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY } from "./policies";
import type { ScopeDefinition } from "../source-contracts";
import { STAGE_TABLE, buildStageGate } from "./run/stage-table";
import { buildStageChildren, cancelStageChildren } from "./run/stage-table";
import { buildRootDispatch } from "./run/decisions";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("stage table regenerates the shipped completion gates", () => {
  const root = buildDevelopmentRun(DEVELOPMENT_POLICY).scopes.find((scope) => scope.key === "development");
  expect(root?.children.map((child) => child.key)).toEqual(STAGE_TABLE.map((row) => row.key));
  expect(root?.tree.kind === "match" ? root.tree.cases[1]?.node : null)
    .toEqual(buildStageGate(STAGE_TABLE, STAGE_TABLE[0]!, DEVELOPMENT_POLICY));
});

test("both shipped definitions regenerate byte for byte before a version bump", () => {
  for (const policy of [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY]) {
    const generated = JSON.stringify(buildDevelopmentRun(policy), null, 2) + "\n";
    const path = resolve(import.meta.dir, "../../definitions", `${policy.key}.json`);
    expect(generated).toBe(readFileSync(path, "utf8"));
  }
});

test("a stage row owns its dependencies, completion gate and cancellation membership", () => {
  const original = STAGE_TABLE[0]!;
  const changed = { ...original, dependencies: ["analysis"], next_child: "plan" };
  const table = [changed, ...STAGE_TABLE.slice(1)];
  expect(buildStageChildren(table)[0]?.depends_on).toEqual(["analysis"]);
  const before = buildRootDispatch(STAGE_TABLE, DEVELOPMENT_POLICY);
  const after = buildRootDispatch(table, DEVELOPMENT_POLICY);
  if (before.kind !== "match" || after.kind !== "match") throw new Error("root match missing");
  expect(after.cases.slice(2)).toEqual(before.cases.slice(2));
  expect(after.cases[1]?.node).toEqual(buildStageGate(table, changed, DEVELOPMENT_POLICY));
  const added = { ...original, key: "extra", child: { ...original.child, key: "extra" } };
  expect(cancelStageChildren([...STAGE_TABLE, added]).at(-1)).toEqual({ kind: "cancel_children", key: "extra" });
});

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
