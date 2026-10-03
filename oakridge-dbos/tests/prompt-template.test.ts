import { describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";

import { createPromptTemplateLoader, renderActionPrompt } from "../src/runtime/prompt-template";
import type { PreparedImplementationRepository } from "../src/domain/dev-flow-v15";

describe("production prompt template loading", () => {
  const loader = createPromptTemplateLoader(resolve(import.meta.dir, "../../workflow-config/prompts"));

  test.each([
    "dev-flow/spec_analyzer_v2.md",
    "dev-flow/plan_writer_v2.md",
    "dev-flow/brief_writer.md",
    "dev-flow/build_v2.md",
    "dev-flow/assessor_v2.md",
    "collab/ping_responder.md",
  ])("loads production template %s from workflow-config", async (path) => {
    const template = await loader.load(path);
    expect(template.length).toBeGreaterThan(0);
  });

  test("rejects traversal outside the prompt root", async () => {
    await expect(loader.load("../../package.json")).rejects.toThrow("outside the configured prompt root");
  });

  test("loads a path beneath a filesystem root ending in the platform separator", async () => {
    const repositoryPackage = resolve(import.meta.dir, "../../package.json");
    const rootLoader = createPromptTemplateLoader(sep);

    const template = await rootLoader.load(repositoryPackage.slice(sep.length));

    expect(template.length).toBeGreaterThan(0);
  });

  test("rejects loading the configured root itself", async () => {
    const rootLoader = createPromptTemplateLoader(sep);

    await expect(rootLoader.load(".")).rejects.toThrow("outside the configured prompt root");
  });
});

test("a build revision renders each declared field and the pinned assessment evidence", () => {
  const repository = { refs: { repository_key: "oakridge", repository_path: "/repo", integration_branch: "main",
    base_branch: "epic/schema", base_head_sha: "base" }, worktree_path: "/repo/cohort", worktree_base_sha: "current-base",
    canonical_branch: "cohort/one", expected_pr_base: "epic/schema" } as PreparedImplementationRepository;
  const prompt = renderActionPrompt({ template: "Revise this build.", fields: {
    brief: { id: "brief", version: 2 }, current_build: { build_result: { id: "result", version: 3 },
      pr_summary: { id: "pr", version: 2 } },
    feedback: { source: "assessment", text: "Fix the finding", target: { assessment: { id: "assessment", version: 4 } } },
  }, artifacts: [
    { ref: { id: "result" as never, version: 3 }, artifact_type: "dev.build_result", body: { summary: "current build" } },
    { ref: { id: "assessment" as never, version: 4 }, artifact_type: "dev.assessment",
      body: { verdict: "fail", findings: [{ criterion: "coverage", status: "not_met", description: "missing check" }],
        recommended_next_actions: ["add check"] }, revision_context: { verdict: "fail",
        open_findings: [{ criterion: "coverage", status: "not_met", description: "missing check" }],
        recommended_next_actions: ["add check"] } },
  ], execution: { worker: "build", action_point: "revise", cohort_id: "one" }, repository });
  expect(prompt).toContain("## current_build");
  expect(prompt).toContain("current build");
  expect(prompt).toContain("missing check");
  expect(prompt).toContain("open_findings");
  expect(prompt).toContain("add check");
  expect(prompt).toContain("Fix the finding");
  expect(prompt).toContain("Worktree base: current-base");
  expect(prompt).not.toContain("{{");
});
