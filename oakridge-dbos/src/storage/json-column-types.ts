/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into generated-records.ts.
 */
import type { Action, Event, Workflow } from "../core-client/core-types";

export type { AttemptStatus, Cause, CompiledWorkflow, Mode, UnitStatus, Writer } from "../core-client/core-types";
/** The authoring input and every event body are schema-checked by the Rust core. */
import type { RunEvent } from "../projections/run-event";
import type { RunId } from "../domain/primitives";

export type RuntimeValue = unknown;
export type CoreEvent = Event;
export type DefinitionBundleSource = Workflow;
/** prompt_key -> content_digest, fixed when the definition digest is pinned. */
export type PinnedPrompts = { readonly [prompt_key: string]: string };
export type WantedActions = readonly Action[];
export type { SessionPolicy } from "../domain/session-settings";

export type OperatorEventPayload =
  | { readonly kind: "run_event"; readonly data: RunEvent }
  | { readonly kind: "invalidate"; readonly data: { readonly target: InvalidationTarget; readonly run_id: RunId | null } };
export type InvalidationTarget = "run" | "runs" | "definitions" | "projects";
export interface CollaborationThreadContext { readonly title: string; readonly anchor: string | null }
export interface CollaborationMessageBody { readonly text: string; readonly author: string; readonly ping?: boolean }
export interface ReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }
export type CollaborationDeliveryPayload =
  | { readonly status: "delivered"; readonly session_id: string; readonly reason: null; readonly request_key: string }
  | { readonly status: "failed"; readonly session_id: null; readonly reason: string; readonly request_key: string };

export interface CommitReceipt { readonly event_id: string }
export type EffectIntentPayload = Action;
/** The GitHub repository a project's checkout pushes to. */
export interface ForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }
