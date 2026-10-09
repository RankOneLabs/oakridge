import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { OperatorCommandDefinition, OperatorSchema, OperatorScopeView } from "../../operator-contracts";
import { OperatorCommandForm } from "./OperatorCommandForm";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../client", () => ({ submitOperatorCommand: submit }));

const command: OperatorCommandDefinition = { key: "refresh_pr", label: "Refresh PR", consequence: "Refreshes.", payload_schema: "empty", available_in: [], required: true, field_presentation: [], targets: [] };
const scope = { scope_id: "s1", run_id: "r1", cursor: { scope_version: 1, transition_id: null }, commands: [command], command_targets: {}, command_prefill: {} } as unknown as OperatorScopeView;

const schemas: readonly OperatorSchema[] = [{ key: "empty", shape: { kind: "string", min_length: 0, max_length: 10 } }];

beforeEach(() => { localStorage.clear(); submit.mockReset(); submit.mockResolvedValue({}); });
afterEach(cleanup);

test("a repeatable command can be submitted again after it was accepted", async () => {
  render(<OperatorCommandForm scope={scope} command={command} schemas={schemas} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Submit Refresh PR" }));
  await screen.findByText("Command accepted.");
  fireEvent.click(screen.getByRole("button", { name: "Submit Refresh PR" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][0].request_id).not.toBe(submit.mock.calls[0][0].request_id);
});

test("a review command submits the projected evidence with only the typed feedback", async () => {
  const revision = { brand: "artifact_revision", id: "rev-1" };
  const feedback: OperatorCommandDefinition = { key: "request_changes", label: "Request Changes", consequence: "Revises.", payload_schema: "feedback",
    available_in: [], required: true, field_presentation: [], targets: [] };
  const review = { ...scope, commands: [feedback], command_prefill: { request_changes: { revision } } } as unknown as OperatorScopeView;
  const feedback_schemas: readonly OperatorSchema[] = [
    { key: "feedback", shape: { kind: "record", dictionary: null, fields: [{ key: "revision", schema: "revision", required: true }, { key: "text", schema: "text", required: true }] } },
    { key: "revision", shape: { kind: "reference", brand: "artifact_revision" } },
    { key: "text", shape: { kind: "string", min_length: 1, max_length: 100 } },
  ];
  render(<OperatorCommandForm scope={review} command={feedback} schemas={feedback_schemas} onRefresh={() => {}} />);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tighten the risks" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Request Changes" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0].payload).toEqual({ revision, text: "Tighten the risks" });
});
