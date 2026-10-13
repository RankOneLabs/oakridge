import type { CompiledWorkflow, Group, Unit, Workflow } from "../core-client/core-types";
import { selectWorkflowSchemas, typeSchemaKey, type Schema } from "./schema-view";
import { ROOT_UNIT_KEY, titleCase } from "./unit-label";

/**
 * v1 `DefinitionBundle`, renamed per rescue spec §2.3, carrying only what has a
 * v2 source: the workflow's name, version, root, schemas and the units the
 * operator sees. The rest of v1's bundle (trees, commands, workers, limits,
 * operations, prompts) is removed (R4 decision, part 1 §12).
 */
export interface DefinitionBundle {
  readonly key: string;
  readonly version: number;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly Schema[];
  readonly units: readonly UnitDefinition[];
}
/** v1 `ScopeDefinition`: the root, and each unit declared on a stage, keyed as its run units are. */
export interface UnitDefinition {
  readonly key: string;
  readonly input_schema: string;
  readonly presentation: { readonly label: string };
  readonly artifacts: readonly ArtifactDefinition[];
}
/** v1 `OutputDefinition`. */
export interface ArtifactDefinition {
  readonly key: string;
  readonly schema: string;
  /** Every v2 artifact is single per unit. */
  readonly collection_key: string | null;
  /** Operator edits (D2) have no route yet: null hides the edit entry point. */
  readonly edit_trigger: string | null;
}

/** A pinned definition as the catalog lists it (GET/POST /api/definitions). */
export interface DefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle; readonly archived_at: Date | null }
/** A run's pinned definition with its checked program (GET /api/runs/:run_id/definition). */
export interface PinnedDefinition extends DefinitionSummary { readonly checked_program: CompiledWorkflow }
export interface DefinitionPage { readonly items: readonly DefinitionSummary[]; readonly next_cursor: string | null }
export interface DefinitionGraphNode { readonly key: string; readonly scope: string; readonly depends_on: readonly string[] }
export interface DefinitionGraph { readonly nodes: readonly DefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }
/** v1's `authoring` is removed: definition editing in the PWA is part 2's open product call. */
export interface DefinitionDetail extends DefinitionSummary { readonly graph: DefinitionGraph }

/** Every unit declared in a group, its nested groups included, depth first. */
function declaredUnits(group: Group): readonly (readonly [string, Unit])[] {
  return Object.entries(group.units).flatMap(([key, unit]) => [[key, unit] as const, ...(unit.group ? declaredUnits(unit.group) : [])]);
}

export function selectDefinitionBundle(workflow: Workflow, version: number): DefinitionBundle {
  const root: UnitDefinition = { key: ROOT_UNIT_KEY, input_schema: typeSchemaKey(workflow.input), presentation: { label: titleCase(workflow.workflow) }, artifacts: [] };
  const staged = declaredUnits(workflow.run).flatMap(([key, unit]): UnitDefinition[] => {
    const stage = unit.stage == null ? undefined : workflow.stages[unit.stage];
    if (!stage) return [];
    return [{ key, input_schema: typeSchemaKey(stage.input), presentation: { label: titleCase(key) },
      artifacts: Object.entries(stage.artifacts).sort(([left], [right]) => left.localeCompare(right))
        .map(([artifact, declared]) => ({ key: artifact, schema: typeSchemaKey(declared.schema), collection_key: null, edit_trigger: null })) }];
  });
  const seen = new Set<string>();
  return { key: workflow.workflow, version, root: ROOT_UNIT_KEY, schemas: selectWorkflowSchemas(workflow),
    units: [root, ...staged].filter((unit) => !seen.has(unit.key) && !!seen.add(unit.key)) };
}

export interface DefinitionSource { readonly bundle_id: string; readonly digest: string; readonly version: number; readonly source: Workflow; readonly archived_at: Date | null }
export const selectDefinitionSummary = (definition: DefinitionSource): DefinitionSummary => ({ bundle_id: definition.bundle_id,
  digest: definition.digest, source: selectDefinitionBundle(definition.source, definition.version), archived_at: definition.archived_at });
export const selectPinnedDefinition = (definition: DefinitionSource & { readonly checked_program: CompiledWorkflow }): PinnedDefinition =>
  ({ ...selectDefinitionSummary(definition), checked_program: definition.checked_program });
export const selectDefinitionDetail = (definition: DefinitionSource): DefinitionDetail =>
  ({ ...selectDefinitionSummary(definition), graph: selectDefinitionGraph(definition.source) });

function groupNodes(group: Group, prefix = ""): DefinitionGraph["nodes"] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    // A string `after` is an expression evaluated per collection member, not a unit key: it has no static edge.
    const after = unit.after == null || typeof unit.after === "string" ? [] : unit.after;
    const node = { key: path, scope: unit.stage ?? key, depends_on: after.map((dependency) => prefix ? `${prefix}/${dependency}` : dependency) };
    return [node, ...(unit.group ? groupNodes(unit.group, path) : [])];
  });
}
/** The unit graph a workflow declares, for the catalog. */
export function selectDefinitionGraph(workflow: Workflow): DefinitionGraph {
  const nodes = groupNodes(workflow.run);
  return { nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.key }))) };
}
