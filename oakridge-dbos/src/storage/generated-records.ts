// Generated from src/storage/migrations/0001_core_authority.sql. Run bun oakridge-dbos/scripts/generate-storage-records.ts.
// jsonb column types come from each column's @type comment, resolved in json-column-types.ts.

/* tslint:disable */
/* eslint-disable */

import { CheckedValue, ChildCollectionMembers, DefinitionBundleSource, CompiledBundle, EffectIntentPayload, CommitReceipt, DecisionOutcome } from "./json-column-types";


export type Json = unknown;
export type effect_status = 'acknowledged' | 'cleanup_confirmed' | 'cleanup_pending' | 'pending' | 'rejected' | 'revoked';
export type execution_status = 'pending' | 'terminal';

// Table artifact_revision
export interface ArtifactRevision {
  id: string;
  run_id: string;
  scope_id: string;
  execution_id: string | null;
  output_key: string;
  collection_key: string;
  /** @type {CheckedValue} */
  body: CheckedValue;
  predecessor_id: string | null;
  version: number;
}
export interface ArtifactRevisionInput {
  id: string;
  run_id: string;
  scope_id: string;
  execution_id?: string | null;
  output_key: string;
  collection_key?: string;
  /** @type {CheckedValue} */
  body: CheckedValue;
  predecessor_id?: string | null;
  version?: number;
}
const artifact_revision = {
  tableName: 'artifact_revision',
  columns: ['id', 'run_id', 'scope_id', 'execution_id', 'output_key', 'collection_key', 'body', 'predecessor_id', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'output_key', 'body'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ArtifactRevision,
  $input: null as unknown as ArtifactRevisionInput
} as const;

// Table capacity_pool
export interface CapacityPool {
  id: string;
  run_id: string;
  pool_key: string;
  capacity: number;
  version: number;
}
export interface CapacityPoolInput {
  id: string;
  run_id: string;
  pool_key: string;
  capacity: number;
  version?: number;
}
const capacity_pool = {
  tableName: 'capacity_pool',
  columns: ['id', 'run_id', 'pool_key', 'capacity', 'version'],
  requiredForInsert: ['id', 'run_id', 'pool_key', 'capacity'],
  primaryKey: 'id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as CapacityPool,
  $input: null as unknown as CapacityPoolInput
} as const;

// Table capacity_reservation
export interface CapacityReservation {
  id: string;
  run_id: string;
  pool_id: string;
  scope_id: string;
  is_active: boolean;
  version: number;
}
export interface CapacityReservationInput {
  id: string;
  run_id: string;
  pool_id: string;
  scope_id: string;
  is_active?: boolean;
  version?: number;
}
const capacity_reservation = {
  tableName: 'capacity_reservation',
  columns: ['id', 'run_id', 'pool_id', 'scope_id', 'is_active', 'version'],
  requiredForInsert: ['id', 'run_id', 'pool_id', 'scope_id'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as CapacityReservation,
  $input: null as unknown as CapacityReservationInput
} as const;

// Table child_collection
export interface ChildCollection {
  id: string;
  run_id: string;
  scope_id: string;
  collection_key: string;
  /** @type {ChildCollectionMembers} */
  members: ChildCollectionMembers;
  version: number;
}
export interface ChildCollectionInput {
  id: string;
  run_id: string;
  scope_id: string;
  collection_key: string;
  /** @type {ChildCollectionMembers} */
  members?: ChildCollectionMembers;
  version?: number;
}
const child_collection = {
  tableName: 'child_collection',
  columns: ['id', 'run_id', 'scope_id', 'collection_key', 'members', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'collection_key'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ChildCollection,
  $input: null as unknown as ChildCollectionInput
} as const;

// Table definition_bundle
export interface DefinitionBundle {
  id: string;
  digest: string;
  /** @type {DefinitionBundleSource} */
  source: DefinitionBundleSource;
  /** @type {CompiledBundle} */
  checked_program: CompiledBundle;
  version: number;
}
export interface DefinitionBundleInput {
  id: string;
  digest: string;
  /** @type {DefinitionBundleSource} */
  source: DefinitionBundleSource;
  /** @type {CompiledBundle} */
  checked_program: CompiledBundle;
  version?: number;
}
const definition_bundle = {
  tableName: 'definition_bundle',
  columns: ['id', 'digest', 'source', 'checked_program', 'version'],
  requiredForInsert: ['id', 'digest', 'source', 'checked_program'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as DefinitionBundle,
  $input: null as unknown as DefinitionBundleInput
} as const;

// Table effect_intent
export interface EffectIntent {
  id: string;
  run_id: string;
  scope_id: string;
  execution_id: string | null;
  effect_key: string;
  /** @type {EffectIntentPayload} */
  payload: EffectIntentPayload;
  status: effect_status;
  dispatch_generation: number;
  redispatch_failures: number;
  deadline_epoch_ms: number | null;
  version: number;
}
export interface EffectIntentInput {
  id: string;
  run_id: string;
  scope_id: string;
  execution_id?: string | null;
  effect_key: string;
  /** @type {EffectIntentPayload} */
  payload: EffectIntentPayload;
  status?: effect_status;
  dispatch_generation?: number;
  redispatch_failures?: number;
  deadline_epoch_ms?: number | null;
  version?: number;
}
const effect_intent = {
  tableName: 'effect_intent',
  columns: ['id', 'run_id', 'scope_id', 'execution_id', 'effect_key', 'payload', 'status', 'dispatch_generation', 'redispatch_failures', 'deadline_epoch_ms', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'effect_key', 'payload'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as EffectIntent,
  $input: null as unknown as EffectIntentInput
} as const;

// Table execution
export interface Execution {
  id: string;
  run_id: string;
  scope_id: string;
  worker_key: string;
  generation: number;
  status: execution_status;
  /** @type {CheckedValue} */
  result: CheckedValue | null;
  publication_secret_hash: string | null;
  version: number;
}
export interface ExecutionInput {
  id: string;
  run_id: string;
  scope_id: string;
  worker_key: string;
  generation: number;
  status: execution_status;
  /** @type {CheckedValue} */
  result?: CheckedValue | null;
  publication_secret_hash?: string | null;
  version?: number;
}
const execution = {
  tableName: 'execution',
  columns: ['id', 'run_id', 'scope_id', 'worker_key', 'generation', 'status', 'result', 'publication_secret_hash', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'worker_key', 'generation', 'status'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as Execution,
  $input: null as unknown as ExecutionInput
} as const;

// Table execution_selection
export interface ExecutionSelection {
  id: string;
  run_id: string;
  scope_id: string;
  worker_key: string;
  execution_id: string | null;
  generation: number;
  version: number;
}
export interface ExecutionSelectionInput {
  id: string;
  run_id: string;
  scope_id: string;
  worker_key: string;
  execution_id?: string | null;
  generation?: number;
  version?: number;
}
const execution_selection = {
  tableName: 'execution_selection',
  columns: ['id', 'run_id', 'scope_id', 'worker_key', 'execution_id', 'generation', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'worker_key'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ExecutionSelection,
  $input: null as unknown as ExecutionSelectionInput
} as const;

// Table fact
export interface Fact {
  id: string;
  run_id: string;
  scope_id: string;
  fact_key: string;
  /** @type {CheckedValue} */
  payload: CheckedValue;
}
export interface FactInput {
  id: string;
  run_id: string;
  scope_id: string;
  fact_key: string;
  /** @type {CheckedValue} */
  payload: CheckedValue;
}
const fact = {
  tableName: 'fact',
  columns: ['id', 'run_id', 'scope_id', 'fact_key', 'payload'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'fact_key', 'payload'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as Fact,
  $input: null as unknown as FactInput
} as const;

// Table ingress_receipt
export interface IngressReceipt {
  id: string;
  run_id: string;
  scope_id: string;
  ingress_id: string;
  request_digest: string;
  /** @type {CommitReceipt} */
  result: CommitReceipt;
}
export interface IngressReceiptInput {
  id: string;
  run_id: string;
  scope_id: string;
  ingress_id: string;
  request_digest: string;
  /** @type {CommitReceipt} */
  result: CommitReceipt;
}
const ingress_receipt = {
  tableName: 'ingress_receipt',
  columns: ['id', 'run_id', 'scope_id', 'ingress_id', 'request_digest', 'result'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'ingress_id', 'request_digest', 'result'],
  primaryKey: 'id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as IngressReceipt,
  $input: null as unknown as IngressReceiptInput
} as const;

// Table launch_receipt
export interface LaunchReceipt {
  request_id: string;
  request_digest: string;
  run_id: string | null;
  root_scope_id: string;
  bundle_id: string;
  created_at: Date;
}
export interface LaunchReceiptInput {
  request_id: string;
  request_digest: string;
  run_id?: string | null;
  root_scope_id: string;
  bundle_id: string;
  created_at?: Date;
}
const launch_receipt = {
  tableName: 'launch_receipt',
  columns: ['request_id', 'request_digest', 'run_id', 'root_scope_id', 'bundle_id', 'created_at'],
  requiredForInsert: ['request_id', 'request_digest', 'root_scope_id', 'bundle_id'],
  primaryKey: 'request_id',
  foreignKeys: {
    run_id: { table: 'run', column: 'id', $type: null as unknown as Run },
    bundle_id: { table: 'definition_bundle', column: 'id', $type: null as unknown as DefinitionBundle },
  },
  $type: null as unknown as LaunchReceipt,
  $input: null as unknown as LaunchReceiptInput
} as const;

// Table output_slot
export interface OutputSlot {
  id: string;
  run_id: string;
  scope_id: string;
  output_key: string;
  collection_key: string;
  current_revision_id: string | null;
  version: number;
}
export interface OutputSlotInput {
  id: string;
  run_id: string;
  scope_id: string;
  output_key: string;
  collection_key?: string;
  current_revision_id?: string | null;
  version?: number;
}
const output_slot = {
  tableName: 'output_slot',
  columns: ['id', 'run_id', 'scope_id', 'output_key', 'collection_key', 'current_revision_id', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'output_key'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as OutputSlot,
  $input: null as unknown as OutputSlotInput
} as const;

// Table prompt_content
export interface PromptContent {
  content_digest: string;
  content: string;
}
export interface PromptContentInput {
  content_digest: string;
  content: string;
}
const prompt_content = {
  tableName: 'prompt_content',
  columns: ['content_digest', 'content'],
  requiredForInsert: ['content_digest', 'content'],
  primaryKey: 'content_digest',
  foreignKeys: {},
  $type: null as unknown as PromptContent,
  $input: null as unknown as PromptContentInput
} as const;

// Table resource_binding
export interface ResourceBinding {
  id: string;
  run_id: string;
  scope_id: string;
  resource_key: string;
  /** @type {CheckedValue} */
  observation: CheckedValue | null;
  version: number;
}
export interface ResourceBindingInput {
  id: string;
  run_id: string;
  scope_id: string;
  resource_key: string;
  /** @type {CheckedValue} */
  observation?: CheckedValue | null;
  version?: number;
}
const resource_binding = {
  tableName: 'resource_binding',
  columns: ['id', 'run_id', 'scope_id', 'resource_key', 'observation', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'resource_key'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ResourceBinding,
  $input: null as unknown as ResourceBindingInput
} as const;

// Table run
export interface Run {
  id: string;
  definition_bundle_id: string;
  created_at: Date;
  version: number;
  current_generation: number;
  current_cursor: string | null;
}
export interface RunInput {
  id: string;
  definition_bundle_id: string;
  created_at?: Date;
  version?: number;
  current_generation?: number;
  current_cursor?: string | null;
}
const run = {
  tableName: 'run',
  columns: ['id', 'definition_bundle_id', 'created_at', 'version', 'current_generation', 'current_cursor'],
  requiredForInsert: ['id', 'definition_bundle_id'],
  primaryKey: 'id',
  foreignKeys: { definition_bundle_id: { table: 'definition_bundle', column: 'id', $type: null as unknown as DefinitionBundle }, },
  $type: null as unknown as Run,
  $input: null as unknown as RunInput
} as const;

// Table scope_export
export interface ScopeExport {
  id: string;
  run_id: string;
  scope_id: string;
  export_key: string;
  /** @type {CheckedValue} */
  value: CheckedValue;
  version: number;
}
export interface ScopeExportInput {
  id: string;
  run_id: string;
  scope_id: string;
  export_key: string;
  /** @type {CheckedValue} */
  value: CheckedValue;
  version?: number;
}
const scope_export = {
  tableName: 'scope_export',
  columns: ['id', 'run_id', 'scope_id', 'export_key', 'value', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'export_key', 'value'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ScopeExport,
  $input: null as unknown as ScopeExportInput
} as const;

// Table scope_instance
export interface ScopeInstance {
  id: string;
  run_id: string;
  parent_id: string | null;
  scope_key: string;
  child_key: string | null;
  collection_key: string | null;
  /** @type {CheckedValue} */
  input: CheckedValue;
  /** @type {CheckedValue} */
  local_state: CheckedValue;
  /** @type {CheckedValue} */
  outcome: CheckedValue | null;
  is_terminal: boolean;
  version: number;
}
export interface ScopeInstanceInput {
  id: string;
  run_id: string;
  parent_id?: string | null;
  scope_key: string;
  child_key?: string | null;
  collection_key?: string | null;
  /** @type {CheckedValue} */
  input: CheckedValue;
  /** @type {CheckedValue} */
  local_state: CheckedValue;
  /** @type {CheckedValue} */
  outcome?: CheckedValue | null;
  is_terminal?: boolean;
  version?: number;
}
const scope_instance = {
  tableName: 'scope_instance',
  columns: ['id', 'run_id', 'parent_id', 'scope_key', 'child_key', 'collection_key', 'input', 'local_state', 'outcome', 'is_terminal', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_key', 'input', 'local_state'],
  primaryKey: 'id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as ScopeInstance,
  $input: null as unknown as ScopeInstanceInput
} as const;

// Table transition
export interface Transition {
  id: string;
  run_id: string;
  scope_id: string;
  trigger_id: string;
  /** @type {DecisionOutcome} */
  decision: DecisionOutcome;
  created_at: Date;
  version: number;
}
export interface TransitionInput {
  id: string;
  run_id: string;
  scope_id: string;
  trigger_id: string;
  /** @type {DecisionOutcome} */
  decision: DecisionOutcome;
  created_at?: Date;
  version?: number;
}
const transition = {
  tableName: 'transition',
  columns: ['id', 'run_id', 'scope_id', 'trigger_id', 'decision', 'created_at', 'version'],
  requiredForInsert: ['id', 'run_id', 'scope_id', 'trigger_id', 'decision'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as Transition,
  $input: null as unknown as TransitionInput
} as const;


export interface TableTypes {
  artifact_revision: {
    select: ArtifactRevision;
    input: ArtifactRevisionInput;
  };
  capacity_pool: {
    select: CapacityPool;
    input: CapacityPoolInput;
  };
  capacity_reservation: {
    select: CapacityReservation;
    input: CapacityReservationInput;
  };
  child_collection: {
    select: ChildCollection;
    input: ChildCollectionInput;
  };
  definition_bundle: {
    select: DefinitionBundle;
    input: DefinitionBundleInput;
  };
  effect_intent: {
    select: EffectIntent;
    input: EffectIntentInput;
  };
  execution: {
    select: Execution;
    input: ExecutionInput;
  };
  execution_selection: {
    select: ExecutionSelection;
    input: ExecutionSelectionInput;
  };
  fact: {
    select: Fact;
    input: FactInput;
  };
  ingress_receipt: {
    select: IngressReceipt;
    input: IngressReceiptInput;
  };
  launch_receipt: {
    select: LaunchReceipt;
    input: LaunchReceiptInput;
  };
  output_slot: {
    select: OutputSlot;
    input: OutputSlotInput;
  };
  prompt_content: {
    select: PromptContent;
    input: PromptContentInput;
  };
  resource_binding: {
    select: ResourceBinding;
    input: ResourceBindingInput;
  };
  run: {
    select: Run;
    input: RunInput;
  };
  scope_export: {
    select: ScopeExport;
    input: ScopeExportInput;
  };
  scope_instance: {
    select: ScopeInstance;
    input: ScopeInstanceInput;
  };
  transition: {
    select: Transition;
    input: TransitionInput;
  };
}

export const tables = {
  artifact_revision,
  capacity_pool,
  capacity_reservation,
  child_collection,
  definition_bundle,
  effect_intent,
  execution,
  execution_selection,
  fact,
  ingress_receipt,
  launch_receipt,
  output_slot,
  prompt_content,
  resource_binding,
  run,
  scope_export,
  scope_instance,
  transition,
}
