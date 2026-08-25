import { afterEach, describe, expect, it, vi } from "vitest";

import { randomUuid } from "./random-uuid";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a v4 UUID when crypto.randomUUID is available", () => {
    expect(randomUuid()).toMatch(UUID_V4_PATTERN);
  });

  it("returns a v4 UUID when crypto.randomUUID is absent (insecure context)", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    expect(randomUuid()).toMatch(UUID_V4_PATTERN);
  });

  it("does not repeat values across fallback calls", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const seen = new Set(Array.from({ length: 100 }, () => randomUuid()));
    expect(seen.size).toBe(100);
  });
});
