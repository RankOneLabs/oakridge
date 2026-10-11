use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedValue {
    pub schema: SchemaId,
    pub data: CheckedData,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedData {
    Boolean {
        value: bool,
    },
    Integer {
        #[serde(with = "crate::wire_numbers::signed")]
        #[schemars(schema_with = "crate::wire_numbers::signed::schema")]
        value: i64,
    },
    String {
        value: String,
    },
    Enum {
        variant: String,
    },
    Record {
        fields: Vec<CheckedField>,
        dictionary: Vec<DictionaryEntry>,
    },
    List {
        items: Vec<CheckedValue>,
    },
    Optional {
        value: Option<Box<CheckedValue>>,
    },
    Variant {
        variant: String,
        value: Box<CheckedValue>,
    },
    Reference {
        brand: ReferenceBrand,
        id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedField {
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub field_id: usize,
    pub value: Option<CheckedValue>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DictionaryEntry {
    pub key: String,
    pub value: CheckedValue,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VersionedValue {
    pub identity: String,
    #[serde(with = "crate::wire_numbers::unsigned")]
    #[schemars(schema_with = "crate::wire_numbers::unsigned::schema")]
    pub version: u64,
    pub root: ReferenceRoot,
    pub value: CheckedValue,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub owner: InstanceId,
    pub scope: ScopeKey,
    #[serde(with = "crate::wire_numbers::unsigned")]
    #[schemars(schema_with = "crate::wire_numbers::unsigned::schema")]
    pub version: u64,
    pub input: CheckedValue,
    pub state: CheckedValue,
    pub trigger: Trigger,
    pub observations: Vec<VersionedValue>,
    #[serde(with = "crate::wire_numbers::signed")]
    #[schemars(schema_with = "crate::wire_numbers::signed::schema")]
    pub timestamp_ms: i64,
    #[serde(with = "crate::wire_numbers::unsigned")]
    #[schemars(schema_with = "crate::wire_numbers::unsigned::schema")]
    pub random_seed: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub id: TriggerId,
    pub key: SymbolKey,
    pub payload: CheckedValue,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadVersion {
    pub identity: String,
    #[serde(with = "crate::wire_numbers::unsigned")]
    #[schemars(schema_with = "crate::wire_numbers::unsigned::schema")]
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnitStatus {
    NotStarted,
    Active,
    Blocked { reason: BlockedReason },
    Done { outcome: Value },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlockedReason {
    WaitingOn { units: Vec<UnitId> },
    Capacity { pool: SymbolKey },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Writer {
    Session { session: SessionId, attempt: ActionKey },
    Executor { attempt: ActionKey },
    Operator { subject: OperatorId },
    Engine,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerResult {
    Succeeded,
    Failed { code: String, detail: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Launched { input: Value },
    WorkerStarted { action: ActionKey, kbbl_session_id: Option<String> },
    WorkerEnded { action: ActionKey, result: WorkerResult },
    RevisionPublished {
        unit: UnitId,
        artifact: SymbolKey,
        body: Value,
        predecessor: Option<RevisionId>,
        subject: Option<RevisionId>,
        by: ActionKey,
    },
    OperatorDecided {
        unit: UnitId,
        review: SymbolKey,
        decision: SymbolKey,
        target: RevisionId,
        payload: Value,
    },
    RetryRequested { unit: UnitId, worker: WorkerKey },
    CancelRequested,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Incoming {
    pub event: Event,
    pub writer: Writer,
    pub ingress_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mode { Initial, Revise, Review }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Cause {
    Missing,
    ChangesRequested { decision: DecisionId },
    ReviewOf { revision: RevisionId },
    Retry { event: EventId },
    Periodic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    RunWorker { unit: UnitId, worker: WorkerKey, mode: Mode, cause: Cause },
    Start { unit: UnitId, input: Value },
    Complete { unit: UnitId, outcome: Value },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttemptStatus { Pending, Running, Succeeded, Failed { code: String, detail: String } }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttemptState {
    pub action_id: ActionKey,
    pub seq: u32,
    pub unit: UnitId,
    pub worker: WorkerKey,
    pub mode: Mode,
    pub cause: Cause,
    pub status: AttemptStatus,
    pub kbbl_session_id: Option<String>,
    pub ended_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevisionState {
    pub id: RevisionId,
    pub unit: UnitId,
    pub artifact: SymbolKey,
    pub body: Value,
    pub predecessor: Option<RevisionId>,
    pub subject: Option<RevisionId>,
    pub by: ActionKey,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DecisionState {
    pub id: DecisionId,
    pub unit: UnitId,
    pub review: SymbolKey,
    pub decision: SymbolKey,
    pub effect: DecisionEffect,
    pub target: RevisionId,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnitState {
    pub id: UnitId,
    pub parent: Option<UnitId>,
    pub declaration: SymbolKey,
    pub stage: Option<SymbolKey>,
    pub status: UnitStatus,
    pub input: Value,
    pub after: Vec<UnitId>,
    pub pool: Option<SymbolKey>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunState {
    pub id: String,
    pub root: UnitId,
    pub status: UnitStatus,
    pub input: Option<Value>,
}

/// A unit and its ancestors, plus the descendants and evidence needed to recompute them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScopedSnapshot {
    pub run: RunState,
    pub units: Vec<UnitState>,
    pub attempts: Vec<AttemptState>,
    pub revisions: Vec<RevisionState>,
    pub decisions: Vec<DecisionState>,
    pub retry_events: Vec<(UnitId, WorkerKey, EventId)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StepResult {
    pub snapshot: ScopedSnapshot,
    pub statuses: Vec<(UnitId, UnitStatus)>,
    pub wanted: Vec<(UnitId, Vec<Action>)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepError {
    Rejected { reason: String },
    Invalid { detail: String },
}
