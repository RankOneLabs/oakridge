import { describe, expect, it } from "vitest";

import { updateInputSlot } from "./input-slots";

describe("input slot transforms", () => {
  it("sets collect without mutating the existing slot", () => {
    const slots = [
      { name: "results", artifact_type: "dev.build_result", collect: false },
    ];

    const updated = updateInputSlot(slots, 0, { collect: true });

    expect(updated).toEqual([
      { name: "results", artifact_type: "dev.build_result", collect: true },
    ]);
    expect(slots[0].collect).toBe(false);
  });
});
