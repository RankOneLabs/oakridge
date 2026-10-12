use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnitStatus {
    NotStarted,
    Active,
    Blocked {
        reason: BlockedReason,
    },
    Done {
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        outcome: Value,
    },
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
    Session {
        session: SessionId,
        attempt: ActionKey,
    },
    Executor {
        attempt: ActionKey,
    },
    Operator {
        subject: OperatorId,
    },
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
    Launched {
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        input: Value,
    },
    WorkerStarted {
        action: ActionKey,
        kbbl_session_id: Option<String>,
    },
    WorkerEnded {
        action: ActionKey,
        result: WorkerResult,
    },
    RevisionPublished {
        unit: UnitId,
        artifact: SymbolKey,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
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
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        payload: Value,
    },
    RetryRequested {
        unit: UnitId,
        worker: WorkerKey,
    },
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
pub enum Mode {
    Initial,
    Revise,
    Review,
}

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
    RunWorker {
        unit: UnitId,
        worker: WorkerKey,
        mode: Mode,
        cause: Cause,
    },
    Start {
        unit: UnitId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        input: Value,
    },
    Complete {
        unit: UnitId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        outcome: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttemptStatus {
    Pending,
    Running,
    Succeeded,
    Failed { code: String, detail: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttemptState {
    pub action_id: ActionKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub seq: u32,
    pub unit: UnitId,
    pub worker: WorkerKey,
    pub mode: Mode,
    pub cause: Cause,
    pub status: AttemptStatus,
    pub kbbl_session_id: Option<String>,
    /// A logical counter, not a clock: step is pure.
    #[serde(with = "crate::wire_numbers::optional_signed")]
    #[schemars(schema_with = "crate::wire_numbers::optional_signed::schema")]
    pub ended_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevisionState {
    pub id: RevisionId,
    pub unit: UnitId,
    pub artifact: SymbolKey,
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
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
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
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
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
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
    #[serde(with = "crate::wire_numbers::optional_json")]
    #[schemars(with = "Option<Value>")]
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
    /// What each wanted `RunWorker` runs with, evaluated against the stepped
    /// state, so the run layer can pin it without evaluating expressions.
    pub resolved: Vec<ResolvedRunWorker>,
}

/// The inputs of one wanted `RunWorker` (part 1 §2.5). `inputs` holds the
/// worker's declared inputs, an unresolved read (such as `latest` of an
/// unpublished artifact) as null. The engine inputs are present only for the
/// mode that uses them: `previous` and `feedback` for revise, `subject` for review.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedRunWorker {
    pub action_id: ActionKey,
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
    pub inputs: Value,
    pub previous: Option<RevisionState>,
    #[serde(with = "crate::wire_numbers::optional_json")]
    #[schemars(with = "Option<Value>")]
    pub feedback: Option<Value>,
    pub subject: Option<RevisionState>,
    /// The repository a `repository(<expr>)` workspace names; None for `none`.
    #[serde(with = "crate::wire_numbers::optional_json")]
    #[schemars(with = "Option<Value>")]
    pub workspace: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepError {
    Rejected { reason: String },
    Invalid { detail: String },
}

#[cfg(test)]
mod v2_shape_tests {
    use super::{Action, Event, ScopedSnapshot, UnitStatus};

    #[test]
    fn unit_and_action_contracts_have_no_failure_or_ask_variants() {
        let unit = serde_json::to_string(&schemars::schema_for!(UnitStatus)).unwrap();
        let action = serde_json::to_string(&schemars::schema_for!(Action)).unwrap();
        let snapshot = serde_json::to_string(&schemars::schema_for!(ScopedSnapshot)).unwrap();
        assert!(!unit.contains("\"failed\""));
        assert!(!action.contains("\"fail\""));
        assert!(!action.contains("\"ask\""));
        assert!(!snapshot.contains("NeedsOperator"));
    }

    #[test]
    fn event_contract_has_the_seven_kinds_swept_by_evaluator_invariants() {
        let schema = serde_json::to_value(schemars::schema_for!(Event)).unwrap();
        assert_eq!(schema["oneOf"].as_array().unwrap().len(), 7);
    }
}
