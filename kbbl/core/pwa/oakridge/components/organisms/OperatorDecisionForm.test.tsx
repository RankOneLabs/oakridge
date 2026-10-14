import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { OperatorSchema } from "../../operator-contracts";
import { makeDecision, makeIngressCommitted, makeUnitView } from "../../__fixtures__/read-models";
import { OperatorDecisionForm } from "./OperatorDecisionForm";

const renderForm = (ui: Parameters<typeof render>[0]) => render(ui, { wrapper: ({ children }) =>
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../client", () => ({ submitOperatorDecision: submit }));

const retry = makeDecision({ key: "retry:pr_watch", label: "Retry Pr Watch", payload_schema: "{}", submit: { kind: "retry", worker: "pr_watch" } });
const unit = makeUnitView({ decisions: [retry] });
const schemas: readonly OperatorSchema[] = [{ key: "{}", shape: { kind: "record", fields: [] } }];

beforeEach(() => { localStorage.clear(); submit.mockReset(); submit.mockResolvedValue(makeIngressCommitted()); });
afterEach(cleanup);

test("a repeatable decision can be submitted again after it was accepted", async () => {
  renderForm(<OperatorDecisionForm unit={unit} decision={retry} schemas={schemas} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Submit Retry Pr Watch" }));
  await screen.findByText("Decision accepted.");
  fireEvent.click(screen.getByRole("button", { name: "Submit Retry Pr Watch" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][0].request_id).not.toBe(submit.mock.calls[0][0].request_id);
});

test("a request for changes submits the typed feedback to its review, on its target revision", async () => {
  const feedback = makeDecision({ key: "request_changes", label: "Request Changes", payload_schema: "{feedback: text}",
    fields: [{ key: "feedback", label: "What must change?" }],
    submit: { kind: "review", review: "plan_review", decision: "request_changes", effect: "request_changes", target_revision_id: "plan-2" } });
  const review = makeUnitView({ decisions: [feedback] });
  const feedbackSchemas: readonly OperatorSchema[] = [
    { key: "{feedback: text}", shape: { kind: "record", fields: [{ key: "feedback", schema: "text" }] } },
    { key: "text", shape: { kind: "string", min_length: 0, max_length: Number.MAX_SAFE_INTEGER } },
  ];
  renderForm(<OperatorDecisionForm unit={review} decision={feedback} schemas={feedbackSchemas} onRefresh={() => {}} />);
  fireEvent.change(screen.getByLabelText("What must change?"), { target: { value: "Tighten the risks" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Request Changes" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0]).toMatchObject({ target_revision_id: "plan-2", submit: feedback.submit, payload: { feedback: "Tighten the risks" } });
});
