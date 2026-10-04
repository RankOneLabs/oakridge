import { expect, test } from "bun:test";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { createImplementationCohortHarness } from "./support/implementation-cohort-harness";

test("frozen implementation repository and brief identity reach run detail and the review inbox", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.sql.query("UPDATE oakridge.cohort_worker SET state='awaiting_review' WHERE cohort_id=$1 AND worker='build'", [fixture.cohort_id]);
    const projections = new PostgresOperatorProjectionRepository(fixture.sql, "shadow", createDevFlowAdapterRegistry());
    const run = await projections.get_run(fixture.run_id);
    const inbox = await projections.get_review_inbox();
    const unit = run?.stages.find((stage) => stage.name === "implementation")?.units[0];
    expect({ repository: unit?.repository_key, branch: unit?.worktree?.branch, workers: unit?.workers.map((worker) => worker.worker) })
      .toEqual({ repository: "oakridge", branch: "cohort/core", workers: ["build", "assessment"] });
    expect(inbox.items[0]).toEqual(expect.objectContaining({ repository_key: "oakridge", title: "Boundary proof", stage_name: "implementation" }));
  } finally { await fixture.close(); }
}, 30_000);
