import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkerReviewActions } from "../components/organisms/WorkerReviewActions";
import { submitCohortRequest } from "../client";
import type { OperatorArtifactReviewContext } from "../../../../../oakridge-dbos/src/domain/v15-operator-review";

vi.mock("../client", () => ({ submitCohortRequest: vi.fn().mockResolvedValue({ commits: 1 }) }));
afterEach(() => vi.clearAllMocks());

it("assessment review explains all three routes and discussion sends feedback to the assessor", async () => {
  const context: OperatorArtifactReviewContext = { worker: "assessment", cohort_id: "cohort" as never, expected_version: 7,
    allowed_request_kinds: ["accept_assessment", "request_implementation_changes", "discuss_assessment"],
    target: { assessment: { id: "assessment" as never, version: 2 }, build: {
      outputs: { build_result: { id: "build" as never, version: 1 }, pr_summary: { id: "pr" as never, version: 1 } },
      pr_url: "https://github.com/example/repo/pull/1", head_sha: "sha" as never } } };
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkerReviewActions context={context} runId="run" /></QueryClientProvider>);
  const description = (label: string) => document.getElementById(screen.getByRole("button", { name: label }).getAttribute("aria-describedby")!)?.textContent;
  expect(description("Accept assessment")).toBe("Accept this assessment and wait for the implementation pull request to merge.");
  expect(description("Request implementation changes")).toBe("Return this implementation to the builder with your feedback and assessment findings.");
  expect(description("Discuss assessment")).toBe("Ask the assessor to explain or revise this assessment while retaining the accepted build.");
  fireEvent.click(screen.getByRole("button", { name: "Discuss assessment" }));
  fireEvent.change(screen.getByLabelText("Discuss assessment"), { target: { value: "Explain the finding" } });
  fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(submitCohortRequest).toHaveBeenCalledWith(expect.objectContaining({
    cohort_id: "cohort", expected_version: 7, request: { kind: "discuss_assessment", feedback: { text: "Explain the finding", target: context.target } },
  })));
});
