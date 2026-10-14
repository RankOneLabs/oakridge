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
        /// The attempt that published it; None only for an operator's edit
        /// (`Writer::Operator`), which no attempt produced.
        by: Option<ActionKey>,
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
    ChangesRequested {
        decision: DecisionId,
    },
    ReviewOf {
        revision: RevisionId,
    },
    Retry {
        event: EventId,
    },
    /// One watch of a periodic worker: every attempt it runs is pinned to the
    /// inputs `inputs` digests. A change of inputs, or a retry that ran, opens
    /// a new watch that `replaces` the worker's previous action, so no two
    /// watches share an id even when their inputs do.
    Periodic {
        inputs: String,
        replaces: Option<ActionKey>,
    },
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
    /// None for an operator's edit.
    pub by: Option<ActionKey>,
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
pub struct StepSnapshot {
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
    pub snapshot: StepSnapshot,
    pub wanted: Vec<crate::protocol::WantedWorker>,
    /// Each operator review awaiting a decision, with its `inputs` evaluated
    /// against the stepped state, so the run layer can render its prompt.
    pub reviews: Vec<ResolvedReview>,
}

/// An operator review a decision is legal on now (part 1 §5.2: the latest
/// revision of its artifact has no decision of this review), and its inputs,
/// an unresolved read as null. `target` is that latest revision, the one the
/// review reviews; each decision carries the revision it decides on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedReview {
    pub unit: UnitId,
    pub review: SymbolKey,
    pub target: RevisionId,
    /// The review's decisions legal now, in key order.
    pub decisions: Vec<ResolvedDecision>,
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
    pub inputs: Value,
}

/// One decision of an awaiting review and the revision an `OperatorDecided`
/// of it must name: the latest of its `on` artifact, else of the review's
/// `of`. Listed only while that revision has no decision of the review.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedDecision {
    pub decision: SymbolKey,
    pub target: RevisionId,
}

/// The inputs of one wanted `RunWorker` (part 1 §2.5). `inputs` holds the
/// worker's declared inputs, an unresolved read (such as `latest` of an
/// unpublished artifact) as null. The engine inputs are present only for the
/// mode that uses them: `previous` and `feedback` for revise, `subject` for review.
/// `workspace` is the repository a `repository(<expr>)` workspace names; None for `none`.
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
    #[serde(with = "crate::wire_numbers::optional_json")]
    #[schemars(with = "Option<Value>")]
    pub workspace: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepError {
    /// The event itself is refused against the snapshot.
    Rejected { reason: String, entity: StepEntity },
    /// The event was accepted, but advancing the run past it was refused at
    /// `unit` (a group whose members cannot be made, a limit hit while
    /// evaluating it), so the event is refused with it (D-V4).
    Stalled { unit: UnitId, reason: String },
    /// The snapshot is inconsistent with the workflow.
    Invalid { detail: String, entity: StepEntity },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepEntity {
    Run,
    Unit { unit: UnitId },
    Worker { unit: UnitId, worker: WorkerKey },
    Artifact { unit: UnitId, artifact: SymbolKey },
    Action { action: ActionKey },
}

#[cfg(test)]
mod tests {
    use super::Event;

    #[test]
    fn event_contract_has_the_seven_kinds_swept_by_evaluator_invariants() {
        let schema = serde_json::to_value(schemars::schema_for!(Event)).unwrap();
        assert_eq!(schema["oneOf"].as_array().unwrap().len(), 7);
    }
}
