import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { makeDefinitionDetail, makeDefinitionSummary, makeWorkflowSource } from "../__fixtures__/read-models";
import { compileOperatorDefinition, fetchOperatorDefinitionDetail, pinOperatorDefinition } from "../client";
import { formatWorkflowText } from "../lib/workflow-definition-form";
import { OperatorDefinitionEditorView } from "./OperatorDefinitionEditorView";

vi.mock("../client", () => ({ compileOperatorDefinition: vi.fn(), pinOperatorDefinition: vi.fn(),
  fetchOperatorDefinitionDetail: vi.fn() }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const renderEditor = (cloneFromId: string | null, onPinned = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OperatorDefinitionEditorView cloneFromId={cloneFromId} onBack={() => undefined} onPinned={onPinned} />
  </QueryClientProvider>);

test("a workflow compiles before the operator can pin it, and pins exactly what compiled", async () => {
  vi.mocked(compileOperatorDefinition).mockResolvedValue({ digest: "digest-1", stages: ["document"] });
  vi.mocked(pinOperatorDefinition).mockResolvedValue(makeDefinitionSummary());
  const onPinned = vi.fn();
  renderEditor(null, onPinned);
  fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: formatWorkflowText(makeWorkflowSource()) } });
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  await screen.findByText(/Compiled successfully/);
  expect(compileOperatorDefinition).toHaveBeenCalledWith(makeWorkflowSource());
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(pinOperatorDefinition).toHaveBeenCalledWith(makeWorkflowSource()));
  expect(onPinned).toHaveBeenCalledOnce();
});

test("text that is not a workflow is refused before it reaches the authority", async () => {
  renderEditor(null);
  fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: '{"workflow": "x"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  await screen.findByRole("alert");
  expect(compileOperatorDefinition).not.toHaveBeenCalled();
});

test("a clone starts from the pinned workflow under a new name", async () => {
  vi.mocked(fetchOperatorDefinitionDetail).mockResolvedValue(makeDefinitionDetail());
  renderEditor("bundle-1");
  await waitFor(() => expect((screen.getByLabelText("Workflow JSON") as HTMLTextAreaElement).value)
    .toContain('"workflow": "review_loop_copy"'));
});
