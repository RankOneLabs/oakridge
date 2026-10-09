/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into generated-records.ts.
 */
import type { CheckedValue } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { ScopeId } from "./schema-records";

import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { RunEvent } from "../projections/run-event";

export type { CheckedValue, CompiledBundle, DecisionOutcome } from "../core-client/generated-contracts";
/** Named apart from the generated definition_bundle row. */
export type DefinitionBundleSource = DefinitionBundle;

export interface ChildCollectionMember { readonly id: ScopeId; readonly key: string; readonly depends_on: readonly string[] }
export type ChildCollectionMembers = readonly (string | ChildCollectionMember)[];
export interface CommitReceipt { readonly transition_id: string; readonly scope_version: number }
export type EffectIntentPayload = CheckedValue | EffectPayload;
/** The GitHub repository a project's checkout pushes to. */
export interface ForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }
export type SessionPolicy = import("../domain/primitives").JsonValue;
export type AuthoringModel = import("../domain/primitives").JsonValue;
export interface CollaborationTranscriptMessage { readonly author: string; readonly body: string; readonly created_at: string }
export interface CollaborationTranscript { readonly messages: readonly CollaborationTranscriptMessage[] }
export type OperatorEventPayload =
  | { readonly kind: "invalidate"; readonly run_id: string | null; readonly scope_id: string | null }
  | { readonly kind: "run_event"; readonly event: RunEvent };
