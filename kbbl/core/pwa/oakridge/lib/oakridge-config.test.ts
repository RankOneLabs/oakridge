import { expect, test } from "vitest";
import { DEFAULT_FALLBACK_REFRESH_MS, MAX_FALLBACK_REFRESH_MS, selectFallbackRefreshMs } from "./oakridge-config";

test("the authority's interval wins over the build-time default", () => {
  expect(selectFallbackRefreshMs({ served: 5_000, configured: 60_000 })).toBe(5_000);
});

test("the build-time default applies when the authority states no interval", () => {
  expect(selectFallbackRefreshMs({ served: undefined, configured: "60000" })).toBe(60_000);
});

test("an authority interval below the floor falls back instead of becoming a poll storm", () => {
  expect(selectFallbackRefreshMs({ served: 50, configured: 60_000 })).toBe(60_000);
});

test("a malformed build-time value yields the shipped default", () => {
  expect(selectFallbackRefreshMs({ served: null, configured: "soon" })).toBe(DEFAULT_FALLBACK_REFRESH_MS);
});

test("an absent interval on both sides yields the shipped default", () => {
  expect(selectFallbackRefreshMs({ served: undefined, configured: undefined })).toBe(DEFAULT_FALLBACK_REFRESH_MS);
});

test("an authority interval beyond the timer limit falls back instead of firing every millisecond", () => {
  expect(selectFallbackRefreshMs({ served: MAX_FALLBACK_REFRESH_MS + 1, configured: 60_000 })).toBe(60_000);
  expect(selectFallbackRefreshMs({ served: MAX_FALLBACK_REFRESH_MS, configured: 60_000 })).toBe(MAX_FALLBACK_REFRESH_MS);
});

test("an out-of-range build-time value yields the shipped default", () => {
  expect(selectFallbackRefreshMs({ served: undefined, configured: "1e12" })).toBe(DEFAULT_FALLBACK_REFRESH_MS);
});
