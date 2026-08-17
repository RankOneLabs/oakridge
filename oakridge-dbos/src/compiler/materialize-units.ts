import type { MaterializationContract, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import { err, ok, type JsonValue, type Result, type UnitId } from "../domain/primitives";

/**
 * Whether an incrementally released input is the one a fan-out materializes
 * over. Only the driver mints units; every other incremental input is an
 * ordinary accumulated input that the units read. Without this distinction each
 * `unit_complete` edge into the stage would spawn its own phantom unit per
 * artifact — or collide on `unit_id` and fail the whole stage.
 */
export const isFanOutDriverInput = (materialization: MaterializationContract, input_name: string): boolean =>
  materialization.kind === "fan_out" && materialization.over.from === "input" && materialization.over.input_name === input_name;

/**
 * The artifacts a fan-out stage mints its initial units from — those already
 * delivered on its driver input. Dev-flow's assessor is the case that matters:
 * it consumes `build_result` (its driver) and `brief` incrementally, and both
 * carry the same `unit_id` per repository, so seeding from both collides on
 * `unit_id` and fails the stage before it launches a single unit.
 */
export const selectDriverArtifacts = <Envelope>(
  materialization: MaterializationContract,
  inputs: Readonly<Record<string, Envelope | readonly Envelope[]>>,
): readonly Envelope[] => {
  if (materialization.kind !== "fan_out" || materialization.over.from !== "input") return [];
  const delivered = inputs[materialization.over.input_name];
  if (delivered === undefined) return [];
  return Array.isArray(delivered) ? delivered : [delivered as Envelope];
};

export interface MaterializationSpec { readonly unit_id_path: string; readonly depends_on_path: string | null }
export interface MaterializationError { readonly operation: "materialize_units"; readonly unit_id: string | null; readonly detail: string }

const pointer = (value: JsonValue, path: string): JsonValue | undefined => {
  if (path === "") return value;
  let current: JsonValue | undefined = value;
  for (const token of path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current !== null && typeof current === "object") current = (current as { readonly [key: string]: JsonValue })[token];
    else return undefined;
  }
  return current;
};

const parseUnit = (item: JsonValue, spec: MaterializationSpec): Result<MaterializedExecutionUnit, MaterializationError> => {
  const id = pointer(item, spec.unit_id_path);
  if (typeof id !== "string" || id.length === 0) return err({ operation: "materialize_units", unit_id: null, detail: `unit_id at '${spec.unit_id_path}' must be a non-empty string` });
  const rawDependencies = spec.depends_on_path === null ? [] : pointer(item, spec.depends_on_path);
  if (!Array.isArray(rawDependencies) || rawDependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)) return err({ operation: "materialize_units", unit_id: id, detail: "depends_on must be an array of non-empty strings" });
  const dependencies = rawDependencies as string[];
  if (dependencies.includes(id)) return err({ operation: "materialize_units", unit_id: id, detail: "unit cannot depend on itself" });
  if (new Set(dependencies).size !== dependencies.length) return err({ operation: "materialize_units", unit_id: id, detail: "unit repeats a dependency" });
  return ok({ unit_id: id as UnitId, parameters: item, depends_on: dependencies as UnitId[] });
};

export const materializeBatch = (items: readonly JsonValue[], spec: MaterializationSpec): Result<readonly MaterializedExecutionUnit[], MaterializationError> => {
  const units: MaterializedExecutionUnit[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const parsed = parseUnit(item, spec);
    if (!parsed.ok) return parsed;
    if (ids.has(parsed.value.unit_id)) return err({ operation: "materialize_units", unit_id: parsed.value.unit_id, detail: "duplicate unit_id" });
    ids.add(parsed.value.unit_id);
    units.push(parsed.value);
  }
  for (const unit of units) for (const dependency of unit.depends_on) if (!ids.has(dependency)) return err({ operation: "materialize_units", unit_id: unit.unit_id, detail: `unknown dependency '${dependency}'` });
  const remaining = new Map(units.map((unit) => [unit.unit_id, unit.depends_on.length]));
  const ready = units.filter((unit) => unit.depends_on.length === 0).map((unit) => unit.unit_id);
  let consumed = 0;
  while (ready.length > 0) {
    const done = ready.shift();
    if (!done) break;
    consumed += 1;
    for (const unit of units) if (unit.depends_on.includes(done)) {
      const next = (remaining.get(unit.unit_id) ?? 0) - 1;
      remaining.set(unit.unit_id, next);
      if (next === 0) ready.push(unit.unit_id);
    }
  }
  if (consumed !== units.length) return err({ operation: "materialize_units", unit_id: null, detail: "dependency graph contains a cycle" });
  return ok(units);
};

export const selectReadyUnits = (units: readonly MaterializedExecutionUnit[], released: ReadonlySet<UnitId>, admitted: ReadonlySet<UnitId>, running: ReadonlySet<UnitId>, maxParallel: number): readonly MaterializedExecutionUnit[] => {
  const capacity = Math.max(0, maxParallel - running.size);
  return units.filter((unit) => admitted.has(unit.unit_id) && !released.has(unit.unit_id) && !running.has(unit.unit_id) && unit.depends_on.every((dependency) => released.has(dependency))).slice(0, capacity);
};

export interface IncrementalMaterialization {
  readonly units: readonly MaterializedExecutionUnit[];
  readonly is_closed: boolean;
}

export const emptyIncrementalMaterialization = (): IncrementalMaterialization => ({ units: [], is_closed: false });

export const appendIncrementalUnit = (state: IncrementalMaterialization, item: JsonValue, spec: MaterializationSpec): Result<IncrementalMaterialization, MaterializationError> => {
  if (state.is_closed) return err({ operation: "materialize_units", unit_id: null, detail: "incremental materialization is closed" });
  const parsed = parseUnit(item, spec);
  if (!parsed.ok) return parsed;
  if (state.units.some((unit) => unit.unit_id === parsed.value.unit_id)) return err({ operation: "materialize_units", unit_id: parsed.value.unit_id, detail: "duplicate unit_id" });
  const next = [...state.units, parsed.value];
  const knownIds = new Set(next.map((unit) => unit.unit_id));
  const visiting = new Set<UnitId>();
  const visited = new Set<UnitId>();
  const byId = new Map(next.map((unit) => [unit.unit_id, unit]));
  const hasCycle = (unitId: UnitId): boolean => {
    if (visiting.has(unitId)) return true;
    if (visited.has(unitId)) return false;
    visiting.add(unitId);
    for (const dependency of byId.get(unitId)?.depends_on ?? []) if (knownIds.has(dependency) && hasCycle(dependency)) return true;
    visiting.delete(unitId);
    visited.add(unitId);
    return false;
  };
  if (next.some((unit) => hasCycle(unit.unit_id))) return err({ operation: "materialize_units", unit_id: parsed.value.unit_id, detail: "known dependency graph contains a cycle" });
  return ok({ units: next, is_closed: false });
};

export const closeIncrementalMaterialization = (state: IncrementalMaterialization, spec: MaterializationSpec): Result<IncrementalMaterialization, MaterializationError> => {
  const validation = materializeBatch(state.units.map((unit) => unit.parameters), spec);
  if (!validation.ok) return validation;
  return ok({ units: validation.value, is_closed: true });
};
