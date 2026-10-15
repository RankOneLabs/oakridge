import { describe, expect, it } from "vitest";

import { RUN_ACCENT_CLASSES, selectRunAccentClass } from "./run-accent";

const RUN_IDS = [
  "run-1",
  "9f543628-5abf-4592-8896-1a2580e62dd8",
  "78e2f663-5323-4a43-a518-a2750f9d5690",
  "",
  "a",
  "a".repeat(512),
];

describe("selectRunAccentClass", () => {
  it("returns the same class for the same run id across calls", () => {
    for (const runId of RUN_IDS) {
      expect(selectRunAccentClass(runId)).toBe(selectRunAccentClass(runId));
    }
  });

  it("only ever returns one of the eight enumerated classes", () => {
    for (const runId of RUN_IDS) {
      expect(RUN_ACCENT_CLASSES).toContain(selectRunAccentClass(runId));
    }
  });

  /**
   * The hash is pure, so "stable across process restarts" is testable as a
   * golden value: changing the hash function breaks this, which is exactly the
   * change that would repaint every run the operator already recognises.
   */
  it("is stable across process restarts", () => {
    expect(selectRunAccentClass("9f543628-5abf-4592-8896-1a2580e62dd8")).toBe("or-run-accent--5");
    expect(selectRunAccentClass("78e2f663-5323-4a43-a518-a2750f9d5690")).toBe("or-run-accent--6");
    expect(selectRunAccentClass("run-1")).toBe("or-run-accent--4");
  });

  it("spreads ids across the whole palette rather than clustering on one class", () => {
    const assigned = new Set(
      Array.from({ length: 400 }, (_unused, index) => selectRunAccentClass(`run-${index}`)),
    );

    expect(assigned.size).toBe(RUN_ACCENT_CLASSES.length);
  });

  it("declares exactly eight classes", () => {
    expect(new Set(RUN_ACCENT_CLASSES).size).toBe(8);
  });
});
