/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into generated-records.ts.
 */
import type { CheckedValue } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { ScopeId } from "./schema-records";
import type { JsonValue } from "../domain/primitives";

import type { DefinitionBundle } from "../core-client/generated-contracts";

export type { CheckedValue, CompiledBundle, DecisionOutcome } from "../core-client/generated-contracts";
/** Named apart from the generated definition_bundle row. */
export type DefinitionBundleSource = DefinitionBundle;
export type { SessionPolicy } from "../domain/session-settings";

/** Source-side metadata alongside the compiled definition bundle. */
export type { WorkflowAuthoring } from "../../../workflow-config/src/authoring";

export interface OperatorEventPayload { readonly kind: string; readonly data: JsonValue }
export interface CollaborationThreadContext { readonly title: string; readonly anchor: string | null }
export interface CollaborationMessageBody { readonly text: string; readonly author: string }
export interface ReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }
export interface CollaborationDeliveryPayload { readonly session_id: string; readonly status: string }

export interface ChildCollectionMember { readonly id: ScopeId; readonly key: string; readonly depends_on: readonly string[] }
export type ChildCollectionMembers = readonly (string | ChildCollectionMember)[];
export interface CommitReceipt { readonly transition_id: string; readonly scope_version: number }
export type EffectIntentPayload = CheckedValue | EffectPayload;
/** The GitHub repository a project's checkout pushes to. */
export interface ForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }
