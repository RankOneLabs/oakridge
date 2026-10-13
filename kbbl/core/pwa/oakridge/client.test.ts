import { afterEach, expect, test, vi } from "vitest";
import { fetchOakridgeConfig, fetchOperatorRuns, fetchOperatorDefinitions, fetchOperatorUnit,
  launchOperatorRun, submitOperatorDecision } from "./client";
import { makeIngressCommitted, makeDecisionSubmission, makeDefinitionSummary, makeAttemptView,
  makeOakridgeConfig, makeRunView, makeUnitView, makeLaunchRequest } from "./__fixtures__/read-models";
import { DEFAULT_FALLBACK_REFRESH_MS } from "./lib/oakridge-config";

afterEach(() => { vi.unstubAllGlobals(); });

test("run and definition consumers follow every cursor page", async () => {
  const fetch = vi.fn(async (url: string) => {
    const second = url.includes("cursor=");
    return Response.json(url.includes("definitions")
      ? { items: [makeDefinitionSummary({ bundle_id: second ? "bundle-2" : "bundle-1" })], next_cursor: second ? null : "next" }
      : { items: [makeRunView({ run_id: second ? "run-2" : "run-1" })], next_cursor: second ? null : "next" });
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

test("each decision goes to the route its submit names, carrying its request id", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(makeIngressCommitted()));
  vi.stubGlobal("fetch", fetch);
  await submitOperatorDecision(makeDecisionSubmission({ unit_id: "run-1/cohort", request_id: "review-1", payload: { feedback: "more" } }));
  await submitOperatorDecision(makeDecisionSubmission({ request_id: "retry-1", target_revision_id: null, submit: { kind: "retry", worker: "builder" } }));
  await submitOperatorDecision(makeDecisionSubmission({ request_id: "cancel-1", target_revision_id: null, submit: { kind: "cancel" } }));
  expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    ["/oakridge/api/api/runs/run-1/units/run-1%2Fcohort/reviews/analysis_review/decide",
      { request_id: "review-1", decision: "approve", target: "revision-1", payload: { feedback: "more" } }],
    ["/oakridge/api/api/runs/run-1/units/unit-1/workers/builder/retry", { request_id: "retry-1" }],
    ["/oakridge/api/api/runs/run-1/cancel", { request_id: "cancel-1" }],
  ]);
});

test("resubmitting a request id reuses the in-flight delivery", async () => {
  const fetch = vi.fn(async () => Response.json(makeIngressCommitted()));
  vi.stubGlobal("fetch", fetch);
  const input = makeDecisionSubmission({ request_id: "shared-id" });
  await Promise.all([submitOperatorDecision(input), submitOperatorDecision(input)]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("sends the caller-owned launch idempotency key in the launch request", async () => {
  const fetch = vi.fn(async () => Response.json(makeIngressCommitted()));
  vi.stubGlobal("fetch", fetch);
  await launchOperatorRun(makeLaunchRequest({ request_id: "launch-1" }));
  expect(fetch).toHaveBeenCalledWith("/oakridge/api/api/runs", expect.objectContaining({
    method: "POST", body: expect.stringContaining('"request_id":"launch-1"'),
  }));
});

test("reads a unit's attempts", async () => {
  const unit = makeUnitView({ attempts: [makeAttemptView({ worker: "builder", number: 2 })] });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(unit)));
  const result = await fetchOperatorUnit("run-1", "unit-1");
  expect(result.attempts[0]).toMatchObject({ worker: "builder", number: 2 });
});
