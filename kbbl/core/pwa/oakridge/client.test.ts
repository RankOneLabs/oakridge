import { afterEach, expect, test, vi } from "vitest";
import { fetchOakridgeConfig, fetchOperatorRuns, fetchOperatorDefinitions, fetchOperatorScope,
  launchOperatorRun, submitOperatorCommand } from "./client";
import { makeCommandReceipt, makeCommandSubmission, makeDefinitionSummary, makeExecutionView,
  makeOakridgeConfig, makeRunDetail, makeScopeView, makeStartedRun, makeStartPinnedRunRequest } from "./__fixtures__/read-models";
import { DEFAULT_FALLBACK_REFRESH_MS } from "./lib/oakridge-config";

afterEach(() => { vi.unstubAllGlobals(); });

test("run and definition consumers follow every cursor page", async () => {
  const fetch = vi.fn(async (url: string) => {
    const second = url.includes("cursor=");
    return Response.json(url.includes("definitions")
      ? { items: [makeDefinitionSummary({ bundle_id: second ? "bundle-2" : "bundle-1" })], next_cursor: second ? null : "next" }
      : { items: [makeRunDetail({ run_id: second ? "run-2" : "run-1" })], next_cursor: second ? null : "next" });
  });
  vi.stubGlobal("fetch", fetch);
  expect((await fetchOperatorRuns()).map((item) => item.run_id)).toEqual(["run-1", "run-2"]);
  expect((await fetchOperatorDefinitions()).map((item) => item.bundle_id)).toEqual(["bundle-1", "bundle-2"]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/oakridge/api/api/runs", "/oakridge/api/api/runs?cursor=next",
    "/oakridge/api/api/definitions", "/oakridge/api/api/definitions?cursor=next",
  ]);
});

test("the served fallback refresh interval survives into the config the PWA uses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(makeOakridgeConfig())));
  expect((await fetchOakridgeConfig()).fallback_refresh_ms).toBe(5_000);
});

test("an authority that states no interval leaves the bundle's default in place", async () => {
  const { fallback_refresh_ms: _interval, ...served } = makeOakridgeConfig();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(served)));
  expect((await fetchOakridgeConfig()).fallback_refresh_ms).toBe(DEFAULT_FALLBACK_REFRESH_MS);
});

test("an unreachable config endpoint reports the surface unavailable with a usable interval", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "down" }, { status: 503 })));
  expect(await fetchOakridgeConfig()).toEqual({ available: false, fallback_refresh_ms: DEFAULT_FALLBACK_REFRESH_MS });
});

test("two scopes sharing one request id each deliver their own command", async () => {
  const fetch = vi.fn(async (url: string) => Response.json(makeCommandReceipt({ request_id: "shared-id", transition_id: url })));
  vi.stubGlobal("fetch", fetch);
  const [first, second] = await Promise.all([
    submitOperatorCommand(makeCommandSubmission({ scope_id: "scope-one", request_id: "shared-id" })),
    submitOperatorCommand(makeCommandSubmission({ scope_id: "scope-two", request_id: "shared-id" }))]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/oakridge/api/api/runs/run-1/scopes/scope-one/commands", "/oakridge/api/api/runs/run-1/scopes/scope-two/commands"]);
  expect(first.transition_id).not.toBe(second.transition_id);
});

test("one scope resubmitting its request id reuses the in-flight delivery", async () => {
  const fetch = vi.fn(async () => Response.json(makeCommandReceipt({ request_id: "shared-id" })));
  vi.stubGlobal("fetch", fetch);
  const input = makeCommandSubmission({ scope_id: "scope-one", request_id: "shared-id" });
  await Promise.all([submitOperatorCommand(input), submitOperatorCommand(input)]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("sends the caller-owned launch idempotency key in the pinned run request", async () => {
  const fetch = vi.fn(async () => Response.json(makeStartedRun()));
  vi.stubGlobal("fetch", fetch);
  await launchOperatorRun(makeStartPinnedRunRequest({ request_id: "launch-1" }));
  expect(fetch).toHaveBeenCalledWith("/oakridge/api/runs", expect.objectContaining({
    method: "POST", body: expect.stringContaining('"request_id":"launch-1"'),
  }));
});

test("reads the generated scope's execution attempts", async () => {
  const scope = makeScopeView({ executions: [makeExecutionView({ worker_key: "builder", generation: 2 })] });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(scope)));
  const result = await fetchOperatorScope("run-1", "scope-1");
  expect(result.executions[0]).toMatchObject({ worker_key: "builder", generation: 2 });
});
