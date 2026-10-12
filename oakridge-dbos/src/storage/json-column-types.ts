/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into generated-records.ts.
 */
import type { Action, Event, Workflow } from "../core-client/core-types";
import type { ScopeId } from "./schema-records";
import type { JsonValue } from "../domain/primitives";

export type { AttemptStatus, Cause, CompiledWorkflow, Mode, UnitStatus, Writer } from "../core-client/core-types";
/** The authoring input and every event body are schema-checked by the Rust core. */
export type RuntimeValue = unknown;
export type CoreEvent = Event;
export type DefinitionBundleSource = Workflow;
export type WantedActions = readonly Action[];
export type { SessionPolicy } from "../domain/session-settings";

/** Source-side metadata alongside the compiled definition bundle. */
export type { WorkflowAuthoring } from "../../../workflow-config/src/authoring";

export interface OperatorEventPayload { readonly kind: string; readonly data: JsonValue }
export interface CollaborationThreadContext { readonly title: string; readonly anchor: string | null }
export interface CollaborationMessageBody { readonly text: string; readonly author: string; readonly ping?: boolean }
export interface ReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }
export type CollaborationDeliveryPayload =
  | { readonly status: "delivered"; readonly session_id: string; readonly reason: null; readonly request_key: string }
  | { readonly status: "failed"; readonly session_id: null; readonly reason: string; readonly request_key: string };

export interface ChildCollectionMember { readonly id: ScopeId; readonly key: string; readonly depends_on: readonly string[] }
export type ChildCollectionMembers = readonly (string | ChildCollectionMember)[];
export interface CommitReceipt { readonly transition_id: string; readonly scope_version: number }
export type EffectIntentPayload = Action;
/** The GitHub repository a project's checkout pushes to. */
export interface ForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }
