import { describe, expect, test } from "bun:test";
import { RunStatus } from "./types";

describe("RunStatus enum mirror", () => {
  test("matches safir's canonical set as of 2026-05-14", () => {
    // Mirror of safir/src/shared/schema.ts RunStatus. When safir adds a
    // value, update this set AND the enum in types.ts together; the test
    // will fail until both sides match.
    const safirEmitted: Set<string> = new Set([
      "pending",
      "running",
      "completed",
      "failed",
      "abandoned",
      "awaiting_review",
    ]);
    expect(new Set<string>(RunStatus.options)).toEqual(safirEmitted);
  });

  test("each value round-trips through Zod parse", () => {
    for (const value of RunStatus.options) {
      expect(RunStatus.parse(value)).toBe(value);
    }
  });
});
