import { legacyMachineVocabulary } from "../adapters/dev-flow-machine";
import { selectOutputAttention, type CompiledEdge, type CompiledGateStep, type CompiledOutputContract, type CompiledStageContract, type CompiledWorkflowDefinition, type OutputReleaseContract } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { PromptBundle, StageNodeDefinition, WorkflowDefinition } from "../domain/workflow";
import { delegatedSessionDefinitionSchema, validateDelegatedSessionCardinality, validateDelegatedSessionContracts, validatePromptBundleBindings, type DelegatedSessionDiagnostic } from "../validation/delegated-session";
import { repositoryProvisioningDefinitionSchema } from "../validation/repository-provisioning";
import { selectBuiltInGateDisposition } from "../domain/gates";
import { readOwn } from "../domain/records";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, type RepositoryProvisioningDefinitionConfig } from "../domain/repository-refs";
import { createDevFlowAdapterRegistry } from "../adapters/dev-flow";
import type { AdapterRoleRegistry } from "../validation/workflow-definition";
import type { CompiledMachine, EffectRef, EventMatch, MachineDefinition, MachineRegistry, Transition } from "../domain/stage-machine";
import { StageMachineRegistry } from "../runtime/executor-registry";


export const createLegacyValidationRegistry = (): MachineRegistry => {
  const registry = new StageMachineRegistry();
  // Legacy graph validation only; these callbacks have no execution authority.
  for (const name of legacyMachineVocabulary.guards)
    registry.register_guard("delegated_session", name as never, () => false);
  for (const name of legacyMachineVocabulary.effects)
    registry.register_effect("delegated_session", name as never);
  for (const name of legacyMachineVocabulary.observers) registry.register_observer("delegated_session", name as never);
  return registry;
};

export type MachineCheck = "names_exist" | "initial_state" | "reachability" | "group_totality" | "mandatory_events"
  | "termination" | "prompt_totality" | "retry_correspondence" | "outputs" | "gates" | "no_orphan_gate";
export interface MachineDiagnostic {
  readonly kind: "machine_validation";
  readonly check: MachineCheck;
  readonly stage_key: string;
  readonly state: string | null;
  readonly row_index: number | null;
  readonly contract_item: string;
  readonly detail: string;
}

const isTerminal = (status: string): boolean => status === "complete" || status === "failed" || status === "cancelled";
const fromMatches = (machine: MachineDefinition, from: Transition["from"], state: string): boolean =>
  typeof from === "string" ? from === state : !isTerminal(readOwn(machine.states, state)?.status ?? "failed");
const eventKey = (event: EventMatch): string => JSON.stringify(event);
const effectsOf = (row: Transition): readonly EffectRef[] => "to" in row ? row.effects : [];
const stringArg = (effect: EffectRef, name: string): string | null => typeof effect.args[name] === "string" ? effect.args[name] as string : null;
const outputArgs = (effect: EffectRef): readonly string[] => Array.isArray(effect.args.outputs)
  ? effect.args.outputs.filter((value): value is string => typeof value === "string") : [];

