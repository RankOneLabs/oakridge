import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import type { OperatorCommandDescriptor, OperatorScopeView } from "../operator-contracts";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const noteSchemas = (min_length: number) => [
  { key: "text", shape: { kind: "string", min_length, max_length: 100 } },
  { key: "payload", shape: { kind: "record", fields: [{ key: "note", schema: "text", required: true }], dictionary: null } },
] as const;
const noteCommand = { key: "act", label: "Act", consequence: "Go", payload_schema: "payload",
  field_presentation: [], targets: [] } as unknown as OperatorCommandDescriptor;
const noteScope = (scope_version: number) => ({ run_id: "run-one", scope_id: "scope-one", commands: [noteCommand], outputs: [],
  cursor: { scope_version, transition_id: null }, command_targets: { act: [] } }) as unknown as OperatorScopeView;

test("a required string that admits an empty value submits as the empty string", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ kind: "accepted_pending", request_id: "r", transition_id: "t", scope_version: 2 }));
  vi.stubGlobal("fetch", fetch);
  render(<OperatorCommandForm scope={noteScope(1)} command={noteCommand} schemas={noteSchemas(0) as never} onRefresh={() => undefined} />);
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").required).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Submit Act" }));
  await screen.findByText("Command accepted.");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).payload).toEqual({ note: "" });
});

test("a required string with a positive minimum is refused empty and never sent", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<OperatorCommandForm scope={noteScope(1)} command={noteCommand} schemas={noteSchemas(1) as never} onRefresh={() => undefined} />);
  fireEvent.submit(screen.getByTestId("operator-command-form"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/note is required/);
  expect(fetch).not.toHaveBeenCalled();
});
