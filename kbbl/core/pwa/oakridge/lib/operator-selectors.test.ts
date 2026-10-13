import { expect, test } from "vitest";
import { selectRootUnitId } from "./operator-selectors";

const unit = (unit_id: string, unit_key: string) => ({ unit_id, unit_key });

test("the root unit is found by its key wherever the server happened to order it", () => {
  const units = [unit("0aa", "child"), unit("0bb", "root"), unit("0cc", "child")];
  expect(selectRootUnitId({ units, root_key: "root" })).toBe("0bb");
});

test("no root unit is chosen when the run has none with the definition's root key", () => {
  expect(selectRootUnitId({ units: [unit("0aa", "child")], root_key: "root" })).toBeNull();
});
