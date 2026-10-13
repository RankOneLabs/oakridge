/**
 * TypeScript types of the authority's jsonb columns. The baseline names one of
 * these per column with `COMMENT ON COLUMN ... IS '@type {Name}'`, and
 * scripts/generate-storage-records.ts imports them into db-types.ts.
 */
import type { ColumnType } from "kysely";
import type { Action, Event, Workflow } from "../core-client/core-types";

/**
 * A jsonb value serialized for a write. pg would send an array as a Postgres
 * array and a bare string as text, so every jsonb write goes through
 * `jsonText` (database.ts), and the brand keeps the value's type.
 */
export type JsonText<Value> = string & { readonly __json: Value };
export type JsonColumn<Value> = ColumnType<Value, JsonText<Value>, JsonText<Value>>;
export type NullableJsonColumn<Value> = ColumnType<Value | null, JsonText<Value> | null, JsonText<Value> | null>;

export type { AttemptStatus, Cause, CompiledWorkflow, Mode, UnitStatus, Writer } from "../core-client/core-types";
export type { EffectInstruction } from "../domain/effect-instruction";
export type { SessionPolicy } from "../domain/session-settings";
export type { OperatorEventPayload } from "../projections/operator-event";
/** Run input, unit input, revision bodies and decision payloads are schema-checked by the Rust core. */
export type RuntimeValue = unknown;
export type CoreEvent = Event;
export type DefinitionBundleSource = Workflow;
export type WantedActions = readonly Action[];
/** An operator review awaiting a decision: the revision it decides on, and its prompt rendered with its resolved inputs. */
export interface ReviewPrompt { readonly target: string; readonly prompt: string }
/** Review key -> its awaiting prompt, on the unit. */
export type ReviewPrompts = { readonly [review: string]: ReviewPrompt };
/** Prompt path -> content digest, pinned when the definition is compiled (D9). */
export type PinnedPrompts = { readonly [path: string]: string };
/** What an ingress id resolved to. A rejection is stored so a replay returns it again. */
export type CommitReceipt =
  | { readonly kind: "committed"; readonly event_id: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface CollaborationThreadContext { readonly title: string; readonly anchor: string | null }
export interface CollaborationMessageBody { readonly text: string; readonly author: string; readonly ping?: boolean }
export interface ReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }
export type CollaborationDeliveryPayload =
  | { readonly status: "delivered"; readonly session_id: string; readonly reason: null; readonly request_key: string }
  | { readonly status: "failed"; readonly session_id: null; readonly reason: string; readonly request_key: string };
/** The GitHub repository a project's checkout pushes to. */
export interface ForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }
