import type { CodeOperation } from "../../oakridge-dbos/src/core-client/core-types";
import type { Prompts, WorkflowDefinitionDescriptor } from "../../kbbl/core/pwa/oakridge/workflow-definition-types";
import type { DefinitionId, OperationRegistryId, PromptId } from "./definition-identity";

/** Mirrors workflow-model::AuthoredWorkflow, without expanding templates. */
export type AuthoredWorkflow = WorkflowDefinitionDescriptor;
export type OperationRegistry = readonly CodeOperation[];
export interface PromptReferences { readonly [authored_path: string]: PromptId }
export interface PromptTexts { readonly [authored_path: string]: string }
export interface LaunchableCatalog { readonly [authoring_name: string]: DefinitionId }

export interface CommittedDefinition {
  readonly source: AuthoredWorkflow;
  readonly operation_registry_id: OperationRegistryId;
  readonly prompts: PromptReferences;
  readonly schema_names: readonly string[];
  readonly stage_names: readonly string[];
}

export interface ResolvedDefinition {
  readonly definition_id: DefinitionId;
  readonly source: AuthoredWorkflow;
  readonly operation_registry_id: OperationRegistryId;
  readonly prompts: PromptTexts;
  readonly operations: OperationRegistry;
  readonly schema_names: readonly string[];
  readonly stage_names: readonly string[];
}

export type DefinitionInputs = Pick<CommittedDefinition, "source" | "operation_registry_id" | "prompts">;

/** Call on the YAML document's toJS() result, before canonicalizing its mappings. */
export function commitDefinition(inputs: DefinitionInputs): CommittedDefinition {
  return {
    ...inputs,
    schema_names: Object.keys(inputs.source.schemas ?? {}),
    stage_names: Object.keys(inputs.source.stages),
  };
}

function promptValues(prompts: Prompts | null | undefined): string[] {
  return Object.values(prompts ?? {}).filter((path): path is string => typeof path === "string");
}

/** Include shared declarations and template overrides, even if presently unused. */
export function referencedPromptPaths(source: AuthoredWorkflow): string[] {
  const shared_workers = Object.values(source.workers ?? {}).flatMap((worker) => worker.kind === "agent" ? promptValues(worker.prompts) : []);
  const shared_reviews = Object.values(source.reviews ?? {}).flatMap((review) => review.prompt == null ? [] : [review.prompt]);
  const stages = Object.values(source.stages).flatMap((stage) => [
    ...Object.values(stage.workers).flatMap((worker) => "template" in worker
      ? promptValues(worker.overrides?.prompts)
      : worker.kind === "agent" ? promptValues(worker.prompts) : []),
    ...Object.values(stage.reviews ?? {}).flatMap((review) => {
      const prompt = "template" in review ? review.overrides?.prompt : review.prompt;
      return prompt == null ? [] : [prompt];
    }),
  ]);
  return [...new Set([...shared_workers, ...shared_reviews, ...stages])].sort();
}
