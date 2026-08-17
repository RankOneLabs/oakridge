import { expect, test } from "bun:test";
import { appendIncrementalUnit, closeIncrementalMaterialization, emptyIncrementalMaterialization, materializeBatch, selectReadyUnits } from "../src/compiler/materialize-units";
import type { UnitId } from "../src/domain/primitives";

test("materializes runtime cardinality and selects only dependency-ready siblings", () => {
  const result = materializeBatch([{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: [] }], { unit_id_path: "/id", depends_on_path: "/deps" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const admitted = new Set(result.value.map((unit) => unit.unit_id));
  const window = { admitted, launched: new Set<UnitId>(), running_count: 0, max_parallel: 2 };
  expect(selectReadyUnits(result.value, { ...window, released: new Set() }).map((unit) => String(unit.unit_id))).toEqual(["a", "c"]);
  const afterA = new Set(["a" as UnitId]);
  expect(selectReadyUnits(result.value, { ...window, released: afterA, launched: afterA }).map((unit) => String(unit.unit_id))).toContain("b");
});

test("incremental graph holds unknown siblings until arrival and validates on close", () => {
  const spec = { unit_id_path: "/id", depends_on_path: "/deps" };
  const first = appendIncrementalUnit(emptyIncrementalMaterialization(), { id: "b", deps: ["a"] }, spec);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(closeIncrementalMaterialization(first.value, spec).ok).toBe(false);
  const second = appendIncrementalUnit(first.value, { id: "a", deps: [] }, spec);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  const closed = closeIncrementalMaterialization(second.value, spec);
  expect(closed.ok).toBe(true);
});

test("rejects an unknown sibling and a cycle before execution", () => {
  expect(materializeBatch([{ id: "a", deps: ["missing"] }], { unit_id_path: "/id", depends_on_path: "/deps" }).ok).toBe(false);
  expect(materializeBatch([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }], { unit_id_path: "/id", depends_on_path: "/deps" }).ok).toBe(false);
});

for (const cardinality of [0, 1, 20]) {
  test(`materializes runtime cardinality N=${cardinality}`, () => {
    const items = Array.from({ length: cardinality }, (_, index) => ({ id: `unit-${index}`, deps: [] }));
    const result = materializeBatch(items, { unit_id_path: "/id", depends_on_path: "/deps" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(cardinality);
  });
}
