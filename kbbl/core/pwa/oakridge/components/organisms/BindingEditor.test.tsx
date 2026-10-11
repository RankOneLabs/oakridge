import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { makeDefinitionSummary, makeWorkflowAuthoring } from "../../__fixtures__/read-models";
import { compileOperatorDefinition, pinOperatorDefinition } from "../../client";
import { OperatorDefinitionEditorView } from "../../views/OperatorDefinitionEditorView";

vi.mock("../../client", () => ({ compileOperatorDefinition: vi.fn(), pinOperatorDefinition: vi.fn(),
  fetchOperatorDefinitionDetail: vi.fn() }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("pinned authoring compiles before the operator can pin its generated bindings", async () => {
  vi.mocked(compileOperatorDefinition).mockResolvedValue({});
  vi.mocked(pinOperatorDefinition).mockResolvedValue(makeDefinitionSummary());
  const onPinned = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={onPinned} />
  </QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  await screen.findByText(/Compiled successfully/);
  expect(compileOperatorDefinition).toHaveBeenCalledWith(makeWorkflowAuthoring());
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(pinOperatorDefinition).toHaveBeenCalledWith(makeWorkflowAuthoring()));
  expect(onPinned).toHaveBeenCalledOnce();
});
