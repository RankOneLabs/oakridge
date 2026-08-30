/**
 * `derive` is the whole of spec §1 in one function: the only production
 * implementation of the run's eligibility rules. It reads a `RunSnapshot`
 * (persisted facts, loaded outside this file) and returns the commands
 * provable from it — never a fact it is itself about to write (the
 * "recheck contract", spec §3.3).
 *
 * Materialization rules are spec §4, moved verbatim from
 * `runtime/run-materialization.ts` (`stageInputs`, `stageFinished`,
 * `isReady`, `shouldClose`, `selectInputsForUnit`, `outputSlots`,
 * `envelopes`) and `compiler/materialize-units.ts` (`parseUnit`,
 * `selectDriverArtifacts`, the cycle DFS in `appendIncrementalUnit`).
 */
import type { CompiledStageContract, CompiledWorkflowDefinition, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { SlotBinding } from "../domain/delegated-session";
import type { ArtifactEnvelope } from "../domain/execution";
import { err, ok, type ArtifactId, type InputFingerprint, type JsonValue, type OutputCollectionKey, type Result, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { MaterializedRunOutput } from "../domain/run-record";
import type { StageKey, StageOutcome } from "../domain/workflow";
import { resolveBindingValue, type BindingEnvironment } from "../compiler/resolve-execution";
import { readJsonPointer } from "../domain/json-pointer";
import type { Command, Contradiction, Derivation, StageInputSet } from "./commands";
import { fingerprintOf, runUnitIdFor, stageInstanceIdFor } from "./ids";
import type { RunSnapshot, StagePolicy, StageSnapshot, UnitSnapshot } from "./snapshot";

const TERMINAL_UNIT_STATES = new Set<UnitSnapshot["state"]>(["satisfied", "failed", "cancelled"]);

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// A. Child outcome facts

const findFirstUnit = (snapshot: RunSnapshot, predicate: (unit: UnitSnapshot) => boolean): UnitSnapshot | null => {
  for (const stage of [...snapshot.stages].sort((a, b) => byString(a.stage_key, b.stage_key))) {
    for (const unit of [...stage.units].sort((a, b) => byString(a.unit_id, b.unit_id))) if (predicate(unit)) return unit;
  }
  return null;
};

// ---------------------------------------------------------------------------
// B. Materialization — moved verbatim from runtime/run-materialization.ts

const envelopes = (inputs: StageInputSet): readonly ArtifactEnvelope[] =>
  Object.values(inputs).flatMap((value) => (Array.isArray(value) ? value : [value as ArtifactEnvelope]));

const stageInputs = (stage_key: StageKey, definition: CompiledWorkflowDefinition, snapshot: RunSnapshot): StageInputSet => {
  const result: Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]> = {};
  const stage = definition.stages[stage_key];
  if (!stage) return result;
  for (const edge of definition.edges.filter((candidate) => candidate.consumer_stage === stage_key)) {
    const values = snapshot.available_artifacts.filter((artifact) => artifact.producer_stage_key === edge.producer_stage && artifact.output_name === edge.producer_output);
    const input = stage.inputs.find((candidate) => candidate.name === edge.consumer_input);
    const driver = stage.materialization.kind !== "scalar" && stage.materialization.kind !== "artifact_collection"
      && stage.materialization.over.from === "input" && stage.materialization.over.input_name === edge.consumer_input;
    if (edge.delivery === "unit_complete" || input?.collect === true || driver) result[edge.consumer_input] = values;
    else if (values[0]) result[edge.consumer_input] = values[0];
  }
  return result;
};

const stageFinished = (snapshot: RunSnapshot, stage_key: StageKey): boolean => {
  const stage = snapshot.stages.find((candidate) => candidate.stage_key === stage_key);
  return Boolean(stage?.materialization_closed && stage.units.every((unit) => unit.state === "satisfied"));
};

const isReady = (stage_key: StageKey, definition: CompiledWorkflowDefinition, snapshot: RunSnapshot): boolean => {
  const stage = definition.stages[stage_key];
  if (!stage) return false;
  for (const input of stage.inputs.filter((candidate) => !candidate.optional)) {
    const edge = definition.edges.find((candidate) => candidate.consumer_stage === stage_key && candidate.consumer_input === input.name);
    if (!edge) return false;
    const available = snapshot.available_artifacts.some((artifact) => artifact.producer_stage_key === edge.producer_stage && artifact.output_name === edge.producer_output);
    if (edge.delivery === "producer_complete" ? !stageFinished(snapshot, edge.producer_stage) : !available && !stageFinished(snapshot, edge.producer_stage)) return false;
  }
  return true;
};

const shouldClose = (stage_key: StageKey, definition: CompiledWorkflowDefinition, snapshot: RunSnapshot): boolean =>
  definition.edges.filter((edge) => edge.consumer_stage === stage_key && edge.delivery === "unit_complete").every((edge) => stageFinished(snapshot, edge.producer_stage));

const selectInputsForUnit = (stage: CompiledStageContract, inputs: StageInputSet, unit: MaterializedExecutionUnit): StageInputSet => {
  if (stage.materialization.kind !== "fan_out") return inputs;
  const perUnit = new Set(stage.inputs.filter((input) => input.delivery === "unit_complete").map((input) => input.name));
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) =>
    Array.isArray(value) && perUnit.has(name) ? [name, value.filter((artifact) => artifact.unit_id === unit.unit_id)] : [name, value]));
};