const validateGraphMachine = (stage_key: string, stage_type: string, machine: MachineDefinition,
  outputs: readonly string[], gates: readonly { readonly name: string; readonly steps: readonly { readonly actions: readonly string[] }[] }[],
  promptCells: readonly { readonly session_role: string; readonly launch_reason: string }[], registry: MachineRegistry): readonly MachineDiagnostic[] => {
  const diagnostics: MachineDiagnostic[] = [];
  const add = (check: MachineCheck, detail: string, state: string | null = null, row_index: number | null = null): void => {
    diagnostics.push({ kind: "machine_validation", check, stage_key, state, row_index, contract_item: state ?? "machine", detail });
  };
  const states = Object.keys(machine.states);
  const initial = readOwn(machine.states, machine.initial);
  if (!initial || initial.status !== "pending") add("initial_state", "initial state must exist and be pending", machine.initial);
  for (const [row_index, row] of machine.transitions.entries()) {
    if (typeof row.from === "string" && !readOwn(machine.states, row.from)) add("names_exist", "from state is undeclared", row.from, row_index);
    if ("to" in row && !readOwn(machine.states, row.to)) add("names_exist", "target state is undeclared", row.to, row_index);
    if ("to" in row && row.to === machine.initial) add("initial_state", "row targets initial state", row.to, row_index);
    if (row.guard && !registry.has_guard(stage_type, row.guard.name)) add("names_exist", `guard '${row.guard.name}' is unregistered`, typeof row.from === "string" ? row.from : null, row_index);
    if (row.on.event === "external_observed" && !registry.has_observer(stage_type, row.on.source)) add("names_exist", `observer '${row.on.source}' is unregistered`, typeof row.from === "string" ? row.from : null, row_index);
    for (const effect of effectsOf(row)) if (!registry.has_effect(stage_type, effect.name)) add("names_exist", `effect '${effect.name}' is unregistered`, typeof row.from === "string" ? row.from : null, row_index);
  }
  const reachable = new Set<string>([machine.initial]);
  for (let count = 0; count < states.length; count++) for (const row of machine.transitions) {
    if (!("to" in row)) continue;
    if (states.some((state) => reachable.has(state) && fromMatches(machine, row.from, state))) reachable.add(row.to);
  }
  for (const state of states) if (!reachable.has(state)) add("reachability", "state is unreachable", state);
  const groups = new Map<string, { row: Transition; index: number }>();
  for (const [index, row] of machine.transitions.entries()) groups.set(`${JSON.stringify(row.from)}:${eventKey(row.on)}`, { row, index });
  for (const { row, index } of groups.values()) if (row.guard) add("group_totality", "group ends with a guarded row", typeof row.from === "string" ? row.from : null, index);
  const handles = (state: string, event: EventMatch): boolean => machine.transitions.some((row) => fromMatches(machine, row.from, state) && eventKey(row.on) === eventKey(event));
  for (const state of states) {
    const declaration = readOwn(machine.states, state);
    if (!declaration) continue;
    if (!isTerminal(declaration.status)) for (const event of ["cancel", "operator_abandon"] as const) {
      if (!handles(state, { event })) add("mandatory_events", `missing ${event}`, state);
    }
    if (declaration.session_role && !handles(state, { event: "session_ended" })) add("mandatory_events", "missing session_ended", state);
    const shouldRetry = declaration.status === "blocked" && declaration.blocked_reason === "retry" && declaration.next_actor === "operator";
    if (handles(state, { event: "operator_retry" }) !== shouldRetry) add("retry_correspondence", "operator_retry does not match retry state", state);
  }
  const gateByName = new Map(gates.map((gate) => [gate.name, gate]));
  const opened = new Set<string>();
  for (const [row_index, row] of machine.transitions.entries()) {
    for (const effect of effectsOf(row)) if (effect.name === "open_gate") {
      const gateName = stringArg(effect, "gate");
      if (!gateName || !gateByName.has(gateName)) add("gates", `unknown gate '${gateName}'`, "to" in row ? row.to : null, row_index);
      else opened.add(gateName);
      if ("to" in row && gateName) {
        const actions = gateByName.get(gateName)?.steps.flatMap((step) => step.actions) ?? [];
        for (const action of actions) if (!handles(row.to, { event: "gate_decided", gate: gateName, action }))
          add("mandatory_events", `missing gate_decided ${gateName}:${action}`, row.to, row_index);
        for (const [exitIndex, exit] of machine.transitions.entries()) {
          if (!fromMatches(machine, exit.from, row.to) || !("to" in exit) || exit.to === row.to) continue;
          if (!["gate_decided", "cancel", "operator_abandon"].includes(exit.on.event))
            add("no_orphan_gate", `gate state exits through ${exit.on.event}`, row.to, exitIndex);
        }
      }
    }
  }
  for (const gate of gates) if (!opened.has(gate.name)) add("gates", `gate '${gate.name}' is never opened`);
  const reachesEnd = (state: string, visited: ReadonlySet<string>): boolean => {
    const declaration = readOwn(machine.states, state);
    if (!declaration) return false;
    if (isTerminal(declaration.status) || declaration.next_actor === "operator") return true;
    if (visited.has(state)) return false;
    const next = new Set(visited); next.add(state);
    return machine.transitions.some((row) => "to" in row && fromMatches(machine, row.from, state) && reachesEnd(row.to, next));
  };
  for (const state of states) if (!reachesEnd(state, new Set())) add("termination", "no path to terminal or operator", state);
  const launches = machine.transitions.flatMap((row, row_index) => effectsOf(row)
    .filter((effect) => effect.name === "launch_session").map((effect) => ({ row, row_index, role: stringArg(effect, "role"), reason: stringArg(effect, "reason") })));
  const launchPairs = new Set(launches.map((launch) => `${launch.role}:${launch.reason}`));
  const promptPairs = new Set(promptCells.map((cell) => `${cell.session_role}:${cell.launch_reason}`));
  for (const launch of launches) {
    if (!promptPairs.has(`${launch.role}:${launch.reason}`)) add("prompt_totality", `launch ${launch.role}:${launch.reason} has no prompt`, "to" in launch.row ? launch.row.to : null, launch.row_index);
    if ("to" in launch.row && readOwn(machine.states, launch.row.to)?.session_role !== launch.role)
      add("prompt_totality", `launch role '${launch.role}' does not match target`, launch.row.to, launch.row_index);
  }
  for (const cell of promptCells) if (!launchPairs.has(`${cell.session_role}:${cell.launch_reason}`)) add("prompt_totality", `orphan prompt ${cell.session_role}:${cell.launch_reason}`);
  for (const state of states) {
    const role = readOwn(machine.states, state)?.session_role;
    if (role && !launches.some((launch) => "to" in launch.row && launch.row.to === state && launch.role === role
      && !(launch.row.from === state && readOwn(machine.states, state)?.session_role === role)))
      add("prompt_totality", `session state '${state}' has no entering launch`, state);
  }
  const declared = new Set(outputs);
  const published = new Set(machine.transitions.filter((row) => row.on.event === "artifact_published")
    .map((row) => row.on).filter((event): event is Extract<EventMatch, { event: "artifact_published" }> => event.event === "artifact_published")
    .map((event) => event.output));
  const accepted = new Set(machine.transitions.flatMap((row) => effectsOf(row).filter((effect) => effect.name === "accept_outputs").flatMap(outputArgs)));
  for (const output of outputs) {
    if (!published.has(output)) add("outputs", `output '${output}' has no publication row`);
    if (!accepted.has(output)) add("outputs", `output '${output}' is never accepted`);
  }
  for (const [row_index, row] of machine.transitions.entries()) for (const effect of effectsOf(row)) {
    if (effect.name === "record_output" && row.on.event !== "artifact_published") add("outputs", "record_output is not on artifact_published", typeof row.from === "string" ? row.from : null, row_index);
    if (effect.name === "open_gate" || effect.name === "accept_outputs") for (const output of outputArgs(effect))
      if (!declared.has(output)) add("outputs", `undeclared output '${output}'`, typeof row.from === "string" ? row.from : null, row_index);
  }
  return diagnostics;
};

