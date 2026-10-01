/**
 * Reading a stage's pinned contract back off the row it was stored in.
 *
 * `stage_instance.stage_contract` holds the `CompiledStageContract` the stage
 * was opened with, so publication and gate opening resolve an output's type,
 * release policy and attention from the version the run was launched under —
 * not from whatever the definition says today. v15 has no per-cohort slot table
 * precisely because this one is authoritative and already pinned.
 *
 * Parsed rather than cast: the value has been through jsonb, and the first place
 * a missing field would otherwise surface is a wait opened with no actions for
 * the operator to choose from.
 */
import { selectOutputAttention, type OutputReleaseContract } from "./compiled-workflow";
import type { DeclaredOutputSlot } from "./run-record";
import type { JsonValue } from "./primitives";
import { hasOwn } from "./records";
import type { CompiledMachine } from "./stage-machine";
import { machineDefinitionSchema } from "../validation/workflow-definition";

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRelease = (value: JsonValue | undefined): OutputReleaseContract => {
  if (!isObject(value)) return { kind: "immediate" };
  if (value.kind === "gate") {
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return {
      kind: "gate",
      gate_name: typeof value.gate_name === "string" ? value.gate_name : "gate",
      steps: steps.flatMap((step): readonly { readonly type: string; readonly actions: readonly { readonly name: string; readonly disposition: "release" | "revise" | "terminal" }[] }[] => {
        if (!isObject(step)) return [];
        const actions = Array.isArray(step.actions) ? step.actions : [];
        return [{
          type: typeof step.type === "string" ? step.type : "artifact_approval",
          actions: actions.flatMap((action) => isObject(action) && typeof action.name === "string" && typeof action.disposition === "string"
            ? [{ name: action.name, disposition: action.disposition as "release" | "revise" | "terminal" }]
            : []),
        }];
      }),
    };
  }
  if (value.kind === "handoff") {
    return {
      kind: "handoff",
      handoff_name: typeof value.handoff_name === "string" ? value.handoff_name : "handoff",
      downstream_role: typeof value.downstream_role === "string" ? value.downstream_role : "",
      external_wait_kind: typeof value.external_wait_kind === "string" ? value.external_wait_kind : "",
      close_events: Array.isArray(value.close_events) ? value.close_events.filter((event): event is string => typeof event === "string") : [],
    };
  }
  return { kind: "immediate" };
};

export const parseStageContractOutputs = (contract: JsonValue): readonly DeclaredOutputSlot[] => {
  if (!isObject(contract) || !Array.isArray(contract.outputs)) return [];
  return contract.outputs.flatMap((output) => {
    if (!isObject(output) || typeof output.name !== "string" || typeof output.artifact_type !== "string") return [];
    const release = parseRelease(output.release);
    const declared = hasOwn(output, "attention") && typeof output.attention === "string"
      ? { attention: output.attention as DeclaredOutputSlot["attention"], release }
      : { release };
    return [{ output_name: output.name, artifact_type: output.artifact_type, release,
      attention: selectOutputAttention(declared) }];
  });
};

export const findDeclaredOutput = (contract: JsonValue, output_name: string): DeclaredOutputSlot | null =>
  parseStageContractOutputs(contract).find((output) => output.output_name === output_name) ?? null;

/** The stage key a contract was compiled for, for diagnostics that hold only the row. */
export const stageContractKey = (contract: JsonValue): string | null =>
  isObject(contract) && typeof contract.stage_key === "string" ? contract.stage_key : null;

export const parseStageContractMachine = (contract: JsonValue): CompiledMachine | null => {
  if (!isObject(contract) || !isObject(contract.machine)) return null;
  const machine = contract.machine;
  if (typeof machine.stage_type !== "string" || machine.stage_type.length === 0) return null;
  const parsed = machineDefinitionSchema.safeParse(machine);
  return parsed.success ? { ...parsed.data, stage_type: machine.stage_type } as unknown as CompiledMachine : null;
};

/**
 * Where a stage's declared inputs come from, resolved to stage-instance ids when
 * the stage was opened.
 *
 * Written beside the compiled contract for the same reason
 * `dependency_stage_instance_ids` is: the graph's edges name stage *keys*, and
 * nothing at decision or launch time should be resolving a definition's names
 * again. A driver that had to do it would be re-deriving, at every step, a
 * mapping the launch already fixed.
 */
export const STAGE_CONTRACT_INPUT_EDGES_KEY = "input_edges";

export interface StageInputEdge {
  readonly input_name: string;
  readonly producer_stage_instance_id: string;
  readonly producer_output: string;
  /** A collecting input takes every accepted revision; a scalar one takes the latest. */
  readonly collect: boolean;
}

export const parseStageInputEdges = (contract: JsonValue): readonly StageInputEdge[] => {
  if (!isObject(contract)) return [];
  const edges = contract[STAGE_CONTRACT_INPUT_EDGES_KEY];
  if (!Array.isArray(edges)) return [];
  return edges.flatMap((edge) => {
    if (!isObject(edge) || typeof edge.input_name !== "string"
      || typeof edge.producer_stage_instance_id !== "string" || typeof edge.producer_output !== "string") return [];
    return [{ input_name: edge.input_name, producer_stage_instance_id: edge.producer_stage_instance_id,
      producer_output: edge.producer_output, collect: edge.collect === true }];
  });
};

/**
 * What a parked slot's wait closes on, as the operator projections read it.
 *
 * `gate_step` and `actions` are the two fields every gate surface addresses a
 * wait by, so they are written flat rather than nested inside the release
 * contract a projection would then have to know the shape of.
 *
 * One step only. A multi-step gate would need a wait per step and a cursor
 * between them; `dev_flow_v15` declares none, and flattening the first step of
 * several would silently publish a wait that closes on the wrong actions and
 * releases the artifact after the first of its reviews. Refused rather than
 * approximated.
 */
export const selectWaitClosesOn = (release: OutputReleaseContract): JsonValue => {
  if (release.kind === "gate") {
    if (release.steps.length > 1) {
      throw new Error(`gate '${release.gate_name}' declares ${release.steps.length} steps; a wait carries one`);
    }
    const step = release.steps[0];
    return {
      kind: "gate",
      gate_name: release.gate_name,
      gate_step: step?.type ?? "artifact_approval",
      actions: (step?.actions ?? []).map((action) => action.name),
    };
  }
  if (release.kind === "handoff") {
    return {
      kind: "handoff",
      handoff_name: release.handoff_name,
      downstream_role: release.downstream_role,
      external_wait_kind: release.external_wait_kind,
      close_events: [...release.close_events],
    };
  }
  return { kind: "immediate" };
};

/** `oakridge.wait_kind` for a release policy that parks its slot. */
export const selectWaitKind = (release: OutputReleaseContract): "gate" | "handoff" | null =>
  release.kind === "gate" ? "gate" : release.kind === "handoff" ? "handoff" : null;
