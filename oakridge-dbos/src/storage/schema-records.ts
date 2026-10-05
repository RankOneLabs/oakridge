import type { CheckedProgram, CheckedValue, DecisionOutcome, DefinitionBundle, Materialization } from "../core-client/generated-contracts";

export type Id<Kind extends string> = string & { readonly __id_kind: Kind };
export type RunId = Id<"run">;
export type ScopeId = Id<"scope">;
export type ExecutionId = Id<"execution">;
export type RevisionId = Id<"revision">;
export type PoolId = Id<"pool">;
export type Version = number;
export interface VersionedRecord { readonly id: string; readonly version: Version }
export interface DefinitionBundleRecord extends VersionedRecord { readonly digest: string; readonly source: DefinitionBundle; readonly checked_program: CheckedProgram }
export interface RunRecord extends VersionedRecord { readonly definition_bundle_id: string; readonly created_at: Date }
export interface ScopeInstanceRecord extends VersionedRecord { readonly run_id: RunId; readonly parent_id: ScopeId | null; readonly scope_key: string; readonly child_key: string | null; readonly input: CheckedValue; readonly local_state: CheckedValue; readonly outcome: CheckedValue | null; readonly is_terminal: boolean }
export interface ScopeExportRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly export_key: string; readonly value: CheckedValue }
export interface ChildCollectionRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly collection_key: string; readonly members: readonly string[] }
export interface ExecutionSelectionRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly worker_key: string; readonly execution_id: ExecutionId | null; readonly generation: number }
export interface ExecutionRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly worker_key: string; readonly generation: number; readonly status: string; readonly result: CheckedValue | null }
export interface ArtifactRevisionRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly execution_id: ExecutionId | null; readonly output_key: string; readonly collection_key: string | null; readonly body: CheckedValue; readonly predecessor_id: RevisionId | null }
export interface OutputSlotRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly output_key: string; readonly collection_key: string; readonly current_revision_id: RevisionId | null }
export interface FactRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly fact_key: string; readonly payload: CheckedValue }
export interface TransitionRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly trigger_id: string; readonly decision: DecisionOutcome; readonly created_at: Date }
export interface IngressReceiptRecord extends VersionedRecord { readonly run_id: RunId; readonly scope_id: ScopeId; readonly ingress_id: string; readonly request_digest: string; readonly result: CommitReceipt }
export interface EffectIntentRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly execution_id: ExecutionId | null; readonly effect_key: string; readonly payload: CheckedValue; readonly status: string }
export interface CapacityPoolRecord extends VersionedRecord { readonly id: PoolId; readonly run_id: RunId; readonly pool_key: string; readonly capacity: number }
export interface CapacityReservationRecord extends VersionedRecord { readonly pool_id: PoolId; readonly scope_id: ScopeId; readonly is_active: boolean }
export interface ResourceBindingRecord extends VersionedRecord { readonly scope_id: ScopeId; readonly resource_key: string; readonly observation: CheckedValue | null }
export interface CommitReceipt { readonly transition_id: string; readonly scope_version: number }

// Wire payloads remain the generated Rust contracts; persistence adds identity and version.
export type CompiledBundle = CheckedProgram;
export type MaterializedCollection = Materialization;
