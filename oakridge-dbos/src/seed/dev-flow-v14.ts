import { parseWorkflowDefinition } from "../validation/workflow-definition";
import type { DefinitionValidationError } from "../validation/workflow-definition";
import type { Result } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/workflow";

/**
 * v14 removes the slot bindings that never took effect.
 *
 * A delegated stage fills its prompt slots from `slot_bindings`, then from
 * `fan_out.item_bindings`, and identity — `UNIT_ID`, `STAGE_INSTANCE_ID` — wins
 * over both. Ten bindings in v13 were shadowed by one of those and so did
 * nothing, while reading as intent to anyone opening the definition.
 *
 * One of them did worse than nothing before the resolver was fixed:
 * `UNIT_ID: {literal "0"}`, left in `build` and `assessor` from when they ran a
 * single unit, overwrote the real unit id in every rendered prompt. Since the
 * emit URL a delegated agent is handed is `units/{{UNIT_ID}}/emit/<output>`,
 * every cohort was told to record its work against a unit that does not exist,
 * and a build agent that pushed a branch and opened a PR got
 * `404 execution unit not found` for it. Identity now wins in
 * `resolveDelegatedExecution`, so the binding was already inert; this stops the
 * definition asserting it.
 *
 * The other nine were `""` literals for cohort fields that the item bindings
 * supply per unit — a default no stage has ever used.
 *
 * A new version rather than an edit to v13: definitions are immutable per name
 * and version, so changing v13's graph in place makes seeding throw on any
 * database that already holds it — and runs still in flight against v13 must
 * keep compiling the graph they were launched with.
 */
const SOURCE = new URL("../../../oakridge-core/examples/dev_flow_v14.json", import.meta.url);

export const loadDevFlowV14 = async (): Promise<Result<WorkflowDefinition, DefinitionValidationError>> => {
  // The IO boundary. A missing or unparseable file is the same kind of answer as
  // an invalid definition — the seed cannot produce one — and the signature
  // already promises a `Result`, so it should not also throw.
  let source: unknown;
  try {
    source = await Bun.file(SOURCE).json();
  } catch (error) {
    return { ok: false, error: { operation: "parse_workflow_definition",
      detail: `built-in dev-flow v14 could not be read from ${SOURCE.pathname}: ${error instanceof Error ? error.message : String(error)}` } };
  }
  return parseWorkflowDefinition(source);
};
