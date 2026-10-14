use super::*;

/// Every write to a snapshot made by event reduction, advancement, or pending
/// worker scheduling. Variants mirror the existing writes in those phases.
#[derive(Clone)]
pub(super) enum Delta {
    PushUnit(UnitState),
    UnitInput { index: usize, input: Value },
    UnitStatus { index: usize, status: UnitStatus },
    PushAttempt(AttemptState),
    ReplaceAttempt { index: usize, attempt: AttemptState },
    PushRevision(RevisionState),
    PushDecision(DecisionState),
    PushRetry(UnitId, WorkerKey, EventId),
    EvaluationBudget(usize),
}

/// The sole writer of `StepSnapshot`.
pub(super) fn apply(state: &mut StepSnapshot, context: &mut EvaluationContext<'_>, delta: Delta) {
    match delta {
        Delta::PushUnit(unit) => state.units.push(unit),
        Delta::UnitInput { index, input } => state.units[index].input = Some(input),
        Delta::UnitStatus { index, status } => state.units[index].status = status,
        Delta::PushAttempt(attempt) => state.attempts.push(attempt),
        Delta::ReplaceAttempt { index, attempt } => state.attempts[index] = attempt,
        Delta::PushRevision(revision) => state.revisions.push(revision),
        Delta::PushDecision(decision) => state.decisions.push(decision),
        Delta::PushRetry(unit, worker, id) => state.retry_events.push(RetryEvent {
            unit,
            worker,
            event: id,
        }),
        Delta::EvaluationBudget(remaining) => context.remaining = remaining,
    }
}

pub(super) fn apply_all(
    state: &mut StepSnapshot,
    context: &mut EvaluationContext<'_>,
    deltas: Vec<Delta>,
) {
    for delta in deltas {
        apply(state, context, delta);
    }
}
