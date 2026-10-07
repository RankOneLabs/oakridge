import { afterEach, expect, test, vi } from "vitest";
import { fetchOakridgeConfig } from "./client";
import { DEFAULT_FALLBACK_REFRESH_MS } from "./lib/oakridge-config";

afterEach(() => { vi.unstubAllGlobals(); });

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