export interface CompileWorkflowError {
  readonly operation: "compile_workflow";
  readonly stage_key: string | null;
  readonly detail: string;
  readonly diagnostics?: readonly (DelegatedSessionDiagnostic | MachineDiagnostic)[];
}

export const WORKFLOW_VALIDATION_STEPS = [
  "parse_and_graph",
  "plural_key_cardinality",
  "selection_totality",
  "binding_and_output_contracts",
  "executor_capabilities",
] as const;

export interface StageTypeCompilation {
  readonly definition_config: DelegatedSessionDefinitionConfig | JsonValue;
  readonly max_active_cohorts: number;
  output_release(output_name: string): OutputReleaseContract;
}

export interface StageTypeCompiler {
  compile(stage_key: string, config: JsonValue): Result<StageTypeCompilation, CompileWorkflowError>;
}

/**
 * Resolve a step's declared action names to their dispositions. Definition
 * validation has already rejected any name without one, so this is total.
 */
const compileGateStep = (step: { readonly type: string; readonly actions: readonly string[] }): CompiledGateStep =>
  ({ type: step.type, actions: step.actions.map((name) => ({ name, disposition: selectBuiltInGateDisposition(name) })) });

const outputRelease = (outputName: string, config: DelegatedSessionDefinitionConfig): OutputReleaseContract => {
  const gate = config.gates.find((candidate) => candidate.outputs.includes(outputName));
  if (gate) return { kind: "gate", gate_name: gate.name, steps: gate.steps.map(compileGateStep) };
  const handoff = config.handoffs.find((candidate) => candidate.outputs.includes(outputName));
  if (handoff) return {
    kind: "handoff",
    handoff_name: handoff.name,
    downstream_role: handoff.downstream_role,
    external_wait_kind: handoff.approved_wait.kind,
    close_events: handoff.approved_wait.close_events,
  };
  return { kind: "immediate" };
};

