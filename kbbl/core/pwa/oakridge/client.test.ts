import { afterEach, expect, test, vi } from "vitest";
import { fetchOakridgeConfig, fetchOperatorRuns, fetchOperatorDefinitions, submitOperatorCommand } from "./client";
import { DEFAULT_FALLBACK_REFRESH_MS } from "./lib/oakridge-config";
import type { OperatorCommandSubmission } from "./operator-contracts";

afterEach(() => { vi.unstubAllGlobals(); });

test("run and definition consumers follow every cursor page", async () => {
  const fetch = vi.fn(async (url: string) => Response.json(url.includes("cursor=")
    ? { items: [{ marker: "second" }], next_cursor: null }
    : { items: [{ marker: "first" }], next_cursor: "next" }));
  vi.stubGlobal("fetch", fetch);
  expect((await fetchOperatorRuns()).map((item) => (item as unknown as { marker: string }).marker)).toEqual(["first", "second"]);
  expect((await fetchOperatorDefinitions()).map((item) => (item as unknown as { marker: string }).marker)).toEqual(["first", "second"]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/oakridge/api/api/runs", "/oakridge/api/api/runs?cursor=next",
    "/oakridge/api/api/definitions", "/oakridge/api/api/definitions?cursor=next",
  ]);
});

test("the served fallback refresh interval survives into the config the PWA uses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: true, core_url: "http://oakridge.test", fallback_refresh_ms: 5_000 })));
  expect((await fetchOakridgeConfig()).fallback_refresh_ms).toBe(5_000);
});

test("an authority that states no interval leaves the bundle's default in place", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: true, core_url: "http://oakridge.test" })));
  expect((await fetchOakridgeConfig()).fallback_refresh_ms).toBe(DEFAULT_FALLBACK_REFRESH_MS);
});

test("an unreachable config endpoint reports the surface unavailable with a usable interval", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "down" }, { status: 503 })));
  expect(await fetchOakridgeConfig()).toEqual({ available: false, fallback_refresh_ms: DEFAULT_FALLBACK_REFRESH_MS });
});

const submission = (scope_id: string): OperatorCommandSubmission => ({ run_id: "run-1", scope_id,
  command_key: "approve", owner_version: 1, targets: [], request_id: "shared-id", payload: {} });

test("two scopes sharing one request id each deliver their own command", async () => {
  const fetch = vi.fn(async (url: string) => Response.json({ kind: "accepted_pending",
    request_id: "shared-id", transition_id: url, scope_version: 2 }));
  vi.stubGlobal("fetch", fetch);
  const [first, second] = await Promise.all([
    submitOperatorCommand(submission("scope-one")), submitOperatorCommand(submission("scope-two"))]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/oakridge/api/api/runs/run-1/scopes/scope-one/commands", "/oakridge/api/api/runs/run-1/scopes/scope-two/commands"]);
  expect(first.transition_id).not.toBe(second.transition_id);
});

test("one scope resubmitting its request id reuses the in-flight delivery", async () => {
  const fetch = vi.fn(async () => Response.json({ kind: "accepted_pending", request_id: "shared-id",
    transition_id: "transition-1", scope_version: 2 }));
  vi.stubGlobal("fetch", fetch);
  await Promise.all([submitOperatorCommand(submission("scope-one")), submitOperatorCommand(submission("scope-one"))]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
