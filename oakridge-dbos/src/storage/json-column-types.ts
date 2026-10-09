/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into generated-records.ts.
 */
import type { CheckedValue } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { ScopeId } from "./schema-records";

import type { DefinitionBundle } from "../core-client/generated-contracts";

export type { CheckedValue, CompiledBundle, DecisionOutcome } from "../core-client/generated-contracts";
/** Named apart from the generated definition_bundle row. */
export type DefinitionBundleSource = DefinitionBundle;

export interface ChildCollectionMember { readonly id: ScopeId; readonly key: string; readonly depends_on: readonly string[] }
export type ChildCollectionMembers = readonly (string | ChildCollectionMember)[];
export type CommitReceipt =
  | { readonly kind: "committed"; readonly transition_id: string; readonly scope_version: number }
  | { readonly kind: "rejected"; readonly error: string; readonly detail: CheckedValue };
export type EffectIntentPayload = CheckedValue | EffectPayload;
