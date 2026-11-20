import { expect, it } from "vitest";
import { computeAnchoredScrollTop, shouldLoadEarlier } from "./thread-scroll";

it.each([
  [true, true, false, true],
  [true, true, true, false],
  [true, false, false, false],
  [true, false, true, false],
  [false, true, false, false],
  [false, true, true, false],
  [false, false, false, false],
  [false, false, true, false],
])("paging with intersects=%s, earlier=%s, loading=%s returns %s", (is_intersecting, has_earlier, is_loading_earlier, expected) => {
  expect(shouldLoadEarlier({ is_intersecting, has_earlier, is_loading_earlier })).toBe(expected);
});

it("keeps a partially visible row at its previous offset", () => {
  expect(computeAnchoredScrollTop(240, -8)).toBe(248);
});
