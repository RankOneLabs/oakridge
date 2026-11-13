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
    const compiled = await compileDefinition(core.value, catalog.value.development);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    const detail = selectDefinitionDetail(compiled.value);
    expect(detail.workflow.stages.cohort?.workers.pr_watch).toEqual({ template: "pr_watch" });
    expect(detail.effective_workflow.stages.cohort?.workers.pr_watch).toMatchObject({ kind: "code", operation: "pull_request.observe" });
    const authored = detail.workflow.stages.analysis?.reviews?.analysis_review;
    expect(authored && "decisions" in authored ? authored.decisions : null).toMatchObject({ set: "accept_or_request" });
    expect(detail.effective_workflow.stages.analysis?.reviews?.analysis_review?.decisions).toHaveProperty("accept");
  } finally { core.value.close(); }
});
