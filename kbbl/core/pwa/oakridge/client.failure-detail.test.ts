/**
 * A refused run delete answers `{ kind, detail }`, not `{ error }`. Reading only
 * `error` showed the operator a bare status code for a failure the server had
 * explained precisely — which is why a delete that needed a cancel first looked
 * like it was simply broken.
 */
import { describe, expect, it } from "vitest";

import { selectFailureDetail } from "./client";

describe("failure detail", () => {
  it("prefers an explicit error message", () => {
    expect(selectFailureDetail({ error: "run not found" }, "fallback")).toBe("run not found");
  });

  it("reads the detail off a typed domain result", () => {
    expect(selectFailureDetail(
      { kind: "active_conflict", run_id: "run-1", detail: "run is still active; cancel the run before deleting it" },
      "oakridge DELETE /workflow_runs/run-1: 409",
    )).toBe("run is still active; cancel the run before deleting it");
  });

  it("falls back to the result kind when there is no prose", () => {
    expect(selectFailureDetail({ kind: "cancellation_pending" }, "fallback")).toBe("cancellation_pending");
  });

  it("falls back when the body carries nothing usable", () => {
    for (const body of [null, undefined, "plain text", 42, {}, { error: "" }, { detail: "" }]) {
      expect(selectFailureDetail(body, "fallback")).toBe("fallback");
    }
  });
});
