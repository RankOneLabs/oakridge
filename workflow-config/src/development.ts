import type { WorkflowDefinitionDescriptor as DefinitionBundle } from "./source-contracts";
import { defineBundle } from "./builder";
import { developmentSchemas } from "./development/schemas";
import { buildPrompts } from "./development/prompts";
import { stageTableFor } from "./development/run/stage-table";
import { recordSchema, field } from "./primitives/schemas";
import { operations } from "./development/operations";
import { configureSchemas, configureScope, DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, type RunPolicy } from "./development/policies";
import { buildDevelopmentScope } from "./development/run/scope";
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
    version: 3,
    root: "development",
    schemas: configureSchemas(policy.stage_layout === "verification"
      ? [...developmentSchemas, recordSchema("run_input_verification", [
        field("spec", "text"), field("repositories", "repository_configs"),
        field("analysis", "session_config"), field("planning", "session_config"),
        field("briefs", "session_config"), field("admission", "admission_flags"), field("final_merge_policy", "final_merge_policy"), field("verification_note", "optional_text")
      ])] : developmentSchemas, policy),
    scopes: [
      buildDevelopmentScope(policy),
      repository_preparation,
      spec_analysis,
      planning,
      brief_writing,
      implementation,
      final_integration,
    ].map((scope) => configureScope(scope, policy)),
    prompts: buildPrompts(stageTableFor(policy)),
    operations,
    limits: { max_list_items: 100, max_depth: 28, evaluation_budget: 20000 },
  }));
}

/** Preserve the generator's established entry point. */
export function buildDevelopment(options: DevelopmentOptions): DefinitionBundle {
  return buildDevelopmentRun(options.independentSiblings ? INDEPENDENT_SIBLINGS_POLICY : DEVELOPMENT_POLICY);
}