/** One per `contract.outputs` for fan_out/scalar; one per (item key × output), `collection_member`, for artifact_collection. */
const outputSlots = (contract: CompiledStageContract, unit: MaterializedExecutionUnit): Result<readonly MaterializedRunOutput[], { readonly path: string; readonly detail: string }> => {
  const materialization = contract.materialization;
  if (materialization.kind !== "artifact_collection") {
    return ok(contract.outputs.map((output) => ({ identity: { kind: "scalar" as const, output_name: output.name }, artifact_type: output.artifact_type, required: true, release: output.release })));
  }
  const outputs: MaterializedRunOutput[] = [];
  for (const item of unit.parameters as readonly JsonValue[]) {
    const key = readJsonPointer(item, materialization.id_path);
    if (typeof key !== "string" || key.length === 0) return err({ path: materialization.id_path, detail: `artifact collection key '${materialization.id_path}' must be a non-empty string` });
    for (const output of contract.outputs) outputs.push({ identity: { kind: "collection_member" as const, output_name: output.name, collection_key: key as OutputCollectionKey }, artifact_type: output.artifact_type, required: true, release: output.release });
  }
  return ok(outputs);
};

const selectDriverArtifacts = (inputs: StageInputSet, input_name: string): readonly ArtifactEnvelope[] => {
  const delivered = inputs[input_name];
  if (delivered === undefined) return [];
  return Array.isArray(delivered) ? delivered : [delivered as ArtifactEnvelope];
};

/** The `over.path` a binding carries, when it has one — "" otherwise. Used only to name a contradiction. */
const bindingPath = (binding: SlotBinding): string => ("path" in binding && typeof binding.path === "string" ? binding.path : "");

/** The artifact a binding is keyed on, when it names a single input envelope (or the first of a collected one). */
const sourceArtifactId = (binding: SlotBinding, inputs: StageInputSet): ArtifactId | null => {
  if (binding.from !== "input") return null;
  const value = inputs[binding.input_name];
  if (value === undefined) return null;
  const envelope = Array.isArray(value) ? value[0] : (value as ArtifactEnvelope);
  return envelope ? envelope.artifact_id : null;
};

const policyOf = (contract: CompiledStageContract): StagePolicy =>
  contract.materialization.kind === "fan_out"
    ? { max_parallel: contract.materialization.max_parallel, manual_admission: contract.materialization.manual_admission }
    : { max_parallel: 1, manual_admission: false };

interface DriverParseSpec { readonly unit_id_path: string; readonly depends_on_path: string | null }

/** Moved from `materialize-units.ts`'s `parseUnit`; returns the path that failed instead of throwing. */
const parseUnit = (item: JsonValue, spec: DriverParseSpec): Result<MaterializedExecutionUnit, { readonly path: string; readonly detail: string }> => {
  const id = readJsonPointer(item, spec.unit_id_path);
  if (typeof id !== "string" || id.length === 0) return err({ path: spec.unit_id_path, detail: `unit_id at '${spec.unit_id_path}' must be a non-empty string` });
  const dependsOnPath = spec.depends_on_path;
  const rawDependencies = dependsOnPath === null ? [] : readJsonPointer(item, dependsOnPath);
  if (!Array.isArray(rawDependencies) || rawDependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0))
    return err({ path: dependsOnPath ?? "", detail: "depends_on must be an array of non-empty strings" });
  const dependencies = rawDependencies as string[];
  if (dependencies.includes(id)) return err({ path: dependsOnPath ?? "", detail: "unit cannot depend on itself" });
  if (new Set(dependencies).size !== dependencies.length) return err({ path: dependsOnPath ?? "", detail: "unit repeats a dependency" });
  return ok({ unit_id: id as UnitId, parameters: item, depends_on: dependencies as UnitId[] });
};