const delegatedSessionStageTypeCompiler: StageTypeCompiler = {
  compile(stageKey, rawConfig) {
  const parsed = delegatedSessionDefinitionSchema.safeParse(rawConfig);
  if (!parsed.success) return err({ operation: "compile_workflow", stage_key: stageKey, detail: parsed.error.message });
  const config = parsed.data as DelegatedSessionDefinitionConfig;
  return ok({
    definition_config: config,
    max_active_cohorts: 1,
    output_release: (outputName) => outputRelease(outputName, config),
  });
  },
};

/**
 * Repository provisioning fans out over the run's repositories, one unit each,
 * so a repository that cannot be provisioned fails and retries on its own
 * rather than taking its siblings with it. The unit id is the repository key —
 * fixed by `RunContextRepository` rather than configurable, because the key is
 * what every downstream lookup already matches on.
 */
const repositoryProvisioningStageTypeCompiler: StageTypeCompiler = {
  compile(stageKey, rawConfig) {
    const parsed = repositoryProvisioningDefinitionSchema.safeParse(rawConfig);
    if (!parsed.success) return err({ operation: "compile_workflow", stage_key: stageKey, detail: parsed.error.message });
    const config = parsed.data as RepositoryProvisioningDefinitionConfig;
    return ok({
      definition_config: config as unknown as JsonValue,
      max_active_cohorts: config.max_parallel,
      // Nothing reviews provisioned refs: they are a fact about a repository,
      // not a document. Gating them would park every run behind an approval of
      // a branch name the operator already chose.
      output_release: () => ({ kind: "immediate" }),
    });
  },
};

export type StageTypeCompilerRegistry = Readonly<Record<string, StageTypeCompiler>>;

const builtInStageTypeCompilers: StageTypeCompilerRegistry = {
  delegated_session: delegatedSessionStageTypeCompiler,
  [PROVISION_REPOSITORY_REFS_STAGE_TYPE]: repositoryProvisioningStageTypeCompiler,
};

