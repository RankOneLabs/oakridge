import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GenericOperatorRunView } from "../views/GenericOperatorRunView";
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

/** A run whose single command takes one free-text field, with the scope version under the test's control. */
function versionedRun(initial: number, onCommand: () => Response = () => Response.json({ error: "unexpected" }, { status: 500 })) {
  const state = { version: initial };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/commands") && init?.method === "POST") return onCommand();
    if (url.endsWith("/runs/run-one")) return Response.json({ run_id: "run-one", scopes: [{ scope_id: "scope-one", scope_key: "root", label: "Root" }] });
    if (url.endsWith("/definition")) return Response.json({ source: { root: "root", schemas: noteSchemas(0) } });
    if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
    return Response.json({ scope_id: "scope-one", run_id: "run-one", label: "Root", state: { schema: "text", data: { kind: "string", value: "s" } },
      outcome: null, outputs: [], executions: [], commands: [noteCommand], command_targets: { act: [] }, cursor: { scope_version: state.version } });
  });
  vi.stubGlobal("fetch", fetch);
  return { state, fetch };
}
const mountRun = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><GenericOperatorRunView runId="run-one" onBack={() => undefined} /></QueryClientProvider>);
  return cache;
};

test("typed input survives a background scope version bump", async () => {
  const { state } = versionedRun(1);
  const cache = mountRun();
  fireEvent.change(await screen.findByLabelText("note"), { target: { value: "half-written" } });
  state.version = 2;
  await cache.invalidateQueries({ queryKey: ["operator", "run-one"] });
  await waitFor(() => expect(cache.getQueryData<{ cursor: { scope_version: number } }>(["operator", "run-one", "scope", "scope-one"])?.cursor.scope_version).toBe(2));
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").value).toBe("half-written");
});

test("a version-conflict rejection stays visible, with the typed input, after the refresh it triggers", async () => {
  const { state } = versionedRun(1, () => { state.version = 2; return Response.json({ error: "conflict", detail: "scope version changed" }, { status: 409 }); });
  const cache = mountRun();
  fireEvent.change(await screen.findByLabelText("note"), { target: { value: "my words" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Act" }));
  await waitFor(() => expect(cache.getQueryData<{ cursor: { scope_version: number } }>(["operator", "run-one", "scope", "scope-one"])?.cursor.scope_version).toBe(2));
  expect((await screen.findByRole("alert")).textContent).toMatch(/scope version changed/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").value).toBe("my words");
});