interface MintedUnit {
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly depends_on: readonly UnitId[];
  readonly inputs: StageInputSet;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly outputs: readonly MaterializedRunOutput[];
  readonly source_artifact_id: ArtifactId | null;
}

interface DriverUnit { readonly unit: MaterializedExecutionUnit; readonly source_artifact_id: ArtifactId | null }

const finalizeMintedUnits = (contract: CompiledStageContract, inputs: StageInputSet, driverUnits: readonly DriverUnit[]): Result<readonly MintedUnit[], Contradiction> => {
  const minted: MintedUnit[] = [];
  for (const { unit, source_artifact_id } of driverUnits) {
    const unitInputs = selectInputsForUnit(contract, inputs, unit);
    const input_snapshot = envelopes(unitInputs);
    const input_fingerprint = fingerprintOf(input_snapshot);
    const outputs = outputSlots(contract, unit);
    if (!outputs.ok) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: source_artifact_id, path: outputs.error.path, detail: outputs.error.detail });
    minted.push({ unit_id: unit.unit_id, parameters: unit.parameters, depends_on: unit.depends_on, inputs: unitInputs, input_snapshot, input_fingerprint, outputs: outputs.value, source_artifact_id });
  }
  return ok(minted);
};

/**
 * What a stage's units are, right now, from the persisted inputs alone.
 * `scalar` and `artifact_collection` always mint exactly unit `"0"`;
 * `fan_out` mints one unit per driver artifact (or per item of a
 * non-input `over` binding — repository provisioning fans out over run
 * context, which is why `malformed_driver_artifact.artifact_id` may be null).
 */
const mintUnits = (contract: CompiledStageContract, inputs: StageInputSet, context: JsonValue): Result<readonly MintedUnit[], Contradiction> => {
  const materialization = contract.materialization;
  const environment: BindingEnvironment = { inputs, context, item: null };

  if (materialization.kind === "scalar") return finalizeMintedUnits(contract, inputs, [{ unit: { unit_id: "0" as UnitId, parameters: {}, depends_on: [] }, source_artifact_id: null }]);

  if (materialization.kind === "artifact_collection") {
    const sourceId = sourceArtifactId(materialization.over, inputs);
    const path = bindingPath(materialization.over);
    const over = resolveBindingValue(materialization.over, environment);
    if (!over.ok) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: sourceId, path, detail: over.error.detail });
    if (!Array.isArray(over.value)) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: sourceId, path, detail: `${materialization.kind}.over must resolve to an array` });
    return finalizeMintedUnits(contract, inputs, [{ unit: { unit_id: "0" as UnitId, parameters: over.value, depends_on: [] }, source_artifact_id: sourceId }]);
  }

  // fan_out
  const spec: DriverParseSpec = { unit_id_path: materialization.unit_id_path, depends_on_path: materialization.depends_on_path };
  const driverUnits: DriverUnit[] = [];
  const seen = new Set<string>();

  if (materialization.over.from === "input") {
    for (const artifact of selectDriverArtifacts(inputs, materialization.over.input_name)) {
      const item = { unit_id: artifact.unit_id, artifact: artifact.body } as JsonValue;
      const parsed = parseUnit(item, spec);
      if (!parsed.ok) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: artifact.artifact_id, path: parsed.error.path, detail: parsed.error.detail });
      if (seen.has(parsed.value.unit_id)) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: artifact.artifact_id, path: spec.unit_id_path, detail: `duplicate unit_id '${parsed.value.unit_id}'` });
      seen.add(parsed.value.unit_id);
      driverUnits.push({ unit: parsed.value, source_artifact_id: artifact.artifact_id });
    }
  } else {
    const over = resolveBindingValue(materialization.over, environment);
    if (!over.ok) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: null, path: bindingPath(materialization.over), detail: over.error.detail });
    if (!Array.isArray(over.value)) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: null, path: bindingPath(materialization.over), detail: `${materialization.kind}.over must resolve to an array` });
    for (const item of over.value) {
      const parsed = parseUnit(item, spec);
      if (!parsed.ok) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: null, path: parsed.error.path, detail: parsed.error.detail });
      if (seen.has(parsed.value.unit_id)) return err({ kind: "malformed_driver_artifact", stage_key: contract.stage_key, artifact_id: null, path: spec.unit_id_path, detail: `duplicate unit_id '${parsed.value.unit_id}'` });
      seen.add(parsed.value.unit_id);
      driverUnits.push({ unit: parsed.value, source_artifact_id: null });
    }
  }
  return finalizeMintedUnits(contract, inputs, driverUnits);
};

