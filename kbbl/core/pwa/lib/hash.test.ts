import { describe, expect, it } from "vitest";

import { readHashRoute } from "./hash";

function withHash(hash: string) {
  window.location.hash = hash;
  return readHashRoute();
}

describe("readHashRoute oakridge routes", () => {
  it("matches only the oakridge path segment", () => {
    expect(withHash("#oakridge")).toEqual({
      view: "oakridge",
      route: { sub: "runs" },
    });
    expect(withHash("#oakridge/run/run-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1" },
    });
    expect(withHash("#oakridgeSomethingElse")).toBeNull();
  });
});
