import { expect, test } from "bun:test";
import { parseRunInputs } from "../src/validation/run-inputs";

import type { V15RuntimeContext } from "../src/validation/run-inputs";
import type { RepositoryKey } from "../src/domain/primitives";

const context: V15RuntimeContext = {
  brief_notes: "Build the feature", base_branch: "epic/feature",
  repositories: [{ key: "oakridge" as RepositoryKey, path: "/tmp/repository", integration_branch: "main", forge_repository: null }],
  planner: { runtime: "codex", model: null, effort: null },
  builder: { runtime: "codex", model: null, effort: null }, oakridge_url: "http://localhost:8788",
};

test("run input validation preserves legal repository and branch identities", () => {
  expect(parseRunInputs(context)).toEqual({ ok: true, value: context });
});

test("invalid branches are refused before any provisioning, without rewriting them", () => {
  for (const base_branch of [" main ", "../main", "main.lock", "-main", "a//b", "a/.b", "a@{b", "@"])
    expect(parseRunInputs({ ...context, base_branch }).ok).toBe(false);
});

test("repository membership requires unique legal keys and absolute paths", () => {
  for (const repositories of [
    [context.repositories[0], context.repositories[0]],
    [{ ...context.repositories[0], key: "../repo" }],
    [{ ...context.repositories[0], path: "relative/repo" }],
  ]) expect(parseRunInputs({ ...context, repositories }).ok).toBe(false);
});
