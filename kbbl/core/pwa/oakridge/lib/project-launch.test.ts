import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { OperatorProjectView, OperatorSchema } from "../operator-contracts";
import { selectProjectLaunchDrafts } from "./project-launch";
import { selectProjectDraft } from "./project-draft";

interface Bundle { readonly root: string; readonly schemas: readonly OperatorSchema[]; readonly scopes: readonly { readonly key: string; readonly input_schema: string }[] }
const bundle: Bundle = JSON.parse(readFileSync(resolve(process.cwd(), "../../../workflow-config/definitions/development.json"), "utf8"));
const root = bundle.scopes.find((scope) => scope.key === bundle.root)!;
const rootShape = bundle.schemas.find((schema) => schema.key === root.input_schema)!.shape;
const fields = rootShape.kind === "record" ? rootShape.fields.map((field) => ({ field, schema: bundle.schemas.find((schema) => schema.key === field.schema) })) : [];
const project = { id: "p1", name: "scout", repo_dir: "/home/steve/codes/rol/scout", created_at: "2026-08-29",
  forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" }, integration_branch: "main" } as OperatorProjectView;

test("a project fills the development launch's repositories and sessions, leaving the spec to the operator", () => {
  const drafts = selectProjectLaunchDrafts(project, fields, bundle.schemas);
  expect(Object.keys(drafts).sort()).toEqual(["analysis", "briefs", "final_merge_policy", "planning", "repositories", "sessions"]);
  expect(JSON.parse(drafts.repositories!)).toEqual([{ key: "scout", preparation: { repository_path: project.repo_dir, expected_head: null },
    build: { runtime: "claude-code", workdir: project.repo_dir, session_name: "scout-build" },
    integration: { runtime: "claude-code", workdir: project.repo_dir, session_name: "scout-integration" },
    forge: { owner: "RankOneLabs", name: "scout", build_base: "main", final_base: "main" } }]);
  expect(JSON.parse(drafts.analysis!)).toEqual({ runtime: "claude-code", workdir: project.repo_dir, session_name: "scout-analysis" });
  expect(JSON.parse(drafts.final_merge_policy!)).toBe("require_merge");
  expect(JSON.parse(drafts.sessions!)).toEqual(Object.fromEntries(
    ["planner", "worker", "spec_analysis", "planning", "brief_writing", "implementation", "final_integration"]
      .map((stage) => [stage, { runtime: null, model: null, effort: null }])));
});

test("a project without a forge repository leaves the repositories for the operator", () => {
  const drafts = selectProjectLaunchDrafts({ ...project, forge_repository: null }, fields, bundle.schemas);
  expect(drafts.repositories).toBeUndefined();
  expect(drafts.planning).toBeDefined();
});

test("a project without an integration branch leaves the repositories for the operator", () => {
  const drafts = selectProjectLaunchDrafts({ ...project, integration_branch: null }, fields, bundle.schemas);
  expect(drafts.repositories).toBeUndefined();
});

test("blank optional project fields are stored as absent", () => {
  expect(selectProjectDraft({ name: " scout ", repo_dir: "/r", owner: "", repository: "scout", integration_branch: " " }))
    .toEqual({ name: "scout", repo_dir: "/r", forge_repository: null, integration_branch: null });
});
