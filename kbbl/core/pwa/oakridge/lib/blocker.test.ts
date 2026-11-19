import { describe, expect, it } from "vitest";
import { parkedBlockerUnits } from "../__fixtures__/read-models";
import { reviewToGates } from "../adapters/gates";
import type { ParkedGate } from "../artifact-types";
import { selectBlockerGroups, selectUnsentBlockerGates } from "./blocker";

const gatesOf = (units: ReturnType<typeof parkedBlockerUnits>): ParkedGate[] => units.flatMap((unit) => {
  const gates = reviewToGates(unit);
  if (!gates.ok) throw new Error("blocker gates");
  return gates.value;
});
const groupUnits = (gates: readonly ParkedGate[]) => selectBlockerGroups(gates).map((group) => group.gates.map((gate) => gate.unit_id));

describe("blocker groups", () => {
  it("groups open blockers in one run that offer the same choices, oldest first", () => {
    expect(groupUnits(gatesOf(parkedBlockerUnits(["C", "A", "B"])))).toEqual([["C", "A", "B"]]);
  });
  it("keeps blockers with different choices apart", () => {
    expect(groupUnits(gatesOf(parkedBlockerUnits(["A", "B"], [["Compact", "Expanded"], ["Left", "Right"]])))).toEqual([["A"], ["B"]]);
  });
  it("never groups blockers that offer no choices", () => {
    expect(groupUnits(gatesOf(parkedBlockerUnits(["A", "B"], [null, []])))).toEqual([["A"], ["B"]]);
  });
  it("keeps blockers from different runs apart", () => {
    const [a, b] = parkedBlockerUnits(["A", "B"]);
    expect(groupUnits(gatesOf([a, { ...b, run_id: "other-run" }]))).toEqual([["A"], ["B"]]);
  });
  it("leaves out a blocker that is no longer open", () => {
    const [a, b] = parkedBlockerUnits(["A", "B"]);
    expect(groupUnits(gatesOf([a, { ...b, blocker: b.blocker ? { ...b.blocker, is_open: false } : null }]))).toEqual([["A"]]);
  });
  it("still owes the answer to every gate not confirmed sent", () => {
    const [group] = selectBlockerGroups(gatesOf(parkedBlockerUnits(["A", "B", "C"])));
    expect(selectUnsentBlockerGates(group, new Set([group.gates[1].id])).map((gate) => gate.unit_id)).toEqual(["A", "C"]);
  });
});
