import { readJsonPointer } from "../domain/json-pointer";
import type { JsonValue } from "../domain/primitives";
import type { RunContext } from "../domain/run-context";
import type { StageKey, WorkflowGraph } from "../domain/workflow";
import { slotBindingSchema } from "../validation/slot-binding";

/**
 * What a workflow definition demands of the run context it is launched with.
 *
 * Every `{ from: "context" }` binding in a definition is a static promise that
 * some pointer will resolve at execution time. Nothing checked those promises,
 * so a launch missing one key was accepted, ran until the stage that read it,
 * and failed there — with the run's other stages already started and an
 * operator left to infer the cause from one pointer name. Collecting the
 * promises up front turns that into a refusal at `POST /workflow_runs` naming
 * every unmet one at once.
 */
export interface ContextRequirement {
  /** The JSON pointer the definition will dereference against the context. */
  readonly pointer: string;
  /** The stage that will dereference it — the first one, where several do. */
  readonly stage_key: StageKey;
}

/**
 * The context pointers a binding dereferences, if any.
 *
 * Only two variants read the context, and they read it differently: `context`
 * resolves a value directly, `context_lookup` resolves a *collection* it then
 * searches with a key the fan-out item carries. Both dereference their pointer
 * unconditionally, which is what makes them checkable before the run starts.
 * Which entry a lookup then matches is not knowable at launch — that depends on
 * an item produced by an upstream stage — so the lookup contributes its
 * collection and nothing more.
 */
const contextPointersOf = (binding: JsonValue): readonly string[] => {
  const parsed = slotBindingSchema.safeParse(binding);
  if (!parsed.success) return [];
  if (parsed.data.from === "context") return [parsed.data.path];
  if (parsed.data.from === "context_lookup") return [parsed.data.collection_path];
  return [];
};

/**
 * Walks a stage config for bindings.
 *
 * Structural rather than typed, because a stage config is `JsonValue` here: the
 * shape depends on the stage type, and a delegated session carries bindings in
 * a dozen places — slot bindings, fan-out item bindings, the worktree template,
 * `runtime`/`model`/`effort` — while `provision_repository_refs` carries one
 * under a name of its own. Enumerating those positions per stage type would
 * mean a new stage type silently escaping validation. Recognising a binding by
 * its own schema, wherever it sits, means it cannot.
 */
const walkConfig = (node: JsonValue, collect: (pointer: string) => void): void => {
  if (Array.isArray(node)) {
    for (const entry of node) walkConfig(entry, collect);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const pointers = contextPointersOf(node);
  if (pointers.length > 0) {
    for (const pointer of pointers) collect(pointer);
    // A binding's own fields are pointers and names, never nested bindings.
    return;
  }
  for (const value of Object.values(node)) walkConfig(value, collect);
};

/**
 * Every context pointer a definition will dereference, deduplicated.
 *
 * Deduplicated by pointer, keeping the first stage that needs it: five stages
 * reading `/oakridge_url` is one thing missing from the launch, not five, and a
 * refusal that says so five times reads as five problems.
 */
export const contextRequirementsOf = (graph: WorkflowGraph): readonly ContextRequirement[] => {
  const byPointer = new Map<string, ContextRequirement>();
  for (const [stageKey, stage] of Object.entries(graph.stages)) {
    walkConfig(stage.config, (pointer) => {
      if (!byPointer.has(pointer)) byPointer.set(pointer, { pointer, stage_key: stageKey });
    });
  }
  return [...byPointer.values()];
};

/**
 * The requirements this context does not satisfy.
 *
 * Resolution is `readJsonPointer` — the same function the binding resolver
 * calls — so the two cannot disagree about what "present" means. That matters
 * for a key like `planner_effort`, which the flow legitimately sends as `null`:
 * a truthiness test here would refuse a launch that would have run fine.
 */
export const unsatisfiedContextRequirements = (
  context: RunContext,
  requirements: readonly ContextRequirement[],
): readonly ContextRequirement[] =>
  requirements.filter((requirement) => readJsonPointer(context, requirement.pointer) === undefined);

/** How a refusal reads to the operator who has to fix the launch. */
export const describeUnsatisfiedRequirements = (unsatisfied: readonly ContextRequirement[]): string =>
  unsatisfied.map((requirement) => `${requirement.pointer} (${requirement.stage_key})`).join(", ");
