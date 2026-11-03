import type { AuthoredWorkflow, Group, ParsedWorkflow, Unit, Workflow } from "../core-client/core-types";
import { selectWorkflowSchemas, typeSchemaKey, type Schema, type SchemaOrder } from "./schema-view";
import { ROOT_UNIT_KEY, titleCase } from "./unit-label";

/** A pinned workflow as the operator sees it: its name, root, schemas and the units it declares. */
export interface DefinitionBundle {
  readonly key: string;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly Schema[];
  readonly stages: readonly string[];
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

/** A pinned definition as the catalog lists it (GET /api/definitions). */
export interface DefinitionSummary { readonly definition_id: import("../runtime/definition-store").DefinitionId; readonly bundle: DefinitionBundle }
/** A run's committed definition (GET /api/runs/:run_id/definition). */
export type PinnedDefinition = DefinitionSummary;
export interface DefinitionPage { readonly items: readonly DefinitionSummary[]; readonly next_cursor: string | null }
export interface DefinitionGraphNode { readonly key: string; readonly stage: string; readonly depends_on: readonly string[] }
export interface DefinitionGraph { readonly nodes: readonly DefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }
/** One committed definition with its authored workflow source. */
export interface DefinitionDetail extends DefinitionSummary { readonly workflow: Workflow | AuthoredWorkflow; readonly graph: DefinitionGraph }

/** One unit a workflow declares: its key in its group, the group's path, and its own path, unique in the workflow. */
interface DeclaredUnit { readonly key: string; readonly prefix: string; readonly path: string; readonly unit: Unit }
/** Every unit declared in a group, its nested groups included, depth first. */
function declaredUnits(group: Group, prefix = ""): readonly DeclaredUnit[] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    return [{ key, prefix, path, unit }, ...(unit.group ? declaredUnits(unit.group, path) : [])];
  });
}

export function selectDefinitionBundle(workflow: ParsedWorkflow, source?: AuthoredWorkflow, order?: SchemaOrder): DefinitionBundle {
  const root: UnitDefinition = { key: ROOT_UNIT_KEY, stage: null, label: titleCase(workflow.workflow), input_schema: typeSchemaKey(workflow.input), artifacts: [] };
  const staged = declaredUnits((source ?? workflow).run).flatMap(({ key, path, unit }): UnitDefinition[] => {
    const stage = unit.stage == null ? undefined : workflow.stages[unit.stage];
    if (!stage) return [];
    return [{ key: path, stage: unit.stage ?? null, label: titleCase(key), input_schema: typeSchemaKey(stage.input),
      artifacts: Object.entries(stage.artifacts).sort(([left], [right]) => left.localeCompare(right))
        .map(([artifact, declared]) => ({ key: artifact, schema: typeSchemaKey(declared.schema) })) }];
  });
  const authored_order = order ?? (source ? { schema_names: Object.keys(source.schemas ?? {}), stage_names: Object.keys(source.stages) } : undefined);
  return { key: workflow.workflow, root: ROOT_UNIT_KEY, schemas: selectWorkflowSchemas(workflow, authored_order), stages: authored_order?.stage_names ?? Object.keys(workflow.stages), units: [root, ...staged] };
}

export type DefinitionSource = import("../core-client/client").CompiledDefinition;
export const selectDefinitionSummary = (definition: DefinitionSource): DefinitionSummary => ({ definition_id: definition.definition_id,
  bundle: selectDefinitionBundle(definition.checked_program.workflow, definition.source, definition) });
export const selectPinnedDefinition = (definition: DefinitionSource): PinnedDefinition =>
  selectDefinitionSummary(definition);
export const selectDefinitionDetail = (definition: DefinitionSource): DefinitionDetail =>
  ({ ...selectDefinitionSummary(definition), workflow: definition.source, graph: selectDefinitionGraph(definition.source) });

function graphNode({ key, prefix, path, unit }: DeclaredUnit): DefinitionGraphNode {
  // A string `after` is an expression evaluated per collection member, not a unit key: it has no static edge.
  const after = unit.after == null || typeof unit.after === "string" ? [] : unit.after;
  return { key: path, stage: unit.stage ?? key, depends_on: after.map((dependency) => prefix ? `${prefix}/${dependency}` : dependency) };
}
/** The unit graph a workflow declares, for the catalog. */
export function selectDefinitionGraph(workflow: Workflow | AuthoredWorkflow): DefinitionGraph {
  const nodes = declaredUnits(workflow.run).map(graphNode);
  return { nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.key }))) };
}
