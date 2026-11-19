import { describe, expect, it } from "vitest";
import { selectKeyedSection, type SubnavSection } from "./artifact-subnav";

const sections: readonly SubnavSection<"a" | "b" | "c">[] = [
  { value: "a", label: "A", count: null }, { value: "b", label: "B", count: null }, { value: "c", label: "C", count: null },
];

describe("keyed section", () => {
  it.each([
    ["ArrowRight", "b", "c"], ["ArrowRight", "c", "a"], ["ArrowLeft", "a", "c"], ["ArrowLeft", "b", "a"], ["Home", "c", "a"], ["End", "a", "c"],
  ] as const)("%s from %s selects %s", (key, active, expected) => {
    expect(selectKeyedSection(sections, active, key)).toBe(expected);
  });
  it("ignores other keys", () => {
    expect(selectKeyedSection(sections, "a", "Enter")).toBeNull();
  });
});
