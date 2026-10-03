import { expect, it } from "vitest";
import { selectWorkerReviewActions } from "./worker-review-actions";
import { selectWorkerRetryRequest } from "./worker-retry-request";
import type { OperatorArtifactReviewContext } from "../../../../../oakridge-dbos/src/domain/v15-operator-review";
import type { V15WorkerKey } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";

it("brief decisions address the whole accepted-plan collection", () => {
  const target = { members: [{ cohort_key: "api" as never, ref: { id: "one" as never, version: 2 } },
    { cohort_key: "web" as never, ref: { id: "two" as never, version: 3 } }] };
  const context: OperatorArtifactReviewContext = { worker: "brief", cohort_id: "cohort" as never, expected_version: 8, target };
  const actions = selectWorkerReviewActions(context);
  expect(actions.map((action) => action.kind === "immediate" ? action.request : action.request("Clarify both briefs")))
    .toEqual([{ kind: "accept_briefs", target }, { kind: "revise_briefs", feedback: { text: "Clarify both briefs", target } }]);
});
it("assessment discussion stays distinct from implementation changes", () => {
  const target = { assessment: { id: "assessment" as never, version: 2 }, build: {
    outputs: { build_result: { id: "build" as never, version: 1 }, pr_summary: { id: "pr" as never, version: 1 } }, pr_url: "https://github.com/example/repo/pull/3", head_sha: "sha" as never } };
  const context: OperatorArtifactReviewContext = { worker: "assessment", cohort_id: "cohort" as never, expected_version: 8, target };
  expect(selectWorkerReviewActions(context).map((action) => action.kind === "immediate" ? action.request : action.request("Explain finding")))
    .toEqual([{ kind: "accept_assessment", target }, { kind: "request_implementation_changes", feedback: { source: "assessment", text: "Explain finding", target } },
      { kind: "discuss_assessment", feedback: { text: "Explain finding", target } }]);
});
it("final confirmation carries the exact summary, URL and verified head", () => {
  const target = { pr_summary: { id: "summary" as never, version: 4 }, pr_url: "https://github.com/example/repo/pull/3", head_sha: "sha" as never };
  const context: OperatorArtifactReviewContext = { worker: "final_integration", cohort_id: "cohort" as never, expected_version: 8, target };
  expect(selectWorkerReviewActions(context).map((action) => action.kind === "immediate" ? action.request : null))
    .toEqual([{ kind: "confirm_merged", target }, { kind: "closed_without_merge", target }]);
});
it("each interrupted worker has its own typed retry", () => {
  const workers: V15WorkerKey[] = ["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"];
  expect(workers.map((worker) => selectWorkerRetryRequest(worker).kind))
    .toEqual(["retry_provision", "retry_analysis", "retry_plan", "retry_briefs", "retry_build", "retry_assessment", "retry_final_integration"]);
});