interface CycleNode { readonly unit_id: UnitId; readonly depends_on: readonly UnitId[] }

/** DFS as `appendIncrementalUnit` did, but returning the cycle path (e.g. `["a","b","a"]`) instead of a boolean. */
const findCycle = (nodes: readonly CycleNode[]): readonly UnitId[] | null => {
  const byId = new Map(nodes.map((node) => [node.unit_id, node]));
  const path: UnitId[] = [];
  const onPath = new Set<UnitId>();
  const visited = new Set<UnitId>();
  const visit = (id: UnitId): readonly UnitId[] | null => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    onPath.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      if (byId.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    path.pop();
    onPath.delete(id);
    visited.add(id);
    return null;
  };
  for (const node of [...nodes].sort((a, b) => byString(a.unit_id, b.unit_id))) {
    const cycle = visit(node.unit_id);
    if (cycle) return cycle;
  }
  return null;
};

const materializeUnitCommand = (run_id: WorkflowRunId, stage_key: StageKey, stage_instance_id: StageInstanceId, unit: MintedUnit): Command => ({
  kind: "materialize_unit", stage_key, stage_instance_id, run_unit_id: runUnitIdFor(run_id, stage_key, unit.unit_id), unit_id: unit.unit_id,
  parameters: unit.parameters, depends_on: unit.depends_on, inputs: unit.inputs, input_snapshot: unit.input_snapshot,
  input_fingerprint: unit.input_fingerprint, outputs: unit.outputs,
});

const reviseUnitCommand = (stage_key: StageKey, stage_instance_id: StageInstanceId, existing: UnitSnapshot, unit: MintedUnit): Command => ({
  kind: "revise_unit", stage_key, stage_instance_id, run_unit_id: existing.id, unit_id: unit.unit_id,
  parameters: unit.parameters, inputs: unit.inputs, input_snapshot: unit.input_snapshot, input_fingerprint: unit.input_fingerprint,
});

// ---------------------------------------------------------------------------
// derive

