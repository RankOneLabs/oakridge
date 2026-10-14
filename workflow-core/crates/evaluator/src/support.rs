use super::*;
pub(super) fn rejected(reason: impl Into<String>) -> StepError {
    StepError::Rejected {
        reason: reason.into(),
        entity: StepEntity::Run,
    }
}
pub(super) fn invalid(detail: impl Into<String>) -> StepError {
    StepError::Invalid {
        detail: detail.into(),
        entity: StepEntity::Run,
    }
}
/// Attribute an error raised while advancing `unit` to it (D-V4): a
/// refusal there stalls the run at that unit rather than refusing the
/// event for what it is, and an inconsistency names where it was found.
pub(super) fn advancing(unit: &UnitId) -> impl Fn(StepError) -> StepError + '_ {
    move |error| match error {
        StepError::Rejected { reason, .. } => StepError::Stalled {
            unit: unit.clone(),
            reason,
        },
        StepError::Invalid {
            detail,
            entity: StepEntity::Run,
        } => StepError::Invalid {
            detail,
            entity: StepEntity::Unit { unit: unit.clone() },
        },
        attributed => attributed,
    }
}

pub(super) fn event_entity(snapshot: &StepSnapshot, incoming: &Incoming) -> StepEntity {
    match &incoming.event {
        Event::Launched { .. } | Event::CancelRequested => StepEntity::Run,
        Event::WorkerStarted { action, .. } | Event::WorkerEnded { action, .. } => snapshot
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.action_id == *action)
            .map(|attempt| StepEntity::Worker {
                unit: attempt.unit.clone(),
                worker: attempt.worker.clone(),
            })
            .unwrap_or_else(|| StepEntity::Action {
                action: action.clone(),
            }),
        Event::RevisionPublished { unit, artifact, .. } => StepEntity::Artifact {
            unit: unit.clone(),
            artifact: artifact.clone(),
        },
        Event::OperatorDecided { unit, .. } => StepEntity::Unit { unit: unit.clone() },
        Event::RetryRequested { unit, worker } => StepEntity::Worker {
            unit: unit.clone(),
            worker: worker.clone(),
        },
    }
}

pub(super) fn attribute_event(
    error: StepError,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
) -> StepError {
    let entity = event_entity(snapshot, incoming);
    match error {
        StepError::Rejected {
            reason,
            entity: StepEntity::Run,
        } => StepError::Rejected { reason, entity },
        StepError::Invalid {
            detail,
            entity: StepEntity::Run,
        } => StepError::Invalid { detail, entity },
        other => other,
    }
}
pub struct EvaluationContext<'a> {
    pub(super) limits: &'a ResourceLimits,
    remaining: usize,
    error: Option<EvalError>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EvalError {
    BudgetExceeded,
    ListLimitExceeded,
    ValueLimit(String),
}

impl From<EvalError> for StepError {
    fn from(error: EvalError) -> Self {
        let reason = match error {
            EvalError::BudgetExceeded => "evaluation_budget exceeded".to_owned(),
            EvalError::ListLimitExceeded => "max_list_items exceeded".to_owned(),
            EvalError::ValueLimit(reason) => reason,
        };
        rejected(reason)
    }
}

