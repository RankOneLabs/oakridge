import { describe, expect, test } from "vitest";
import { makeAttemptView, makeUnitView } from "../__fixtures__/read-models";
import { selectRunAttempts } from "./run-sessions";

describe("selectRunAttempts", () => {
  test("retains each attempt's unit", () => {
    const rows = selectRunAttempts([
      makeUnitView({ unit_id: "unit-build", attempts: [makeAttemptView({ id: "attempt-build", unit_id: "unit-build" })] }),
      makeUnitView({ unit_id: "unit-assess", attempts: [makeAttemptView({ id: "attempt-assess", unit_id: "unit-assess" })] }),
    ]);
    expect(rows.map((row) => [row.unit_id, row.attempt.id])).toEqual([
      ["unit-build", "attempt-build"], ["unit-assess", "attempt-assess"],
    ]);
  });

  test("preserves projection order within and across units", () => {
    const rows = selectRunAttempts([
      makeUnitView({ unit_id: "unit-build", attempts: [
        makeAttemptView({ id: "attempt-1", number: 1 }), makeAttemptView({ id: "attempt-2", number: 2 }),
      ] }),
      makeUnitView({ unit_id: "unit-assess", attempts: [makeAttemptView({ id: "attempt-3", unit_id: "unit-assess" })] }),
    ]);
    expect(rows.map((row) => row.attempt.id)).toEqual(["attempt-1", "attempt-2", "attempt-3"]);
  });

  test("returns no rows when no unit has an attempt", () => {
    expect(selectRunAttempts([makeUnitView(), makeUnitView({ unit_id: "unit-2" })])).toEqual([]);
  });
});