const compileStage = (stageKey: string, node: StageNodeDefinition, registry: StageTypeCompilerRegistry, machine?: CompiledMachine): Result<CompiledStageContract, CompileWorkflowError> => {
  const compiler = registry[node.stage_type];
  if (!compiler) return err({ operation: "compile_workflow", stage_key: stageKey, detail: `unregistered stage type '${node.stage_type}'` });
  const compiledConfig = compiler.compile(stageKey, node.config);
  if (!compiledConfig.ok) return compiledConfig;
  const outputs: CompiledOutputContract[] = [];
  for (const output of node.outputs) {
    const release = compiledConfig.value.output_release(output.name);
    const attention = selectOutputAttention({ attention: output.attention, release });
    if (attention === "required" && release.kind === "immediate") {
      return err({ operation: "compile_workflow", stage_key: stageKey,
        detail: `output '${output.name}' declares required attention but continues immediately` });
    }
    outputs.push({ ...output, release });
  }
  return ok({
    stage_key: stageKey,
    stage_type: node.stage_type,
    operator_role: node.operator_role,
    inputs: node.inputs,
    outputs,
    max_active_cohorts: compiledConfig.value.max_active_cohorts,
    executor: { executor_type: node.stage_type, definition_config: compiledConfig.value.definition_config },
    ...(machine ? { machine } : {}),
  });
};

export const compileWorkflowDefinition = (
  definition: WorkflowDefinition,
  registry: StageTypeCompilerRegistry = builtInStageTypeCompilers,
  _adapterRegistry: AdapterRoleRegistry = createDevFlowAdapterRegistry(),
  machineRegistry: MachineRegistry = createLegacyValidationRegistry(),
): Result<CompiledWorkflowDefinition, CompileWorkflowError> => {
  const diagnostics: (DelegatedSessionDiagnostic | MachineDiagnostic)[] = [];
  const machines: Record<string, CompiledMachine> = {};
  for (const [stageKey, node] of Object.entries(definition.graph.stages)) {
    const machineValue = typeof node.config === "object" && node.config !== null && !Array.isArray(node.config)
      ? readOwn(node.config as { readonly [key: string]: JsonValue }, "machine") : undefined;
    const machineName = typeof machineValue === "string" ? machineValue : null;
    if (machineName) {
      const machine = definition.machines ? readOwn(definition.machines, machineName) : undefined;
      if (!machine) diagnostics.push({ kind: "machine_validation", check: "names_exist", stage_key: stageKey, state: null,
        row_index: null, contract_item: "machine", detail: `machine '${machineName}' is undeclared` });
      else {
        const config = node.stage_type === "delegated_session" ? delegatedSessionDefinitionSchema.safeParse(node.config) : null;
        const gateList = config?.success ? config.data.gates : [];
        const promptCells = config?.success ? config.data.prompt_matrix
          : node.stage_type === PROVISION_REPOSITORY_REFS_STAGE_TYPE
            ? [{ session_role: "provision", launch_reason: "initial" }, { session_role: "provision", launch_reason: "operator_retry" }] : [];
        diagnostics.push(...validateGraphMachine(stageKey, node.stage_type, machine, node.outputs.map((output) => output.name), gateList, promptCells, machineRegistry));
        machines[stageKey] = { ...machine, stage_type: node.stage_type };
      }
    }
    if (node.stage_type !== "delegated_session") continue;
    const parsed = delegatedSessionDefinitionSchema.safeParse(node.config);
    if (!parsed.success) {
      diagnostics.push({ kind: "invalid_stage_config", stage_key: stageKey, session_role: node.operator_role,
        contract_item: "config", issues: parsed.error.issues.map((issue) => issue.message) });
      continue;
    }
    diagnostics.push(...validateDelegatedSessionCardinality(stageKey, node.operator_role, parsed.data));
    diagnostics.push(...validateDelegatedSessionContracts(stageKey, node.operator_role,
      node.outputs.map((output) => output.name), parsed.data));
  }
  if (diagnostics.length > 0) return err({ operation: "compile_workflow", stage_key: diagnostics[0]?.stage_key ?? null,
    detail: diagnostics.map((diagnostic) => `${diagnostic.kind}: ${diagnostic.stage_key}.${diagnostic.contract_item}`).join("\n"), diagnostics });
  const stages: Record<string, CompiledStageContract> = {};
  for (const [stageKey, node] of Object.entries(definition.graph.stages)) {
    const compiled = compileStage(stageKey, node, registry, machines[stageKey]);
    if (!compiled.ok) return compiled;
    stages[stageKey] = compiled.value;
  }
  const edges: CompiledEdge[] = definition.graph.edges.map((edge) => {
    const consumer = readOwn(stages, edge.to.stage);
    const input = consumer?.inputs.find((candidate) => candidate.name === edge.to.slot);
    if (!input) throw new Error(`validated edge input disappeared: ${edge.to.stage}.${edge.to.slot}`);
    return { producer_stage: edge.from.stage, producer_output: edge.from.slot, consumer_stage: edge.to.stage, consumer_input: edge.to.slot, delivery: input.delivery };
  });
  const blockedByRequiredEdge = new Set(edges.filter((edge) => !readOwn(stages, edge.consumer_stage)?.inputs.find((input) => input.name === edge.consumer_input)?.optional).map((edge) => edge.consumer_stage));
  const source_stages = Object.keys(stages).filter((stageKey) => !blockedByRequiredEdge.has(stageKey)).sort();
  return ok({ manifest_version: 1, stages, edges, source_stages });
};

