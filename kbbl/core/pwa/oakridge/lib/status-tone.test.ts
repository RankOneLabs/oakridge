import { describe, expect, it } from "vitest";
import type { ChipTone } from "../../components/atoms/Chip";
import { selectStatusTone } from "./status-tone";

describe("selectStatusTone", () => {
  it("preserves the tones for the former run, artifact, assessment, and PR status values", () => {
    const cases: readonly [string, ChipTone][] = [
      ["pending", "muted"], ["running", "info"], ["parked", "warning"],
      ["failed", "danger"], ["complete", "success"], ["cancelled", "muted"],
      ["stuck", "warning"], ["draft", "warning"], ["approved", "success"],
      ["rejected", "danger"], ["blocking", "danger"], ["warning", "warning"],
      ["info", "info"], ["implementable", "success"], ["blocked", "danger"],
      ["ambiguous", "warning"], ["met", "success"], ["partial", "warning"],
      ["not_met", "danger"], ["pass", "success"], ["pass_with_notes", "warning"],
      ["fail", "danger"], ["ready", "info"], ["changes_requested", "warning"],
      ["merged", "success"], ["closed", "muted"],
    ];
    for (const [status, tone] of cases) expect(selectStatusTone(status)).toBe(tone);
  });

  it("uses muted for an unknown status", () => {
    expect(selectStatusTone("superseded")).toBe("muted");
  });
});
