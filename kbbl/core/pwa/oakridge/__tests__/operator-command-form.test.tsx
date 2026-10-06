import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import type { OperatorCommandDescriptor, OperatorSchema, OperatorScopeView } from "../operator-contracts";

const command: OperatorCommandDescriptor = { key: "approve", label: "Approve", consequence: "Approve", payload_schema: "payload", field_presentation: [], targets: [] };
const scope: OperatorScopeView = { run_id: "run-1", scope_id: "scope-1", scope_key: "review", label: "Review",
  state: { schema: "flag", data: { kind: "boolean", value: false } }, outcome: null, is_terminal: false,
  commands: [command], outputs: [], executions: [], cursor: { scope_version: 4, transition_id: null } };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it.each([{ kind: "boolean", raw: "" }, { kind: "boolean", raw: "yes" }, { kind: "integer", raw: "" }, { kind: "integer", raw: "1.5" }])
  ("does not submit invalid top-level $kind input $raw", async ({ kind, raw }) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const schema: OperatorSchema = { key: "payload", shape: kind === "boolean" ? { kind: "boolean" } : { kind: "integer", min: 0, max: 10 } };
    render(<OperatorCommandForm scope={scope} command={command} schemas={[schema]} onRefresh={() => {}} />);
    fireEvent.change(screen.getByLabelText("Payload"), { target: { value: raw } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
it("submits a reference-typed record field as an object", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ kind: "accepted_pending" }), { status: 202 }));
  const schemas: OperatorSchema[] = [
    { key: "payload", shape: { kind: "record", fields: [{ key: "specimen", schema: "revision", required: true }] } },
    { key: "revision", shape: { kind: "reference", brand: "artifact_revision" } },
  ];
  render(<OperatorCommandForm scope={scope} command={command} schemas={schemas} onRefresh={() => {}} />);
  fireEvent.change(screen.getByLabelText("specimen"), { target: { value: '{"brand":"artifact_revision","id":"revision-1"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ payload: { specimen: { brand: "artifact_revision", id: "revision-1" } } });
});
