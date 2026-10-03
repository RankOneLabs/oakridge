import { expect, test } from "bun:test";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { createImplementationCohortHarness } from "./support/implementation-cohort-harness";

test("requesting build corrections preserves the operator's route to both reviewed drafts", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    await fixture.execute(0, { kind: "publish", commit_build: true, publications: [
      { output_name: "build_result", body: { summary: "draft implementation" } },
      { output_name: "pr_summary", body: { pr_url: "https://github.com/example/oakridge/pull/1",
        repository_key: "oakridge", branch: "cohort/core", base_branch: "epic/schema", summary: "draft PR" } },
    ] });
    const output = await fixture.build();
    if (!output.build_result || !output.pr_summary || !output.head_sha) throw new Error("build is missing outputs");
    await fixture.advance({ kind: "request_build_changes", feedback: { source: "build_review", text: "Add coverage",
      target: { outputs: { build_result: output.build_result, pr_summary: output.pr_summary }, head_sha: output.head_sha } } });
    const projections = new PostgresOperatorProjectionRepository(fixture.sql, "shadow", createDevFlowAdapterRegistry());
    const run = await projections.get_run(fixture.run_id);
    expect(run?.stages.find((stage) => stage.name === "implementation")?.artifacts.map((artifact) => artifact.type_id).sort())
      .toEqual(["dev.build_result", "dev.pr_summary"]);
  } finally { await fixture.close(); }
}, 30_000);
