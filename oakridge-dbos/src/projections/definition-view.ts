import type { CompiledWorkflow, Group, Unit, Workflow } from "../core-client/core-types";
import { selectWorkflowSchemas, typeSchemaKey, type Schema } from "./schema-view";
import { ROOT_UNIT_KEY, titleCase } from "./unit-label";

/** A pinned workflow as the operator sees it: its name, root, schemas and the units it declares. */
export interface DefinitionBundle {
  readonly key: string;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly Schema[];
  readonly units: readonly UnitDefinition[];
}
/** The root, and each unit declared on a stage. */
export interface UnitDefinition {
  /** Its declaration path (`integration/repository`), as the definition graph keys it; `$root` for the root. Unique in the bundle. */
  readonly key: string;
  readonly stage: string | null;
  readonly label: string;
  readonly input_schema: string;
  readonly artifacts: readonly ArtifactDefinition[];
}
export interface ArtifactDefinition { readonly key: string; readonly schema: string }

/** A pinned definition as the catalog lists it (GET/POST /api/definitions). */
export interface DefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly bundle: DefinitionBundle; readonly archived_at: Date | null }
/** A run's pinned definition with its checked program (GET /api/runs/:run_id/definition). */
export interface PinnedDefinition extends DefinitionSummary { readonly checked_program: CompiledWorkflow }
export interface DefinitionPage { readonly items: readonly DefinitionSummary[]; readonly next_cursor: string | null }
export interface DefinitionGraphNode { readonly key: string; readonly stage: string; readonly depends_on: readonly string[] }
export interface DefinitionGraph { readonly nodes: readonly DefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }
/** One pinned definition with the workflow source it was compiled from, which the editor clones. */
export interface DefinitionDetail extends DefinitionSummary { readonly workflow: Workflow; readonly graph: DefinitionGraph }

/** One unit a workflow declares: its key in its group, the group's path, and its own path, unique in the workflow. */
interface DeclaredUnit { readonly key: string; readonly prefix: string; readonly path: string; readonly unit: Unit }
/** Every unit declared in a group, its nested groups included, depth first. */
function declaredUnits(group: Group, prefix = ""): readonly DeclaredUnit[] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    return [{ key, prefix, path, unit }, ...(unit.group ? declaredUnits(unit.group, path) : [])];
  });
}

export function selectDefinitionBundle(workflow: Workflow): DefinitionBundle {
  const root: UnitDefinition = { key: ROOT_UNIT_KEY, stage: null, label: titleCase(workflow.workflow), input_schema: typeSchemaKey(workflow.input), artifacts: [] };
  const staged = declaredUnits(workflow.run).flatMap(({ key, path, unit }): UnitDefinition[] => {
    const stage = unit.stage == null ? undefined : workflow.stages[unit.stage];
    if (!stage) return [];
    return [{ key: path, stage: unit.stage ?? null, label: titleCase(key), input_schema: typeSchemaKey(stage.input),
      artifacts: Object.entries(stage.artifacts).sort(([left], [right]) => left.localeCompare(right))
        .map(([artifact, declared]) => ({ key: artifact, schema: typeSchemaKey(declared.schema) })) }];
  });
  return { key: workflow.workflow, root: ROOT_UNIT_KEY, schemas: selectWorkflowSchemas(workflow), units: [root, ...staged] };
}

export interface DefinitionSource { readonly bundle_id: string; readonly digest: string; readonly source: Workflow; readonly archived_at: Date | null }
export const selectDefinitionSummary = (definition: DefinitionSource): DefinitionSummary => ({ bundle_id: definition.bundle_id,
  digest: definition.digest, bundle: selectDefinitionBundle(definition.source), archived_at: definition.archived_at });
export const selectPinnedDefinition = (definition: DefinitionSource & { readonly checked_program: CompiledWorkflow }): PinnedDefinition =>
  ({ ...selectDefinitionSummary(definition), checked_program: definition.checked_program });
export const selectDefinitionDetail = (definition: DefinitionSource): DefinitionDetail =>
  ({ ...selectDefinitionSummary(definition), workflow: definition.source, graph: selectDefinitionGraph(definition.source) });

function graphNode({ key, prefix, path, unit }: DeclaredUnit): DefinitionGraphNode {
  // A string `after` is an expression evaluated per collection member, not a unit key: it has no static edge.
  const after = unit.after == null || typeof unit.after === "string" ? [] : unit.after;
  return { key: path, stage: unit.stage ?? key, depends_on: after.map((dependency) => prefix ? `${prefix}/${dependency}` : dependency) };
}
/** The unit graph a workflow declares, for the catalog. */
export function selectDefinitionGraph(workflow: Workflow): DefinitionGraph {
  const nodes = declaredUnits(workflow.run).map(graphNode);
  return { nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.key }))) };
}