export interface CompileManifestVersions {
  readonly adapter_version: string;
  readonly artifact_schema_version: string;
}

/** Compile the run-pinned manifest after its content-addressed prompt bundle exists. */
export const compileWorkflowManifest = (
  definition: WorkflowDefinition,
  promptBundle: PromptBundle,
  versions: CompileManifestVersions,
  registry: StageTypeCompilerRegistry = builtInStageTypeCompilers,
  adapterRegistry: AdapterRoleRegistry = createDevFlowAdapterRegistry(),
  machineRegistry: MachineRegistry = createLegacyValidationRegistry(),
): Result<CompiledWorkflowDefinition, CompileWorkflowError> => {
  const compiled = compileWorkflowDefinition(definition, registry, adapterRegistry, machineRegistry);
  const promptDiagnostics: DelegatedSessionDiagnostic[] = [];
  for (const [stageKey, node] of Object.entries(definition.graph.stages)) {
    if (node.stage_type !== "delegated_session") continue;
    const parsed = delegatedSessionDefinitionSchema.safeParse(node.config);
    if (!parsed.success) continue;
    const cells = promptBundle.matrix.filter((entry) => (entry.stage_key === undefined || entry.stage_key === stageKey)
      && parsed.data.prompt_matrix.some((declared) => declared.session_role === entry.session_role
        && declared.launch_reason === entry.launch_reason && declared.template_path === entry.template_path));
    promptDiagnostics.push(...validatePromptBundleBindings(stageKey, parsed.data, cells));
  }
  if (!compiled.ok || promptDiagnostics.length > 0) {
    const diagnostics = [...(compiled.ok ? [] : compiled.error.diagnostics ?? []), ...promptDiagnostics];
    if (diagnostics.length === 0 && !compiled.ok) return compiled;
    return err({ operation: "compile_workflow", stage_key: diagnostics[0]?.stage_key ?? (compiled.ok ? null : compiled.error.stage_key),
      detail: diagnostics.map((diagnostic) => `${diagnostic.kind}: ${diagnostic.stage_key}.${diagnostic.contract_item}`).join("\n"), diagnostics });
  }
  return ok({ ...compiled.value, bundle_pin: { definition_version: definition.version,
    prompt_bundle_hash: promptBundle.hash, adapter_version: versions.adapter_version,
    artifact_schema_version: versions.artifact_schema_version } });
};

// The authored v15 boundary validates cohort trees, not event machines.
export { compileV15WorkflowDefinition, v15PromptReferences } from "./compile-v15";
export { validateV15DecisionTree as validateMachine } from "../validation/v15-definition";