impl<'a> EvaluationContext<'a> {
    pub fn new(limits: &'a ResourceLimits) -> Self {
        Self {
            limits,
            remaining: limits.evaluation_budget,
            error: None,
        }
    }
    pub(super) fn charge(&mut self) -> bool {
        if self.remaining == 0 {
            self.error.get_or_insert(EvalError::BudgetExceeded);
            false
        } else {
            self.remaining -= 1;
            true
        }
    }
    pub(super) fn check_value(&self, value: &Value) -> Result<(), EvalError> {
        self.limits
            .check_value(value)
            .map_err(|reason| EvalError::ValueLimit(reason.to_owned()))
    }
    pub(super) fn check_list_len(&mut self, len: usize) -> bool {
        if len > self.limits.max_list_items {
            self.error = Some(EvalError::ListLimitExceeded);
            false
        } else {
            true
        }
    }
    pub(super) fn take_error(&mut self) -> Option<EvalError> {
        self.error.take()
    }
}
pub fn latest<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifact: &SymbolKey,
) -> Option<&'a RevisionState> {
    state
        .revisions
        .iter()
        .rev()
        .find(|r| r.unit == *unit && r.artifact == *artifact)
}
pub(super) fn checked_stage<'a>(
    program: &'a CheckedWorkflow,
    unit: &UnitState,
) -> Result<&'a CheckedStage, StepError> {
    let key = unit
        .stage
        .as_ref()
        .ok_or_else(|| invalid("unit is a group"))?;
    program
        .stages
        .iter()
        .find(|stage| stage.key == *key)
        .ok_or_else(|| invalid(format!("checked stage {key} absent")))
}
pub(super) fn worker<'a>(
    stage: &'a CheckedStage,
    key: &WorkerKey,
) -> Result<&'a CheckedWorker, StepError> {
    stage
        .workers
        .iter()
        .find(|worker| worker.key() == key)
        .ok_or_else(|| rejected(format!("worker {key} absent")))
}
pub(super) fn attempt<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
) -> Option<&'a AttemptState> {
    state
        .attempts
        .iter()
        .rev()
        .find(|a| a.unit == *unit && a.worker == *worker)
}
/// Revision and decision ids are prefixed with their unit, which is already
/// run-scoped, so they are unique across units and runs. A unit's snapshot
/// always carries all of that unit's revisions and decisions.
pub(super) fn revision_id(state: &StepSnapshot, unit: &UnitId, artifact: &SymbolKey) -> RevisionId {
    let seq = state
        .revisions
        .iter()
        .filter(|revision| revision.unit == *unit && revision.artifact == *artifact)
        .count()
        + 1;
    RevisionId(format!("{}:{}:{seq}", unit.0, artifact.0))
}
pub(super) fn decision_id(state: &StepSnapshot, unit: &UnitId) -> DecisionId {
    let seq = state
        .decisions
        .iter()
        .filter(|decision| decision.unit == *unit)
        .count()
        + 1;
    DecisionId(format!("{}:d{seq}", unit.0))
}
pub(super) fn latest_retry<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
) -> Option<&'a EventId> {
    state
        .retry_events
        .iter()
        .rev()
        .find(|(u, w, _)| u == unit && w == worker)
        .map(|(_, _, id)| id)
}
/// A retry authorizes exactly one attempt: once any attempt of the worker
/// carries it, it is spent.
pub(super) fn is_retry_spent(
    state: &StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
    retry: &EventId,
) -> bool {
    state.attempts.iter().any(|attempt| {
        attempt.unit == *unit
            && attempt.worker == *worker
            && matches!(&attempt.cause, Cause::Retry { event } if event == retry)
    })
}
/// The first 16 bytes of a value's SHA-256 over its wire JSON (object
/// keys sorted), as 32 hex characters: bounded however large the value.
pub(super) fn json_digest(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.to_string().as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
/// The digest a periodic watch is pinned to: its resolved inputs.
pub(super) fn inputs_digest(inputs: &Value) -> String {
    json_digest(inputs)
}
/// Which watch a periodic worker wants (D-V1). Its latest watch while that
/// one is pinned to these inputs; otherwise a new one replacing the
/// worker's latest action, which may be an earlier watch or a retry.
pub(super) fn periodic_cause(
    state: &StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
    inputs: String,
) -> Cause {
    let Some(previous) = attempt(state, unit, worker) else {
        return Cause::Periodic {
            inputs,
            replaces: None,
        };
    };
    match &previous.cause {
        Cause::Periodic { inputs: pinned, .. } if *pinned == inputs => previous.cause.clone(),
        _ => Cause::Periodic {
            inputs,
            replaces: Some(previous.action_id.clone()),
        },
    }
}
/// Whether a worker that creates `artifact` has an attempt open, so its
/// latest revision may yet be followed by the rest of that attempt's output.
pub(super) fn is_creator_working(
    definition: &CheckedStage,
    state: &StepSnapshot,
    unit: &UnitId,
    artifact: &SymbolKey,
) -> bool {
    definition
        .workers
        .iter()
        .filter(|worker| worker.creates().contains(artifact))
        .any(|worker| {
            attempt(state, unit, worker.key()).is_some_and(|current| {
                matches!(
                    current.status,
                    AttemptStatus::Pending | AttemptStatus::Running
                )
            })
        })
}
/// Whether an expression reads an artifact of its unit: `latest`,
/// `published`, `approved` or `changes_requested` of it.
pub(super) fn unobserved_watch_artifacts(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<SymbolKey>, StepError> {
    let checked = checked_stage(program, unit)?;
    let mut unobserved = Vec::new();
    for checked_worker in &checked.workers {
        if !is_periodic(checked_worker) {
            continue;
        }
        let worker_key = checked_worker.key();
        if !holds(checked_worker.when(), unit, state, context)? {
            continue;
        }
        let Some(inputs) = eval_fields(checked_worker.inputs(), unit, state, None, context)? else {
            continue;
        };
        let digest = inputs_digest(&inputs);
        let is_observed = attempt(state, &unit.id, worker_key).is_some_and(|latest| {
            matches!(&latest.cause, Cause::Periodic { inputs: pinned, .. } if *pinned == digest)
                && state.attempts.iter().any(|candidate| {
                    candidate.action_id == latest.action_id
                        && matches!(candidate.status, AttemptStatus::Succeeded)
                })
        });
        if !is_observed {
            unobserved.extend(checked_worker.creates().iter().cloned());
        }
    }
    Ok(unobserved)
}
/// Whether an expression reads any of the given artifacts.
pub(super) fn reads_any(expression: &Expression, artifacts: &[SymbolKey]) -> bool {
    artifacts
        .iter()
        .any(|artifact| reads_artifact(expression, artifact))
}
pub(super) fn is_periodic(worker: &CheckedWorker) -> bool {
    matches!(worker, CheckedWorker::Code { every: Some(_), .. })
}
pub(super) fn changes_requested<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifacts: &[SymbolKey],
) -> Option<&'a DecisionState> {
    artifacts.iter().find_map(|artifact| {
        let latest = latest(state, unit, artifact)?;
        state.decisions.iter().rev().find(|decision| {
            decision.unit == *unit
                && decision.target == latest.id
                && decision.effect == DecisionEffect::RequestChanges
        })
    })
}
/// The decision a revise attempt answers, with the revision it requested
/// changes on: the one its cause names, or for a retry, which names none,
/// the one `changes_requested` picks as `stage_actions` did.
pub(super) fn answered_decision<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifacts: &[SymbolKey],
    cause: &Cause,
) -> Option<(&'a RevisionState, &'a DecisionState)> {
    let decision = match cause {
        Cause::ChangesRequested { decision } => state
            .decisions
            .iter()
            .find(|candidate| candidate.id == *decision)?,
        _ => changes_requested(state, unit, artifacts)?,
    };
    let revision = state
        .revisions
        .iter()
        .find(|revision| revision.id == decision.target)?;
    Some((revision, decision))
}
pub(super) fn group_for<'a>(
    program: &'a CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
) -> Result<&'a CheckedGroup, StepError> {
    if unit.id == state.run.root {
        return Ok(&program.root);
    }
    let parent_id = unit
        .parent
        .as_ref()
        .ok_or_else(|| invalid("group has no parent"))?;
    let parent = state
        .units
        .iter()
        .find(|u| u.id == *parent_id)
        .ok_or_else(|| invalid("parent absent"))?;
    group_for(program, state, parent)?
        .units
        .iter()
        .find(|candidate| candidate.key.0 == unit.declaration.0)
        .and_then(|candidate| candidate.group.as_deref())
        .ok_or_else(|| invalid("checked group declaration absent"))
}
pub(super) fn checked_unit<'a>(
    group: &'a CheckedGroup,
    declaration: &str,
) -> Result<&'a CheckedUnit, StepError> {
    group
        .units
        .iter()
        .find(|candidate| candidate.key.0 == declaration)
        .ok_or_else(|| invalid(format!("checked unit {declaration} absent")))
}