export const derive = (snapshot: RunSnapshot): Result<Derivation, Contradiction> => {
  // A. Child outcome facts — any cancelled unit anywhere wins over any failed unit anywhere.
  const cancelledUnit = findFirstUnit(snapshot, (unit) => unit.state === "cancelled");
  if (cancelledUnit) return ok({ commands: [{ kind: "complete_run", outcome: cancelledUnit.outcome ?? { kind: "cancelled", reason: null } }] });
  const failedUnit = findFirstUnit(snapshot, (unit) => unit.state === "failed");
  if (failedUnit) return ok({ commands: [{ kind: "complete_run", outcome: failedUnit.outcome ?? { kind: "failed", code: "unit_failed", detail: failedUnit.unit_id } }] });

  const commands: Command[] = [];
  /** Stages this batch revises a unit of: their persisted "all satisfied" is about to stop being true. */
  const revisedStageIds = new Set<StageInstanceId>();
  const run_id = snapshot.run.id;
  const definition = snapshot.definition;

  // B. Materialization — definition stages, sorted stage_key order.
  for (const stage_key of Object.keys(definition.stages).sort(byString)) {
    const contract = definition.stages[stage_key]!;
    const stored: StageSnapshot | null = snapshot.stages.find((candidate) => candidate.stage_key === stage_key) ?? null;
    if (!isReady(stage_key, definition, snapshot)) continue;
    const inputs = stageInputs(stage_key, definition, snapshot);
    const stage_instance_id = stored?.id ?? stageInstanceIdFor(run_id, stage_key);

    if (!stored) {
      commands.push({ kind: "materialize_stage", stage_key, stage_instance_id, policy: policyOf(contract) });
      const minted = mintUnits(contract, inputs, snapshot.run.context);
      if (!minted.ok) return minted;
      for (const unit of minted.value) commands.push(materializeUnitCommand(run_id, stage_key, stage_instance_id, unit));
      continue; // close / satisfy / start / succeed come on the next ask (recheck contract)
    }

    const minted = mintUnits(contract, inputs, snapshot.run.context);
    if (!minted.ok) return minted;

    // A revision (§1 rule 5) is applied whether or not the collection is
    // closed: closure fixes which units exist, not what their inputs are —
    // a released input revised later must relaunch its consumer (#458).
    // A unit that is new after closure has no command: the graph is closed,
    // and a producer that could still mint one is by definition not finished.
    let added = false;
    for (const unit of minted.value) {
      const existing = stored.units.find((candidate) => candidate.unit_id === unit.unit_id);
      if (existing) {
        if (existing.input_fingerprint !== unit.input_fingerprint) { commands.push(reviseUnitCommand(stage_key, stage_instance_id, existing, unit)); revisedStageIds.add(stage_instance_id); }
      }
      else if (!stored.materialization_closed) { commands.push(materializeUnitCommand(run_id, stage_key, stage_instance_id, unit)); added = true; }
    }
    if (stored.materialization_closed) continue;

    const nodes: CycleNode[] = stored.units.map((unit) => ({ unit_id: unit.unit_id, depends_on: unit.depends_on }));
    for (const unit of minted.value) if (!stored.units.some((candidate) => candidate.unit_id === unit.unit_id)) nodes.push({ unit_id: unit.unit_id, depends_on: unit.depends_on });
    const cycle = findCycle(nodes);
    if (cycle) return err({ kind: "dependency_cycle", stage_key, cycle });

    if (!added && shouldClose(stage_key, definition, snapshot)) {
      for (const unit of [...stored.units].sort((a, b) => byString(a.unit_id, b.unit_id))) {
        for (const dependency of unit.depends_on) {
          if (!stored.units.some((candidate) => candidate.unit_id === dependency)) return err({ kind: "unknown_dependency_at_close", stage_key, unit_id: unit.unit_id, dependency });
        }
      }
      commands.push({ kind: "close_materialization", stage_key, stage_instance_id });
    }
  }

  // C. Unit facts, starts, stage success — stored stages (a stored stage may have no definition entry: test fixtures).
  for (const stored of [...snapshot.stages].sort((a, b) => byString(a.stage_key, b.stage_key))) {
    if (stored.state !== "active") continue;
    const units = [...stored.units].sort((a, b) => byString(a.unit_id, b.unit_id));

    for (const unit of units) {
      if (!TERMINAL_UNIT_STATES.has(unit.state) && unit.required_slots.every((slot) => slot.state.kind === "released")) commands.push({ kind: "mark_unit_satisfied", run_unit_id: unit.id });
    }

    const running = units.filter((unit) => unit.work_orders.some((order) => order.state === "started") && unit.open_waits.length === 0).length;
    let capacity = stored.policy.max_parallel - running;

    for (const unit of units) {
      if (capacity <= 0) break;
      const eligible = !TERMINAL_UNIT_STATES.has(unit.state) && unit.open_waits.length === 0 && !unit.work_orders.some((order) => order.state === "started")
        && unit.admitted && unit.depends_on.every((dependency) => stored.units.find((candidate) => candidate.unit_id === dependency)?.state === "satisfied");
      const order = unit.work_orders.filter((candidate) => candidate.state === "available")
        .sort((a, b) => (a.created_at === b.created_at ? byString(a.id, b.id) : byString(a.created_at, b.created_at)))[0];
      if (eligible && order) { commands.push({ kind: "start_work", work_order_id: order.id, run_unit_id: unit.id }); capacity -= 1; }
    }

    // Not for a stage this batch is revising a unit of: `revise_unit` resets that unit to
    // `ready`, and a stage marked succeeded here would never start it (§C skips non-active stages).
    if (stored.materialization_closed && !revisedStageIds.has(stored.id) && stored.units.every((unit) => unit.state === "satisfied")) commands.push({ kind: "mark_stage_succeeded", stage_instance_id: stored.id });
  }

  // D. Run completion — from persisted state only.
  const definitionStageKeys = Object.keys(definition.stages);
  if (snapshot.stages.length > 0 && definitionStageKeys.every((key) => snapshot.stages.some((stage) => stage.stage_key === key)) && snapshot.stages.every((stage) => stage.state === "succeeded")) {
    const outcome: StageOutcome = { kind: "succeeded" };
    commands.push({ kind: "complete_run", outcome });
  }

  return ok({ commands });
};
