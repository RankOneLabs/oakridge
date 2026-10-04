import { createHash } from "node:crypto";
import type { V15WorkerKey, WorkflowDefinition } from "../domain/dev-flow-v15";
import { err, ok, type Result } from "../domain/primitives";
import type { PromptTemplateLoader } from "../runtime/prompt-template";
import { parseV15WorkflowDefinition, type V15DefinitionError, V15_STAGE_KEYS } from "../validation/v15-definition";

import type { V15PromptReference, V15PromptEntry, V15PromptBundle } from "../domain/dev-flow-v15";
export type { V15PromptReference, V15PromptEntry, V15PromptBundle } from "../domain/dev-flow-v15";
export interface CompiledV15WorkflowDefinition {
  readonly definition: WorkflowDefinition;
  readonly prompts: V15PromptBundle;
}
export type CompileV15Error = V15DefinitionError | {
  readonly operation: "compile_v15_definition";
  readonly kind: "prompt_unavailable" | "prompt_totality" | "unbound_placeholder";
  readonly path: string;
  readonly detail: string;
};

interface PromptActionReference { readonly prompt?: string; readonly operation?: string }
interface PromptWorkerReference { readonly action_points: Readonly<Record<string, PromptActionReference>> }

/** References are local to a stage's workers; operation actions have no prompt. */
export const v15PromptReferences = (definition: WorkflowDefinition): readonly V15PromptReference[] => V15_STAGE_KEYS.flatMap((stage_key) =>
  Object.entries(definition.stages[stage_key].cohort.workers as Readonly<Record<string, PromptWorkerReference>>).flatMap(([worker, declaration]) =>
    Object.entries(declaration.action_points).flatMap(([action_point, action]) => action.prompt === undefined ? [] : [{ stage_key, worker: worker as V15WorkerKey, action_point, path: action.prompt }])));

export const compileV15WorkflowDefinition = async (source: unknown, loader: PromptTemplateLoader): Promise<Result<CompiledV15WorkflowDefinition, CompileV15Error>> => {
  const parsed = parseV15WorkflowDefinition(source);
  if (!parsed.ok) return parsed;
  const references = v15PromptReferences(parsed.value);
  if (references.length !== 18 || new Set(references.map((entry) => entry.path)).size !== 18) return err({ operation: "compile_v15_definition", kind: "prompt_totality", path: "stages", detail: "V15 requires eighteen distinct LLM action-point prompts" });
  const entries: V15PromptEntry[] = [];
  for (const reference of references) {
    if (!reference.path.startsWith("workflow-config/prompts/dev-flow/v15/")) return err({ operation: "compile_v15_definition", kind: "prompt_unavailable", path: reference.path, detail: "V15 prompts must belong to the committed v15 prompt directory" });
    // File reads are the IO boundary. Compile/contract failures remain values.
    try {
      const content = await loader.load(reference.path);
      if (content.trim().length === 0) return err({ operation: "compile_v15_definition", kind: "prompt_unavailable", path: reference.path, detail: "Prompt content is empty" });
      const placeholder = content.match(/\{\{[^{}]+\}\}/);
      if (placeholder) return err({ operation: "compile_v15_definition", kind: "unbound_placeholder",
        path: reference.path, detail: `unbound_placeholder: ${placeholder[0]}; action inputs are appended as typed data` });
      entries.push({ ...reference, content });
    } catch (error) {
      return err({ operation: "compile_v15_definition", kind: "prompt_unavailable", path: reference.path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return ok({ definition: parsed.value, prompts: { hash, entries } });
};
