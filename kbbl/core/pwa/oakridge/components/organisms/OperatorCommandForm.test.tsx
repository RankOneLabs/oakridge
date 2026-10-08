import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { OperatorCommandDescriptor, OperatorSchema, OperatorScopeView } from "../../operator-contracts";
import { OperatorCommandForm } from "./OperatorCommandForm";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../client", () => ({ submitOperatorCommand: submit }));

const command: OperatorCommandDescriptor = { key: "refresh_pr", label: "Refresh PR", consequence: "Refreshes.", payload_schema: "empty", field_presentation: [], targets: [] };
const scope = { scope_id: "s1", run_id: "r1", cursor: { scope_version: 1, transition_id: null }, commands: [command] } as unknown as OperatorScopeView;

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
