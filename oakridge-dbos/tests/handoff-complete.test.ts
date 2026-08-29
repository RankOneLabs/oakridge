import { expect, test } from "bun:test";

import type { ArtifactId, RunRecordVersion, WorkflowRunId } from "../src/domain/primitives";
import { createHandoffCompleteApp } from "../src/http/handoff-complete";

const artifactId = "11111111-1111-4111-8111-111111111111" as ArtifactId;
const runId = "22222222-2222-4222-8222-222222222222" as WorkflowRunId;
const complete = (app: ReturnType<typeof createHandoffCompleteApp>) => app.request(`/handoffs/${artifactId}/external-complete`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ external_kind: "github_review", correlation_id: "pr-review-42" }),
});

test("the public handoff route executes only the run-owned completion command", async () => {
  const kinds: string[] = [];
  const app = createHandoffCompleteApp({ records: { async complete_handoff_artifact(command) {
    kinds.push(command.external_kind);
    return { kind: "released", artifact_id: artifactId, run_id: runId, record_version: 4 as RunRecordVersion };
  } } });
  expect((await complete(app)).status).toBe(202);
  expect(kinds).toEqual(["github_review"]);
});

test("handoff completion replay succeeds without a workflow command", async () => {
  const app = createHandoffCompleteApp({ records: { async complete_handoff_artifact() {
    return { kind: "already_applied" as const, run_id: runId, record_version: 4 as RunRecordVersion };
  } } });
  expect((await complete(app)).status).toBe(202);
});

test("handoff completion reports missing and conflicting waits", async () => {
  const missing = createHandoffCompleteApp({ records: { async complete_handoff_artifact() { return { kind: "wait_not_found" as const, detail: "absent" }; } } });
  const conflict = createHandoffCompleteApp({ records: { async complete_handoff_artifact() { return { kind: "wait_conflict" as const, detail: "wrong kind" }; } } });
  expect((await complete(missing)).status).toBe(404);
  expect((await complete(conflict)).status).toBe(409);
});
