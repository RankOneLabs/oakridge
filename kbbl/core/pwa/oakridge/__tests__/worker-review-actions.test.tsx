import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkerReviewActions } from "../components/organisms/WorkerReviewActions";
import { OakridgeHttpError, submitCohortRequest } from "../client";
import type { OperatorArtifactReviewContext } from "../../../../../oakridge-dbos/src/domain/v15-operator-review";

vi.mock("../client", async (importOriginal) => ({ ...await importOriginal<typeof import("../client")>(), submitCohortRequest: vi.fn().mockResolvedValue({ commits: 1 }) }));
afterEach(() => vi.clearAllMocks());

it("assessment review explains all three routes and discussion sends feedback to the assessor", async () => {
  const context: OperatorArtifactReviewContext = { worker: "assessment", cohort_id: "cohort" as never, expected_version: 7,
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

it.each([true, false])("review retry handles definitive rejection=%s", async (isDefinitive) => {
  const context: OperatorArtifactReviewContext = { worker: "spec", cohort_id: "cohort" as never, expected_version: 7,
    target: { id: "brief" as never, version: 1 } };
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  vi.mocked(submitCohortRequest).mockRejectedValueOnce(isDefinitive ? new OakridgeHttpError(409, "version conflict") : new TypeError("network lost"));
  const view = render(<QueryClientProvider client={client}><WorkerReviewActions context={context} runId="run" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Accept analysis" }));
  await screen.findByRole("alert");
  const first = vi.mocked(submitCohortRequest).mock.calls[0]?.[0];
  if (isDefinitive) {
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["oakridge", "run", "run"], ["oakridge", "artifact"], ["oakridge", "review-inbox"],
    ]);
    view.rerender(<QueryClientProvider client={client}><WorkerReviewActions context={{ ...context, expected_version: 8 }} runId="run" /></QueryClientProvider>);
  } else expect(invalidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Accept analysis" }));
  await screen.findByText("Decision recorded.");
  const second = vi.mocked(submitCohortRequest).mock.calls[1]?.[0];
  expect(second?.expected_version).toBe(isDefinitive ? 8 : 7);
  expect(second?.id === first?.id).toBe(!isDefinitive);
});
