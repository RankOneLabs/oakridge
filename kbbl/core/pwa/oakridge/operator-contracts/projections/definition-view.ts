// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorAuthoredWorkflow, OperatorWorkflow } from "../core-client/core-types";
import type { OperatorSchema } from "./schema-view";
import type { OperatorDefinitionId } from "../runtime/definition-store";

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly definition_id: OperatorDefinitionId; readonly bundle: OperatorDefinitionBundle }

export interface OperatorDefinitionDetail extends OperatorDefinitionSummary { readonly workflow: OperatorWorkflow | OperatorAuthoredWorkflow; readonly graph: OperatorDefinitionGraph }

export type OperatorPinnedDefinition = OperatorDefinitionSummary;

export interface OperatorDefinitionBundle {
  readonly key: string;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly OperatorSchema[];
  readonly stages: readonly string[];
  readonly units: readonly OperatorUnitDefinition[];
}

export interface OperatorDefinitionGraph { readonly nodes: readonly OperatorDefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

export interface OperatorUnitDefinition {
  /** Its declaration path (`integration/repository`), as the definition graph keys it; `$root` for the root. Unique in the bundle. */
  readonly key: string;
  readonly stage: string | null;
  readonly label: string;
  readonly input_schema: string;
  readonly artifacts: readonly OperatorArtifactDefinition[];
}

export interface OperatorDefinitionGraphNode { readonly key: string; readonly stage: string; readonly depends_on: readonly string[] }

export interface OperatorArtifactDefinition { readonly key: string; readonly schema: string }
