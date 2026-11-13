import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GradingConfigView } from "../views/GradingConfigView";
import { OakridgeShell } from "../OakridgeShell";
import { useHashRoute } from "../../hooks/useHashRoute";
import { atPath } from "../lib/grading-config";
import { configRead, publishedConfig } from "./grading-config-fixture";
import type { ObservationJsonValue as Json } from "../grading-contracts/domain/primitives";

vi.mock("../views/RunListView", () => ({ RunListView: () => <p>Run browser</p> }));
vi.mock("../views/WorkflowDefListView", () => ({ WorkflowDefListView: () => <p>Workflow browser</p> }));
const path = "#/oakridge/grading-config";
let client: QueryClient;
beforeEach(() => {
  window.history.replaceState(null, "", path);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("confirm", vi.fn(() => false));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/config")) return Response.json({ available: true });
    if (url.endsWith("/draft") && init?.method === "PUT") return Response.json({ digest: "saved", document: { status: "draft", definitions: atPath(JSON.parse(String(init.body)) as Json, ["document", "definitions"]) } });
    if (url.endsWith("/draft")) return Response.json(configRead().draft);
    if (url.endsWith("/versions")) return Response.json(configRead().versions);
    if (url.includes("/versions/")) return Response.json(publishedConfig(Number(url.split("/").at(-1))));
    if (url.endsWith("/catalogue")) return Response.json(configRead().catalogue);
    if (url.endsWith("/runtime")) return Response.json(configRead().runtime);
    return Response.json({}, { status: 404 });
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "#"); });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const value = (name: string) => (screen.getByLabelText(name) as HTMLTextAreaElement).value;
async function view() {
  render(<QueryClientProvider client={client}><GradingConfigView version={null} onNavigate={vi.fn()} /></QueryClientProvider>);
  await screen.findByTestId("grading-config-browser");
}
function RoutedShell() {
  const route = useHashRoute();
  return route?.view === "oakridge" ? <OakridgeShell route={route.route} /> : <p>Other view</p>;
}
async function shell() {
  render(<QueryClientProvider client={client}><RoutedShell /></QueryClientProvider>);
  await screen.findByTestId("grading-config-browser");
}

it("preserves the mounted editor and its base digest during pending and completed global refreshes", async () => {
  await view(); change("Question text", "Keep my local question");
  let complete: ((response: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  let refresh: Promise<void> | undefined;
  act(() => { refresh = client.invalidateQueries({ queryKey: ["oakridge"] }); });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  expect(value("Question text")).toBe("Keep my local question");
  await act(async () => {
    complete?.(Response.json({ ...configRead().draft, digest: "external-digest" }));
    await refresh;
  });
  expect(value("Question text")).toBe("Keep my local question");
  expect(screen.getByTestId("grading-draft-status").textContent).toBe("Unsaved local edits");
  click("Save draft"); await screen.findByText("Draft saved · saved");
  const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT");
  expect(atPath(JSON.parse(String(request?.[1]?.body)) as Json, ["expected_draft_digest"])).toBe("draft-base");
});
it("seeds a returning draft editor from a fresh read instead of an earlier cached draft", async () => {
  client.setQueryData(["oakridge", "grading-config", null], { ok: true, value: { ...configRead(), draft: { ...configRead().draft, digest: "cached-digest" } } });
  await view(); change("Question text", "Edited after returning");
  click("Save draft"); await screen.findByText("Draft saved · saved");
  const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT");
  expect(atPath(JSON.parse(String(request?.[1]?.body)) as Json, ["expected_draft_digest"])).toBe("draft-base");
});
it("marks cached reads stale after a draft write", async () => {
  await view(); change("Question text", "Saved question");
  click("Save draft"); await screen.findByText("Draft saved · saved");
  expect(client.getQueryState(["oakridge", "grading-config", null])?.isInvalidated).toBe(true);
});
it("preserves malformed raw text and parse blocking when background reads fail", async () => {
  await view(); click("Raw JSON"); change("Whole definitions array (raw JSON)", "[");
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await client.invalidateQueries({ queryKey: ["oakridge"] }); });
  expect(value("Whole definitions array (raw JSON)")).toBe("[");
  expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
});
it("replaces local edits only after a confirmed successful explicit reload", async () => {
  await view(); change("Question text", "Local question"); click("Reload");
  expect(value("Question text")).toBe("Local question");
  vi.mocked(window.confirm).mockReturnValue(true);
  click("Reload");
  await waitFor(() => expect(value("Question text")).toBe("Is the finding useful?"));
  expect(screen.getByTestId("grading-draft-status").textContent).toBe("Saved draft");
});
it("retains the local editor when an explicitly confirmed reload fails", async () => {
  await view(); change("Question text", "Keep on failure");
  vi.mocked(window.confirm).mockReturnValue(true);
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  click("Reload"); await screen.findByText("Request failed: offline");
  expect(value("Question text")).toBe("Keep on failure");
});
it.each(["Runs", "Workflows"])("guards the %s shell button and honors cancellation and acceptance", async (destination) => {
  await shell(); change("Question text", "Keep until confirmed"); click(destination);
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(window.location.hash).toBe(path);
  expect(value("Question text")).toBe("Keep until confirmed");
  vi.mocked(window.confirm).mockReturnValue(true); click(destination);
  await screen.findByText(destination === "Runs" ? "Run browser" : "Workflow browser");
  expect(window.confirm).toHaveBeenCalledTimes(2);
});
it("guards version navigation with a single confirmation", async () => {
  await shell(); change("Question text", "Unsaved");
  vi.mocked(window.confirm).mockReturnValue(true); click("Version 1");
  await screen.findByText("Published version 1 · read-only");
  expect(window.confirm).toHaveBeenCalledTimes(1);
});
it("guards browser Back before the router unmounts the editor", async () => {
  window.history.replaceState(null, "", "#oakridge");
  window.history.pushState(null, "", path);
  await shell(); change("Question text", "Keep through Back");
  act(() => window.history.back());
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(window.location.hash).toBe(path);
  expect(value("Question text")).toBe("Keep through Back");
});
it("guards browser Forward before the router unmounts the editor", async () => {
  window.history.pushState(null, "", "#oakridge");
  const returned = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
  window.history.back(); await returned;
  await shell(); change("Allowed values (JSON list or null)", "[");
  act(() => window.history.forward());
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(window.location.hash).toBe(path);
  expect(value("Allowed values (JSON list or null)")).toBe("[");
});
it("allows clean navigation and removes the unload guard when the editor leaves", async () => {
  await shell(); click("Runs"); await screen.findByText("Run browser");
  expect(window.confirm).not.toHaveBeenCalled();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
});
it("guards malformed raw text on direct hash navigation and page unload", async () => {
  await shell(); click("Raw JSON"); change("Whole definitions array (raw JSON)", "[");
  act(() => { window.location.hash = "sessions"; });
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(value("Whole definitions array (raw JSON)")).toBe("[");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
});
