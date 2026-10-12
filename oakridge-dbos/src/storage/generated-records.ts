// Generated from src/storage/migrations/0001_core.sql. Run bun oakridge-dbos/scripts/generate-storage-records.ts.
// jsonb column types come from each column's @type comment, resolved in json-column-types.ts.

/* tslint:disable */
/* eslint-disable */

import { RuntimeValue, Mode, Cause, AttemptStatus, CollaborationDeliveryPayload, CollaborationMessageBody, CollaborationThreadContext, DefinitionBundleSource, CompiledWorkflow, EffectIntentPayload, CoreEvent, Writer, CommitReceipt, ForgeRepository, SessionPolicy, ReviewItemBody, UnitStatus, WantedActions } from "./json-column-types";


export type Json = unknown;
export type effect_status = 'acknowledged' | 'failed' | 'pending' | 'stop_requested' | 'stopped';

// Table artifact_revision
export interface ArtifactRevision {
  id: string;
  run_id: string;
  unit_id: string;
  artifact: string;
  /** @type {RuntimeValue} */
  body: RuntimeValue;
  by_id: string;
  predecessor_id: string | null;
  subject: string | null;
  created_at: Date;
}
export interface ArtifactRevisionInput {
  id: string;
  run_id: string;
  unit_id: string;
  artifact: string;
  /** @type {RuntimeValue} */
  body: RuntimeValue;
  by_id: string;
  predecessor_id?: string | null;
  subject?: string | null;
  created_at?: Date;
}
const artifact_revision = {
  tableName: 'artifact_revision',
  columns: ['id', 'run_id', 'unit_id', 'artifact', 'body', 'by_id', 'predecessor_id', 'subject', 'created_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'artifact', 'body', 'by_id'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ArtifactRevision,
  $input: null as unknown as ArtifactRevisionInput
} as const;

// Table attempt
export interface Attempt {
  action_id: string;
  seq: number;
  run_id: string;
  unit_id: string;
  worker: string;
  /** @type {Mode} */
  mode: Mode;
  /** @type {Cause} */
  cause: Cause;
  /** @type {AttemptStatus} */
  status: AttemptStatus;
  ended_at: number | null;
  kbbl_session_id: string | null;
  publication_secret_hash: string | null;
}
export interface AttemptInput {
  action_id: string;
  seq: number;
  run_id: string;
  unit_id: string;
  worker: string;
  /** @type {Mode} */
  mode: Mode;
  /** @type {Cause} */
  cause: Cause;
  /** @type {AttemptStatus} */
  status: AttemptStatus;
  ended_at?: number | null;
  kbbl_session_id?: string | null;
  publication_secret_hash?: string | null;
}
const attempt = {
  tableName: 'attempt',
  columns: ['action_id', 'seq', 'run_id', 'unit_id', 'worker', 'mode', 'cause', 'status', 'ended_at', 'kbbl_session_id', 'publication_secret_hash'],
  requiredForInsert: ['action_id', 'seq', 'run_id', 'unit_id', 'worker', 'mode', 'cause', 'status'],
  primaryKey: 'action_id',
  foreignKeys: {},
  $type: null as unknown as Attempt,
  $input: null as unknown as AttemptInput
} as const;

// Table capacity_pool
export interface CapacityPool {
  id: string;
  run_id: string;
  pool_key: string;
  capacity: number;
}
export interface CapacityPoolInput {
  id: string;
  run_id: string;
  pool_key: string;
  capacity: number;
}
const capacity_pool = {
  tableName: 'capacity_pool',
  columns: ['id', 'run_id', 'pool_key', 'capacity'],
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
  unit_id: string;
  is_active: boolean;
}
export interface CapacityReservationInput {
  id: string;
  run_id: string;
  pool_id: string;
  unit_id: string;
  is_active?: boolean;
}
const capacity_reservation = {
  tableName: 'capacity_reservation',
  columns: ['id', 'run_id', 'pool_id', 'unit_id', 'is_active'],
  requiredForInsert: ['id', 'run_id', 'pool_id', 'unit_id'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as CapacityReservation,
  $input: null as unknown as CapacityReservationInput
} as const;

// Table collaboration_delivery
export interface CollaborationDelivery {
  id: string;
  run_id: string;
  unit_id: string;
  message_id: string;
  /** @type {CollaborationDeliveryPayload} */
  payload: CollaborationDeliveryPayload;
  created_at: Date;
}
export interface CollaborationDeliveryInput {
  id: string;
  run_id: string;
  unit_id: string;
  message_id: string;
  /** @type {CollaborationDeliveryPayload} */
  payload: CollaborationDeliveryPayload;
  created_at?: Date;
}
const collaboration_delivery = {
  tableName: 'collaboration_delivery',
  columns: ['id', 'run_id', 'unit_id', 'message_id', 'payload', 'created_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'message_id', 'payload'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as CollaborationDelivery,
  $input: null as unknown as CollaborationDeliveryInput
} as const;

// Table collaboration_message
export interface CollaborationMessage {
  id: string;
  run_id: string;
  unit_id: string;
  thread_id: string;
  /** @type {CollaborationMessageBody} */
  body: CollaborationMessageBody;
  created_at: Date;
}
export interface CollaborationMessageInput {
  id: string;
  run_id: string;
  unit_id: string;
  thread_id: string;
  /** @type {CollaborationMessageBody} */
  body: CollaborationMessageBody;
  created_at?: Date;
}
const collaboration_message = {
  tableName: 'collaboration_message',
  columns: ['id', 'run_id', 'unit_id', 'thread_id', 'body', 'created_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'thread_id', 'body'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as CollaborationMessage,
  $input: null as unknown as CollaborationMessageInput
} as const;

// Table collaboration_thread
export interface CollaborationThread {
  id: string;
  run_id: string;
  unit_id: string;
  artifact_revision_id: string | null;
  /** @type {CollaborationThreadContext} */
  context: CollaborationThreadContext;
  created_at: Date;
}
export interface CollaborationThreadInput {
  id: string;
  run_id: string;
  unit_id: string;
  artifact_revision_id?: string | null;
  /** @type {CollaborationThreadContext} */
  context: CollaborationThreadContext;
  created_at?: Date;
}
const collaboration_thread = {
  tableName: 'collaboration_thread',
  columns: ['id', 'run_id', 'unit_id', 'artifact_revision_id', 'context', 'created_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'context'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as CollaborationThread,
  $input: null as unknown as CollaborationThreadInput
} as const;

// Table definition_bundle
export interface DefinitionBundle {
  id: string;
  digest: string;
  /** @type {DefinitionBundleSource} */
  source: DefinitionBundleSource;
  /** @type {CompiledWorkflow} */
  checked_program: CompiledWorkflow;
  version: number;
  created_at: Date;
  archived_at: Date | null;
}
export interface DefinitionBundleInput {
  id: string;
  digest: string;
  /** @type {DefinitionBundleSource} */
  source: DefinitionBundleSource;
  /** @type {CompiledWorkflow} */
  checked_program: CompiledWorkflow;
  version?: number;
  created_at?: Date;
  archived_at?: Date | null;
}
const definition_bundle = {
  tableName: 'definition_bundle',
  columns: ['id', 'digest', 'source', 'checked_program', 'version', 'created_at', 'archived_at'],
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
  unit_id: string;
  action_id: string;
  seq: number;
  /** @type {EffectIntentPayload} */
  payload: EffectIntentPayload;
  status: effect_status;
  updated_at: Date;
}
export interface EffectIntentInput {
  id: string;
  run_id: string;
  unit_id: string;
  action_id: string;
  seq: number;
  /** @type {EffectIntentPayload} */
  payload: EffectIntentPayload;
  status?: effect_status;
  updated_at?: Date;
}
const effect_intent = {
  tableName: 'effect_intent',
  columns: ['id', 'run_id', 'unit_id', 'action_id', 'seq', 'payload', 'status', 'updated_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'action_id', 'seq', 'payload'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as EffectIntent,
  $input: null as unknown as EffectIntentInput
} as const;

// Table event
export interface Event {
  id: string;
  run_id: string;
  unit_id: string | null;
  ingress_id: string | null;
  /** @type {CoreEvent} */
  payload: CoreEvent;
  /** @type {Writer} */
  writer: Writer;
  created_at: Date;
  commit_txid: number;
}
export interface EventInput {
  id: string;
  run_id: string;
  unit_id?: string | null;
  ingress_id?: string | null;
  /** @type {CoreEvent} */
  payload: CoreEvent;
  /** @type {Writer} */
  writer: Writer;
  created_at?: Date;
  commit_txid?: number;
}
const event = {
  tableName: 'event',
  columns: ['id', 'run_id', 'unit_id', 'ingress_id', 'payload', 'writer', 'created_at', 'commit_txid'],
  requiredForInsert: ['id', 'run_id', 'payload', 'writer'],
  primaryKey: 'id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as Event,
  $input: null as unknown as EventInput
} as const;

// Table ingress_receipt
export interface IngressReceipt {
  id: string;
  run_id: string;
  unit_id: string | null;
  ingress_id: string;
  request_digest: string;
  /** @type {CommitReceipt} */
  result: CommitReceipt;
}
export interface IngressReceiptInput {
  id: string;
  run_id: string;
  unit_id?: string | null;
  ingress_id: string;
  request_digest: string;
  /** @type {CommitReceipt} */
  result: CommitReceipt;
}
const ingress_receipt = {
  tableName: 'ingress_receipt',
  columns: ['id', 'run_id', 'unit_id', 'ingress_id', 'request_digest', 'result'],
  requiredForInsert: ['id', 'run_id', 'ingress_id', 'request_digest', 'result'],
  primaryKey: 'id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as IngressReceipt,
  $input: null as unknown as IngressReceiptInput
} as const;

// Table project
export interface Project {
  id: string;
  name: string;
  repo_dir: string;
  /** @type {ForgeRepository} */
  forge_repository: ForgeRepository | null;
  integration_branch: string | null;
  /** @type {SessionPolicy} */
  session_policy: SessionPolicy | null;
  created_at: Date;
}
export interface ProjectInput {
  id: string;
  name: string;
  repo_dir: string;
  /** @type {ForgeRepository} */
  forge_repository?: ForgeRepository | null;
  integration_branch?: string | null;
  /** @type {SessionPolicy} */
  session_policy?: SessionPolicy | null;
  created_at?: Date;
}
const project = {
  tableName: 'project',
  columns: ['id', 'name', 'repo_dir', 'forge_repository', 'integration_branch', 'session_policy', 'created_at'],
  requiredForInsert: ['id', 'name', 'repo_dir'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as Project,
  $input: null as unknown as ProjectInput
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

// Table review_decision
export interface ReviewDecision {
  id: string;
  run_id: string;
  unit_id: string;
  review: string;
  decision: string;
  effect: string;
  target_revision_id: string;
  /** @type {RuntimeValue} */
  payload: RuntimeValue;
}
export interface ReviewDecisionInput {
  id: string;
  run_id: string;
  unit_id: string;
  review: string;
  decision: string;
  effect: string;
  target_revision_id: string;
  /** @type {RuntimeValue} */
  payload: RuntimeValue;
}
const review_decision = {
  tableName: 'review_decision',
  columns: ['id', 'run_id', 'unit_id', 'review', 'decision', 'effect', 'target_revision_id', 'payload'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'review', 'decision', 'effect', 'target_revision_id', 'payload'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ReviewDecision,
  $input: null as unknown as ReviewDecisionInput
} as const;

// Table review_item
export interface ReviewItem {
  id: string;
  run_id: string;
  unit_id: string;
  artifact_revision_id: string | null;
  thread_id: string | null;
  /** @type {ReviewItemBody} */
  body: ReviewItemBody;
  created_at: Date;
}
export interface ReviewItemInput {
  id: string;
  run_id: string;
  unit_id: string;
  artifact_revision_id?: string | null;
  thread_id?: string | null;
  /** @type {ReviewItemBody} */
  body: ReviewItemBody;
  created_at?: Date;
}
const review_item = {
  tableName: 'review_item',
  columns: ['id', 'run_id', 'unit_id', 'artifact_revision_id', 'thread_id', 'body', 'created_at'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'body'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as ReviewItem,
  $input: null as unknown as ReviewItemInput
} as const;

// Table run
export interface Run {
  id: string;
  definition_bundle_id: string;
  project_id: string | null;
  root_unit_id: string | null;
  /** @type {RuntimeValue} */
  input: RuntimeValue | null;
  /** @type {UnitStatus} */
  status: UnitStatus;
  created_at: Date;
  version: number;
  archived_at: Date | null;
}
export interface RunInput {
  id: string;
  definition_bundle_id: string;
  project_id?: string | null;
  root_unit_id?: string | null;
  /** @type {RuntimeValue} */
  input?: RuntimeValue | null;
  /** @type {UnitStatus} */
  status?: UnitStatus;
  created_at?: Date;
  version?: number;
  archived_at?: Date | null;
}
const run = {
  tableName: 'run',
  columns: ['id', 'definition_bundle_id', 'project_id', 'root_unit_id', 'input', 'status', 'created_at', 'version', 'archived_at'],
  requiredForInsert: ['id', 'definition_bundle_id'],
  primaryKey: 'id',
  foreignKeys: {
    definition_bundle_id: { table: 'definition_bundle', column: 'id', $type: null as unknown as DefinitionBundle },
    project_id: { table: 'project', column: 'id', $type: null as unknown as Project },
  },
  $type: null as unknown as Run,
  $input: null as unknown as RunInput
} as const;

// Table unit
export interface Unit {
  id: string;
  run_id: string;
  parent_id: string | null;
  unit_key: string;
  collection_key: string | null;
  declaration: string;
  stage: string | null;
  pool: string | null;
  /** @type {RuntimeValue} */
  input: RuntimeValue;
  /** @type {UnitStatus} */
  status: UnitStatus;
  version: number;
}
export interface UnitInput {
  id: string;
  run_id: string;
  parent_id?: string | null;
  unit_key: string;
  collection_key?: string | null;
  declaration: string;
  stage?: string | null;
  pool?: string | null;
  /** @type {RuntimeValue} */
  input: RuntimeValue;
  /** @type {UnitStatus} */
  status: UnitStatus;
  version?: number;
}
const unit = {
  tableName: 'unit',
  columns: ['id', 'run_id', 'parent_id', 'unit_key', 'collection_key', 'declaration', 'stage', 'pool', 'input', 'status', 'version'],
  requiredForInsert: ['id', 'run_id', 'unit_key', 'declaration', 'input', 'status'],
  primaryKey: 'run_id',
  foreignKeys: { run_id: { table: 'run', column: 'id', $type: null as unknown as Run }, },
  $type: null as unknown as Unit,
  $input: null as unknown as UnitInput
} as const;

// Table unit_dependency
export interface UnitDependency {
  run_id: string;
  unit_id: string;
  depends_on_id: string;
}
export interface UnitDependencyInput {
  run_id: string;
  unit_id: string;
  depends_on_id: string;
}
const unit_dependency = {
  tableName: 'unit_dependency',
  columns: ['run_id', 'unit_id', 'depends_on_id'],
  requiredForInsert: ['run_id', 'unit_id', 'depends_on_id'],
  primaryKey: 'run_id',
  foreignKeys: {},
  $type: null as unknown as UnitDependency,
  $input: null as unknown as UnitDependencyInput
} as const;

// Table wanted_log
export interface WantedLog {
  id: string;
  run_id: string;
  unit_id: string;
  event_id: string;
  /** @type {WantedActions} */
  actions: WantedActions;
}
export interface WantedLogInput {
  id: string;
  run_id: string;
  unit_id: string;
  event_id: string;
  /** @type {WantedActions} */
  actions: WantedActions;
}
const wanted_log = {
  tableName: 'wanted_log',
  columns: ['id', 'run_id', 'unit_id', 'event_id', 'actions'],
  requiredForInsert: ['id', 'run_id', 'unit_id', 'event_id', 'actions'],
  primaryKey: 'id',
  foreignKeys: {},
  $type: null as unknown as WantedLog,
  $input: null as unknown as WantedLogInput
} as const;


export interface TableTypes {
  artifact_revision: {
    select: ArtifactRevision;
    input: ArtifactRevisionInput;
  };
  attempt: {
    select: Attempt;
    input: AttemptInput;
  };
  capacity_pool: {
    select: CapacityPool;
    input: CapacityPoolInput;
  };
  capacity_reservation: {
    select: CapacityReservation;
    input: CapacityReservationInput;
  };
  collaboration_delivery: {
    select: CollaborationDelivery;
    input: CollaborationDeliveryInput;
  };
  collaboration_message: {
    select: CollaborationMessage;
    input: CollaborationMessageInput;
  };
  collaboration_thread: {
    select: CollaborationThread;
    input: CollaborationThreadInput;
  };
  definition_bundle: {
    select: DefinitionBundle;
    input: DefinitionBundleInput;
  };
  effect_intent: {
    select: EffectIntent;
    input: EffectIntentInput;
  };
  event: {
    select: Event;
    input: EventInput;
  };
  ingress_receipt: {
    select: IngressReceipt;
    input: IngressReceiptInput;
  };
  project: {
    select: Project;
    input: ProjectInput;
  };
  prompt_content: {
    select: PromptContent;
    input: PromptContentInput;
  };
  review_decision: {
    select: ReviewDecision;
    input: ReviewDecisionInput;
  };
  review_item: {
    select: ReviewItem;
    input: ReviewItemInput;
  };
  run: {
    select: Run;
    input: RunInput;
  };
  unit: {
    select: Unit;
    input: UnitInput;
  };
  unit_dependency: {
    select: UnitDependency;
    input: UnitDependencyInput;
  };
  wanted_log: {
    select: WantedLog;
    input: WantedLogInput;
  };
}

export const tables = {
  artifact_revision,
  attempt,
  capacity_pool,
  capacity_reservation,
  collaboration_delivery,
  collaboration_message,
  collaboration_thread,
  definition_bundle,
  effect_intent,
  event,
  ingress_receipt,
  project,
  prompt_content,
  review_decision,
  review_item,
  run,
  unit,
  unit_dependency,
  wanted_log,
}
