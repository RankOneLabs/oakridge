import { expect, test } from "bun:test";
import { CoreClient, compileDefinition } from "../src/core-client/client";
import { readLaunchableCatalog } from "../src/runtime/definition-store";
import { selectDefinitionDetail } from "../src/projections/definition-view";

test("development detail preserves authored uses alongside compiled declarations", async () => {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  try {
    const compiled = await compileDefinition(core.value, catalog.value.development.definition_id);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    const detail = selectDefinitionDetail(compiled.value);
    for (const stage of Object.values(detail.effective_workflow.stages)) {
      const paths = [
        ...Object.values(stage.workers).flatMap(worker => worker.kind === "agent" ? Object.values(worker.prompts).filter((path): path is string => typeof path === "string") : []),
        ...Object.values(stage.reviews ?? {}).flatMap(review => review.prompt ? [review.prompt] : []),
      ];
      for (const path of paths) expect(detail.prompts[path]).toBeDefined();
    }
    const prompt = detail.prompts["development/brief.md"];
    expect(prompt.digest).toBe(compiled.value.prompt_ids["development/brief.md"]);
    const stored = await Bun.file(new URL("../../workflow-config/definitions/prompts/" + prompt.digest + ".md", import.meta.url)).text();
    expect(prompt.body).toBe(stored);
    expect(detail.workflow.stages.cohort?.workers.pr_watch).toEqual({ template: "pr_watch" });
    expect(detail.effective_workflow.stages.cohort?.workers.pr_watch).toMatchObject({ kind: "code", operation: "pull_request.observe" });
    const authored = detail.workflow.stages.planning?.reviews?.plan_review;
    expect(authored && "decisions" in authored ? authored.decisions : null).toMatchObject({ set: "accept_or_request" });
    expect(detail.effective_workflow.stages.planning?.reviews?.plan_review?.decisions).toHaveProperty("accept");
    expect(detail.effective_workflow.stages.analysis?.reviews?.analysis_review?.decisions.accept?.when).toMatchObject({
      reason: "Resolve every blocking finding and choose an option for every operator decision before accepting the analysis.",
    });
  } finally { core.value.close(); }
});

test("launchable prompt projection preserves committed bytes and references", async () => {
  const { resolveDefinition, referencedPromptPaths, bytesIdentity } = await import("../src/runtime/definition-store");
  const { selectDefinitionPrompts } = await import("../src/projections/definition-view");
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw catalog.error;
  for (const entry of Object.values(catalog.value)) {
    const resolved = resolveDefinition(entry.definition_id);
    if (!resolved.ok) throw resolved.error;
    const prompts = selectDefinitionPrompts(resolved.value);
    expect(Object.keys(prompts).sort()).toEqual([...referencedPromptPaths(resolved.value.source)].sort());
    for (const [path, prompt] of Object.entries(prompts)) {
      expect(prompt.digest).toBe(resolved.value.prompt_ids[path]);
      expect(prompt.body).toBe(resolved.value.prompts[path]);
      expect(bytesIdentity(new TextEncoder().encode(prompt.body))).toBe(prompt.digest);
    }
  }
});
