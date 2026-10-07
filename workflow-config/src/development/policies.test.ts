import { expect, test } from "bun:test";
import { buildDevelopmentRun } from "../development";
import { configureSchemas, configureScope, DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY } from "./policies";
import type { ScopeDefinition } from "../source-contracts";
import { STAGE_TABLE, buildStageGate } from "./run/stage-table";
import { buildStageChildren, cancelStageChildren } from "./run/stage-table";
import { buildRootDispatch } from "./run/decisions";
import { renderPromptFiles } from "./prompts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

test("stage table regenerates the shipped completion gates", () => {
  const root = buildDevelopmentRun(DEVELOPMENT_POLICY).scopes.find((scope) => scope.key === "development");
  expect(root?.children.map((child) => child.key)).toEqual(STAGE_TABLE.map((row) => row.key));
  expect(root?.tree.kind === "match" ? root.tree.cases[1]?.node : null)
    .toEqual(buildStageGate(STAGE_TABLE, STAGE_TABLE[0]!, DEVELOPMENT_POLICY));
});

test("all shipped definitions regenerate byte for byte", () => {
  for (const policy of [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY]) {
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

test("a bumped bundle uses generated prompt paths and keeps shipped prompt bytes", () => {
  const run = buildDevelopmentRun(DEVELOPMENT_POLICY);
  expect(run.version).toBe(3);
  expect(run.prompts).toHaveLength(21);
  expect(run.prompts.every((prompt) => prompt.key.endsWith("_v3") && prompt.path.includes("/v3/"))).toBe(true);
  const legacyDigests: Record<string, string> = {
    spec_analysis_author: "000d4ce14d29be748b3ee4de65fa22448535f7a23250e65e228acf61f8585aa3",
    planning_author: "3c64ff0386aada30d98a22243f2d66e33934762b3d612881a081b8325d5c25e3",
    brief_writing_author: "81472b06de2ce081dbebf7676366438d1caf4c11bca8e93811d9c426b5e953b8",
    implementation_build: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d",
    implementation_assessment: "1eedf6fed0596bda856079312bb54c00d55b711d11a224e9d7346053df026e4d",
    final_integration_integrator: "3ed66e609965916aadd144a23078a01debf7da4c48eab6364786d4631c902939"
  };
  let legacyCount = 0;
  for (const [group, digest] of Object.entries(legacyDigests)) {
    const names = new Bun.Glob(`${group}_*.md`).scanSync(resolve(import.meta.dir, "../../prompts/dev-flow"));
    for (const name of names) {
      legacyCount += 1;
      const bytes = readFileSync(resolve(import.meta.dir, "../../prompts/dev-flow", name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    }
  }
  expect(legacyCount).toBe(21);
  for (const prompt of run.prompts) {
    const bytes = readFileSync(resolve(import.meta.dir, "../../..", prompt.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(prompt.content_digest);
  }
});

test("verification bundle has a distinct stage count, root input and command set", () => {
  const standard = buildDevelopmentRun(DEVELOPMENT_POLICY);
  const verification = buildDevelopmentRun(VERIFICATION_POLICY);
  const base = standard.scopes.find((scope) => scope.key === standard.root)!;
  const variant = verification.scopes.find((scope) => scope.key === verification.root)!;
  expect(variant.children).toHaveLength(base.children.length + 1);
  expect(variant.input_schema).not.toBe(base.input_schema);
  expect(variant.commands.map((command) => command.key)).not.toEqual(base.commands.map((command) => command.key));
  expect(verification.scopes.find((scope) => scope.key === "implementation")?.pools[0]?.limit).toBe(3);
  expect(verification.schemas.find((schema) => schema.key === "pr_query")?.shape).toEqual(
    buildDevelopmentRun(INDEPENDENT_SIBLINGS_POLICY).schemas.find((schema) => schema.key === "pr_query")?.shape);
});

test("the three deliberate inter-bundle differences stay visible", () => {
  const standard = buildDevelopmentRun(DEVELOPMENT_POLICY);
  const independent = buildDevelopmentRun(INDEPENDENT_SIBLINGS_POLICY);
  expect(standard.scopes.find((scope) => scope.key === "implementation")?.pools[0]?.limit).toBe(4);
  expect(independent.scopes.find((scope) => scope.key === "implementation")?.pools[0]?.limit).toBe(2);
  expect(standard.scopes.find((scope) => scope.key === "development")?.tree)
    .not.toEqual(independent.scopes.find((scope) => scope.key === "development")?.tree);
  expect(standard.schemas.find((schema) => schema.key === "repo_result")?.shape)
    .not.toEqual(independent.schemas.find((schema) => schema.key === "repo_result")?.shape);
});

test("check mode reports a generated prompt file that no stage row still claims", () => {
  const table = STAGE_TABLE.map((row) => ({
    ...row,
    prompt_groups: row.prompt_groups.filter((group) => group.prefix !== "planning_author")
  }));
  const findings = renderPromptFiles(true, table);
  expect(findings.filter((finding) => finding.kind === "content_drift")).toEqual([]);
  expect(findings.map((finding) => finding.path)).toEqual([
    "workflow-config/prompts/dev-flow/v3/planning_author_initial.md",
    "workflow-config/prompts/dev-flow/v3/planning_author_retry.md",
    "workflow-config/prompts/dev-flow/v3/planning_author_revise.md"
  ]);
  expect(renderPromptFiles(true)).toEqual([]);
});
