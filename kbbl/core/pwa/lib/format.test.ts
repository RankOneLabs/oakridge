import { describe, expect, it } from "vitest";

import { fmtCost } from "./format";

describe("fmtCost", () => {
  it("returns $0.00 for exact zero", () => {
    expect(fmtCost(0)).toBe("$0.00");
  });

  it("returns <$0.01 for positive sub-cent values", () => {
    expect(fmtCost(0.0001)).toBe("<$0.01");
    expect(fmtCost(0.0099)).toBe("<$0.01");
  });

  it("uses 3-decimal precision for sub-dollar values >= $0.01", () => {
    expect(fmtCost(0.01)).toBe("$0.010");
    expect(fmtCost(0.5)).toBe("$0.500");
  });

  it("uses 2-decimal precision for values >= $1", () => {
    expect(fmtCost(1.234)).toBe("$1.23");
  });

  it("clamps negatives to the zero branch", () => {
    expect(fmtCost(-0.01)).toBe("$0.00");
  });
});
