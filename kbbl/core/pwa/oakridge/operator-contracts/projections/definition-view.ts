// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorAuthoredWorkflow, OperatorCompiledWorkflow, OperatorParsedWorkflow, OperatorWorkflow } from "../core-client/core-types";
import type { OperatorSchema } from "./schema-view";

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly definition_id: string; readonly bundle: OperatorDefinitionBundle }

export interface OperatorDefinitionDetail extends OperatorDefinitionSummary { readonly prompts: OperatorDefinitionPrompts; readonly workflow: OperatorWorkflow | OperatorAuthoredWorkflow; readonly effective_workflow: OperatorParsedWorkflow; readonly graph: OperatorDefinitionGraph; readonly worker_names?: Readonly<Record<string, readonly string[]>>; readonly assessment_embeddings: OperatorCompiledWorkflow["assessments"] }

export interface OperatorPinnedDefinition extends OperatorDefinitionSummary { readonly effective_workflow: OperatorParsedWorkflow }

export interface OperatorDefinitionBundle {
  readonly key: string;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly OperatorSchema[];
  readonly stages: readonly string[];
  readonly units: readonly OperatorUnitDefinition[];
}

export interface OperatorDefinitionPrompts { readonly [prompt_path: string]: OperatorDefinitionPrompt }

export interface OperatorDefinitionGraph { readonly nodes: readonly OperatorDefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

export interface OperatorUnitDefinition {
  /** Its declaration path (`integration/repository`), as the definition graph keys it; `$root` for the root. Unique in the bundle. */
  readonly key: string;
  readonly stage: string | null;
  readonly label: string;
  readonly input_schema: string;
  readonly artifacts: readonly OperatorArtifactDefinition[];
}

export interface OperatorDefinitionPrompt {
  readonly body: string;
  readonly digest: string;
  /** The prompts this one includes directly with `{{> path}}`, each once, in the order the body names them. */
  readonly includes: readonly string[];
}

export interface OperatorDefinitionGraphNode { readonly key: string; readonly stage: string; readonly depends_on: readonly string[] }

export interface OperatorArtifactDefinition { readonly key: string; readonly schema: string }
