import type { StageInspectorModel } from "./stage-inspector";
import type { OperatorPrompts } from "../operator-contracts/core-client/core-types";

export type PromptOwner =
  | { kind: "worker"; key: string; template: string | null }
  | { kind: "review"; key: string; of: string; template: string | null };
export interface PromptRow {
  id: string;
  owner: PromptOwner;
  mode: keyof OperatorPrompts;
  path: string;
  body: string | null;
  digest: string | null;
  /** The prompts this one includes directly, each editable on its own. */
  includes: readonly string[];
  inputs: { name: string; expression: string }[];
  produces: string[];
}
export function selectPromptRows(model: Pick<StageInspectorModel, "workers" | "reviews" | "definition">): PromptRow[] {
  const row = (owner: PromptOwner, mode: keyof OperatorPrompts, path: string, inputs: { readonly [name: string]: string }, produces: string[]): PromptRow => ({
    id: `${owner.kind}:${owner.key}:${mode}`, owner, mode, path,
    body: model.definition.prompts?.[path]?.body ?? null,
    digest: model.definition.prompts?.[path]?.digest ?? null,
    includes: model.definition.prompts?.[path]?.includes ?? [],
    inputs: Object.entries(inputs).map(([name, expression]) => ({ name, expression })), produces,
  });
  return [
    ...model.workers.flatMap(({ key, worker, source }) => worker.kind === "agent"
      ? Object.entries(worker.prompts).flatMap(([mode, path]) => path ? [row({ kind: "worker", key, template: source?.template ?? null }, mode as keyof OperatorPrompts, path, worker.inputs, worker.produces)] : []) : []),
    ...model.reviews.flatMap(({ key, review, source }) => review.prompt ? [row({ kind: "review", key, of: review.of, template: source?.template ?? null }, "review", review.prompt, review.inputs ?? {}, [])] : []),
  ];
}
