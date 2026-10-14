use super::*;

/// Every write to a snapshot made by event reduction, advancement, or pending
/// worker scheduling. Variants mirror the existing writes in those phases.
#[derive(Clone)]
pub(super) enum Delta {
    RunInput(Value),
    RunStatus(UnitStatus),
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
        Delta::RunInput(input) => state.run.input = Some(input),
        Delta::RunStatus(status) => state.run.status = status,
        Delta::PushUnit(unit) => state.units.push(unit),
        Delta::UnitInput { index, input } => state.units[index].input = input,
        Delta::UnitStatus { index, status } => state.units[index].status = status,
        Delta::PushAttempt(attempt) => state.attempts.push(attempt),
        Delta::ReplaceAttempt { index, attempt } => state.attempts[index] = attempt,
        Delta::PushRevision(revision) => state.revisions.push(revision),
        Delta::PushDecision(decision) => state.decisions.push(decision),
        Delta::PushRetry(unit, worker, id) => state.retry_events.push((unit, worker, id)),
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
/// Pure reducer and bounded fixpoint that starts and completes units. The snapshot carries
/// the affected unit, its ancestors, and the evidence required by those units.
pub fn step(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
) -> Result<StepResult, StepError> {
    step_with_limits(program, snapshot, incoming, &ResourceLimits::default())
}
pub fn step_with_limits(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
    limits: &ResourceLimits,
) -> Result<StepResult, StepError> {
    let mut context = EvaluationContext::new(limits);
    if let Some(input) = &snapshot.run.input {
        context.check_value(input)?;
    }
    for unit in &snapshot.units {
        context.check_value(&unit.input)?;
        if let UnitStatus::Done { outcome } = &unit.status {
            context.check_value(outcome)?;
        }
    }
    for revision in &snapshot.revisions {
        context.check_value(&revision.body)?;
    }
    for decision in &snapshot.decisions {
        context.check_value(&decision.payload)?;
    }
    let mut state = snapshot.clone();
    let deltas = reduce(
        &State {
            snapshot: &state,
            program,
            context: &context,
        },
        incoming,
    )
    .map_err(|error| attribute_event(error, snapshot, incoming))?;
    apply_all(&mut state, &mut context, deltas);
    match advance_reduced(program, state, &mut context) {
        // A launch that cannot advance never started: it is refused, as a
        // launch whose input fails, not a stall of a run that is going.
        Err(StepError::Stalled { unit, reason })
            if matches!(incoming.event, Event::Launched { .. }) =>
        {
            Err(StepError::Rejected {
                reason,
                entity: StepEntity::Unit { unit },
            })
        }
        other => other,
    }
}
/// Everything after the event is applied: advance to a fixpoint, then
/// resolve what each active stage wants. Nothing here is the event's own
/// fault, so each error is attributed to the unit it was raised on.
pub(super) fn advance_reduced(
    program: &CheckedWorkflow,
    mut state: StepSnapshot,
    context: &mut EvaluationContext<'_>,
) -> Result<StepResult, StepError> {
    if !matches!(state.run.status, UnitStatus::Cancelled) {
        while let Some(deltas) = next_move(program, &state, context)? {
            apply_all(&mut state, context, deltas);
        }
        if let Some(status) = state
            .units
            .iter()
            .find(|u| u.id == state.run.root)
            .map(|root| root.status.clone())
        {
            apply(&mut state, context, Delta::RunStatus(status));
        }
    }
    let mut wanted = Vec::new();
    let mut reviews = Vec::new();
    let mut pending = Vec::new();
    let active: Vec<_> = state
        .units
        .iter()
        .filter(|u| u.stage.is_some() && matches!(u.status, UnitStatus::Active))
        .cloned()
        .collect();
    for unit in active {
        let wants = stage_wants(program, &state, &unit, context).map_err(advancing(&unit.id))?;
        reviews.extend(wants.reviews);
        wanted.extend(wants.workers);
        pending.extend(wants.pending);
    }
    apply_all(&mut state, context, pending);
    Ok(StepResult {
        snapshot: state,
        wanted,
        reviews,
    })
}
