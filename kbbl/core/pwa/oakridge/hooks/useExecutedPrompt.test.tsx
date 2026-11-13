import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useExecutedPrompt } from "./useExecutedPrompt";

const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const advance = async (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); });

test("an open prompt transcript refreshes when later shared-session turns arrive", async () => {
  vi.useFakeTimers();
  let hasLaterTask = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([
    { turn_id: "initial", created_at: "2026-01-01", text: "Retained preamble" },
    ...(hasLaterTask ? [{ turn_id: "later-task", created_at: "2026-01-02", text: "Later task" }] : []),
  ]));
  const hook = renderHook(() => useExecutedPrompt("session"), { wrapper: wrapper() });
  await advance(1);
  expect(hook.result.current.data).toMatchObject({ state: "retained", turns: [{ turn_id: "initial" }] });
  hasLaterTask = true;
  await advance(10_001);
  expect(hook.result.current.data).toMatchObject({ state: "retained", turns: [{ turn_id: "initial" }, { turn_id: "later-task" }] });
});
test("an open prompt recovers from not_retained after queued content crosses the dispatch boundary", async () => {
  vi.useFakeTimers();
  let isDispatched = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => isDispatched
    ? Response.json([{ turn_id: "initial", created_at: "2026-01-01", text: "Dispatched preamble" }])
    : Response.json({ error: { code: "not_retained" } }, { status: 404 }));
  const hook = renderHook(() => useExecutedPrompt("session"), { wrapper: wrapper() });
  await advance(1);
  expect(hook.result.current.data).toEqual({ state: "not_retained" });
  isDispatched = true;
  await advance(10_001);
  expect(hook.result.current.data).toMatchObject({ state: "retained", turns: [{ text: "Dispatched preamble" }] });
});
test("prompt polling stays idle when the attempt has no retained session", async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, "fetch");
  renderHook(() => useExecutedPrompt(null), { wrapper: wrapper() });
  await advance(30_000);
  expect(fetch).not.toHaveBeenCalled();
});
