import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GenericOperatorRunView } from "../views/GenericOperatorRunView";

const schemas = [
  { key: "feedback", shape: { kind: "record", fields: [{ key: "text", schema: "text", required: true }] } },
  { key: "text", shape: { kind: "string", min_length: 1, max_length: 1000 } },
];
const command = (key: string, label: string) => ({ key, label, consequence: label, payload_schema: "feedback",
  field_presentation: [{ key: "text", presentation: { label: "Feedback" } }], targets: [] });
const scope = { scope_id: "scope-1", run_id: "run-1", scope_key: "new_scope", label: "New scope",
  state: { schema: "text", data: { kind: "string", value: "ready" } }, outcome: null, is_terminal: false,
  commands: [command("discuss", "Discuss"), command("change", "Request changes")], outputs: [],
  executions: [{ id: "exec-1", version: 1, worker_key: "new_worker", status: "done", result: { schema: "text", data: { kind: "string", value: "Unregistered artifact" } } }],
  cursor: { scope_version: 7, transition_id: null } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GenericOperatorRunView runId="run-1" onBack={() => {}} /></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("keeps discussion and change drafts separate and submits the observed version", async () => {
  const requests: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    if (options?.method === "POST") { requests.push(JSON.parse(String(options.body))); return json({ kind: "accepted_pending", request_id: "id", transition_id: "transition", scope_version: 8 }, 202); }
    const url = String(input);
    return url.endsWith("/definition") ? json({ bundle_id: "b", digest: "d", source: { schemas, scopes: [] } })
      : url.endsWith("/scopes/scope-1") ? json(scope)
      : json({ run_id: "run-1", scopes: [{ scope_id: "scope-1", scope_key: "new_scope", label: "New scope", version: 7, is_terminal: false, available_commands: ["discuss", "change"] }] });
  });
  mount();
  expect(await screen.findByText("Unregistered artifact")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "Discuss this" } });
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "change" } });
  expect((screen.getByLabelText("Feedback") as HTMLTextAreaElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "Change this" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Request changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ command_key: "change", expected_scope_version: 7, targets: [], payload: { text: "Change this" } });
});

it("replays a pending request with the original ID and payload after remount", async () => {
  const requests: Array<{ request_id: string; payload: unknown }> = [];
  let shouldFail = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)); requests.push(body);
      if (shouldFail) throw new Error("response lost");
      return json({ kind: "accepted_pending", request_id: body.request_id, transition_id: "transition", scope_version: 8 }, 202);
    }
    const url = String(input);
    return url.endsWith("/definition") ? json({ bundle_id: "b", digest: "d", source: { schemas, scopes: [] } })
      : url.endsWith("/scopes/scope-1") ? json(scope)
      : json({ run_id: "run-1", scopes: [{ scope_id: "scope-1", scope_key: "new_scope", label: "New scope", version: 7, is_terminal: false, available_commands: ["discuss"] }] });
  });
  const first = mount();
  fireEvent.change(await screen.findByLabelText("Feedback"), { target: { value: "Keep my feedback" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Discuss" }));
  await screen.findByRole("alert");
  first.unmount();
  shouldFail = false;
  mount();
  await screen.findByText("Command accepted.");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});
