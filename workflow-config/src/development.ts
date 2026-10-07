import type { WorkflowDefinitionDescriptor as DefinitionBundle } from "./source-contracts";
import { defineBundle } from "./builder";
import { developmentSchemas } from "./development/schemas";
import { prompts } from "./development/prompts";
import { operations } from "./development/operations";
import { configureSchemas, configureScope, DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, type RunPolicy } from "./development/policies";
import { development } from "./development/run/scope";
import { repository_preparation } from "./development/stages/repository_preparation/scope";
import { spec_analysis } from "./development/stages/spec_analysis/scope";
import { planning } from "./development/stages/planning/scope";
import { brief_writing } from "./development/stages/brief_writing/scope";
import { implementation } from "./development/stages/implementation/scope";
import { final_integration } from "./development/stages/final_integration/scope";

export interface DevelopmentOptions { readonly independentSiblings: boolean }

/** Compose the existing Rust source contract; expansion stays outside run policy. */
export function buildDevelopmentRun(policy: RunPolicy): DefinitionBundle {
  return structuredClone(defineBundle({
    language_version: 1,
    key: policy.key,
    version: 2,
    root: "development",
    schemas: configureSchemas(developmentSchemas, policy),
    scopes: [
      development,
      repository_preparation,
      spec_analysis,
      planning,
      brief_writing,
      implementation,
      final_integration,
    ].map((scope) => configureScope(scope, policy)),
    prompts,
    operations,
    limits: { max_list_items: 100, max_depth: 64, evaluation_budget: 20000 },
  }));
}

/** Preserve the generator's established entry point. */
export function buildDevelopment(options: DevelopmentOptions): DefinitionBundle {
  return buildDevelopmentRun(options.independentSiblings ? INDEPENDENT_SIBLINGS_POLICY : DEVELOPMENT_POLICY);
}
