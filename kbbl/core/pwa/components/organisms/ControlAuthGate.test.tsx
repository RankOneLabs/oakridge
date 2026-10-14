// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ControlAuthGate } from "./ControlAuthGate";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ControlAuthGate><p data-testid="app">app</p></ControlAuthGate></QueryClientProvider>);
}

test("a kbbl that requires a credential the browser lacks asks for the token, then shows the app once the cookie is set", async () => {
  let is_authenticated = false;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/auth/cookie") { is_authenticated = true; return new Response("{}", { status: 200 }); }
    return Response.json({ is_required: true, is_authenticated });
  }) as unknown as typeof fetch;
  renderGate();
  await screen.findByTestId("control-sign-in");
  fireEvent.change(screen.getByLabelText("Control token"), { target: { value: "tok" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("app")).toBeTruthy());
});

test("a kbbl without a control token shows the app directly", async () => {
  globalThis.fetch = vi.fn(async () => Response.json({ is_required: false, is_authenticated: true })) as unknown as typeof fetch;
  renderGate();
  expect(await screen.findByTestId("app")).toBeTruthy();
});

test("a status kbbl cannot answer keeps the app closed behind a retry, which opens it once kbbl answers", async () => {
  let is_reachable = false;
  globalThis.fetch = vi.fn(async () => is_reachable
    ? Response.json({ is_required: false, is_authenticated: true }) : new Response("", { status: 502 })) as unknown as typeof fetch;
  renderGate();
  await screen.findByTestId("control-auth-unavailable");
  expect(screen.queryByTestId("app")).toBeNull();
  is_reachable = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("app")).toBeTruthy();
});
