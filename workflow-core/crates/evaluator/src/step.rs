use super::*;

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
