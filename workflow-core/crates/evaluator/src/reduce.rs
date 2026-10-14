use super::*;
pub(super) fn reduce(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<Delta>, StepError> {
    let mut state = snapshot.clone();
    let mut deltas = Vec::new();
    macro_rules! record {
        ($delta:expr) => {{
            let delta = $delta;
            apply(&mut state, delta.clone());
            deltas.push(delta);
        }};
    }
    match &incoming.event {
        Event::Launched { input } => {
            if state.run.input.is_some() {
                return Ok(deltas);
            }
            context.check_value(input)?;
            if !check_type(&program.input, input) {
                return Err(rejected("launch input fails schema"));
            }
            record!(Delta::RunInput(input.clone()));
            record!(Delta::RunStatus(UnitStatus::Active));
            record!(Delta::PushUnit(UnitState {
                id: state.run.root.clone(),
                parent: None,
                declaration: SymbolKey::from("$root"),
                stage: None,
                status: UnitStatus::Active,
                input: input.clone(),
                after: vec![],
                pool: None,
            }));
            let root = state.run.root.clone();
            for delta in start_group(program, &state, &root, context)? {
                record!(delta);
            }
        }
        Event::WorkerStarted {
            action,
            kbbl_session_id,
        } => {
            let index = state
                .attempts
                .iter()
                .rposition(|a| a.action_id == *action)
                .ok_or_else(|| rejected("action absent"))?;
            let old = state.attempts[index].clone();
            match old.status {
                AttemptStatus::Pending => {
                    record!(Delta::ReplaceAttempt {
                        index,
                        attempt: AttemptState {
                            status: AttemptStatus::Running,
                            kbbl_session_id: kbbl_session_id.clone(),
                            ..old
                        },
                    });
                }
                AttemptStatus::Running => {}
                AttemptStatus::Succeeded if matches!(old.cause, Cause::Periodic { .. }) => {
                    // A watch whose worker has moved on to another action
                    // (new inputs, or a retry) runs no further attempt.
                    if attempt(&state, &old.unit, &old.worker)
                        .is_some_and(|latest| latest.action_id != *action)
                    {
                        return Err(rejected("periodic action is superseded"));
                    }
                    record!(Delta::PushAttempt(AttemptState {
                        seq: old.seq + 1,
                        status: AttemptStatus::Running,
                        kbbl_session_id: kbbl_session_id.clone(),
                        ended_at: None,
                        ..old
                    }));
                }
                _ => {}
            }
        }
        Event::WorkerEnded { action, result } => {
            let index = state
                .attempts
                .iter()
                .rposition(|a| a.action_id == *action)
                .ok_or_else(|| rejected("action absent"))?;
            if matches!(
                state.attempts[index].status,
                AttemptStatus::Succeeded | AttemptStatus::Failed { .. }
            ) {
                return Ok(deltas);
            }
            let attempt = state.attempts[index].clone();
            let unit = state
                .units
                .iter()
                .find(|u| u.id == attempt.unit)
                .ok_or_else(|| invalid("attempt unit absent"))?;
            let definition = worker(checked_stage(program, unit)?, &attempt.worker)?;
            let status = match result {
                WorkerResult::Failed { code, detail } => AttemptStatus::Failed {
                    code: code.clone(),
                    detail: detail.clone(),
                },
                // A periodic worker publishes only a changed value, so an
                // unchanged observation is a success, whatever caused the attempt.
                WorkerResult::Succeeded
                    if !is_periodic(definition)
                        && definition.creates().iter().any(|artifact| {
                            !state.revisions.iter().any(|r| {
                                r.by.as_ref() == Some(&attempt.action_id) && r.artifact == *artifact
                            })
                        }) =>
                {
                    AttemptStatus::Failed {
                        code: "no_output".into(),
                        detail: "worker ended before publishing every artifact".into(),
                    }
                }
                WorkerResult::Succeeded => AttemptStatus::Succeeded,
            };
            record!(Delta::ReplaceAttempt {
                index,
                attempt: AttemptState {
                    status,
                    ended_at: Some(attempt.seq as i64),
                    ..attempt
                },
            });
        }
        Event::RevisionPublished {
            unit,
            artifact,
            body,
            predecessor,
            subject,
            by,
        } => {
            context.check_value(body)?;
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let definition = checked_stage(program, owner)?.clone();
            let artifact_definition = definition
                .artifacts
                .iter()
                .find(|candidate| candidate.key == *artifact)
                .ok_or_else(|| rejected("artifact absent"))?;
            if !check_type(&artifact_definition.schema, body) {
                return Err(rejected("artifact body fails schema"));
            }
            // A revision is its body and what it reviews: the same body about a
            // new subject (a reviewer repeating itself on a new revision) is new.
            let is_unchanged =
                |revision: &RevisionState| revision.body == *body && revision.subject == *subject;
            // An operator's edit (D2) names no attempt; every other
            // revision names the attempt that published it.
            let is_operator = matches!(incoming.writer, Writer::Operator { .. });
            if is_operator != by.is_none() {
                return Err(rejected(if is_operator {
                    "an operator's revision names no attempt"
                } else {
                    "a revision that names no attempt must be the operator's"
                }));
            }
            if latest(&state, unit, artifact)
                .is_some_and(|revision| revision.by == *by && is_unchanged(revision))
            {
                return Ok(deltas);
            }
            let attempt_index = match by {
                None => None,
                Some(by) => Some(
                    state
                        .attempts
                        .iter()
                        .rposition(|a| {
                            a.action_id == *by
                                && a.unit == *unit
                                && matches!(
                                    a.status,
                                    AttemptStatus::Pending | AttemptStatus::Running
                                )
                        })
                        .ok_or_else(|| rejected("publication attempt is not current"))?,
                ),
            };
            let producer = match attempt_index {
                Some(index) => {
                    let producer = worker(&definition, &state.attempts[index].worker)?;
                    if !producer.creates().contains(artifact) {
                        return Err(rejected("worker does not create artifact"));
                    }
                    producer
                }
                None => definition
                    .workers
                    .iter()
                    .find(|candidate| candidate.creates().contains(artifact))
                    .ok_or_else(|| invalid("artifact has no creator"))?,
            };
            let is_code = matches!(producer, CheckedWorker::Code { .. });
            if is_code && by.is_none() {
                return Err(rejected("an operator cannot edit a code worker's artifact"));
            }
            // An unchanged value from a code worker (a periodic observation)
            // or an operator publishes nothing. An agent's attempt that
            // republishes it records a revision: the attempt published it.
            let previous = latest(&state, unit, artifact);
            if previous.is_some_and(is_unchanged) && (is_code || by.is_none()) {
                return Ok(deltas);
            }
            if previous.map(|r| &r.id) != predecessor.as_ref() {
                return Err(rejected("stale predecessor"));
            }
            let mut messages = Vec::new();
            for validation in &artifact_definition.validations {
                if eval_expression(
                    &validation.expression.expression,
                    owner,
                    &state,
                    None,
                    Some((&artifact.0, body)),
                    context,
                )? != Some(Value::Bool(true))
                {
                    messages.push(validation.message.clone());
                }
            }
            if let (false, true, Some(attempt_index)) =
                (messages.is_empty(), is_code, attempt_index)
            {
                let attempt = state.attempts[attempt_index].clone();
                record!(Delta::ReplaceAttempt {
                    index: attempt_index,
                    attempt: AttemptState {
                        status: AttemptStatus::Failed {
                            code: "validation_failed".into(),
                            detail: messages.join("; "),
                        },
                        ended_at: Some(attempt.seq as i64),
                        ..attempt
                    },
                });
                return Ok(deltas);
            }
            let id = revision_id(&state, unit, artifact);
            record!(Delta::PushRevision(RevisionState {
                id: id.clone(),
                unit: unit.clone(),
                artifact: artifact.clone(),
                body: body.clone(),
                predecessor: predecessor.clone(),
                subject: subject.clone(),
                by: by.clone(),
            }));
            if !messages.is_empty() && !is_code {
                let decision = decision_id(&state, unit);
                record!(Delta::PushDecision(DecisionState {
                    id: decision,
                    unit: unit.clone(),
                    review: SymbolKey::from("engine:validator"),
                    decision: SymbolKey::from("request_changes"),
                    effect: DecisionEffect::RequestChanges,
                    target: id,
                    payload: serde_json::json!({"feedback": messages.join("; ")}),
                }));
            }
        }
        Event::OperatorDecided {
            unit,
            review,
            decision,
            target,
            payload,
        } => {
            context.check_value(payload)?;
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let review_definition = checked_stage(program, owner)?
                .reviews
                .iter()
                .find(|candidate| candidate.key() == review)
                .ok_or_else(|| rejected("review absent"))?;
            let (of, when, decisions) = match review_definition {
                CheckedReview::Operator {
                    of,
                    when,
                    decisions,
                    ..
                } => (of, when, decisions),
                CheckedReview::Engine {
                    decision: engine_decision,
                    ..
                } => {
                    if engine_decision.key != *decision {
                        return Err(rejected("decision absent"));
                    }
                    return Err(rejected("the engine decides this review"));
                }
            };
            let decision_definition = decisions
                .get(&decision.0)
                .ok_or_else(|| rejected("decision absent"))?;
            if !holds(when.as_ref(), owner, &state, context)? {
                return Err(rejected("review is not open"));
            }
            if state.decisions.iter().any(|d| {
                d.unit == *unit
                    && d.review == *review
                    && d.decision == *decision
                    && d.target == *target
                    && d.payload == *payload
            }) {
                return Ok(deltas);
            }
            let current = latest(&state, unit, decided_artifact(of, &decision_definition.on))
                .ok_or_else(|| rejected("reviewed artifact unpublished"))?;
            if current.id != *target {
                return Err(rejected("target is not latest revision"));
            }
            if is_decided_by(&state, unit, review, target) {
                return Err(rejected("review already decided on latest revision"));
            }
            if let Some(ty) = &decision_definition.payload {
                if !check_type(ty, payload) {
                    return Err(rejected("decision payload fails schema"));
                }
            }
            if decision_definition.effect == DecisionEffect::RequestChanges
                && payload
                    .get("feedback")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return Err(rejected("request_changes requires feedback"));
            }
            let id = decision_id(&state, unit);
            record!(Delta::PushDecision(DecisionState {
                id,
                unit: unit.clone(),
                review: review.clone(),
                decision: decision.clone(),
                effect: decision_definition.effect.clone(),
                target: target.clone(),
                payload: payload.clone(),
            }));
        }
        Event::RetryRequested { unit, worker } => {
            // Only a replay of a retry already registered is a no-op: the
            // run layer stores every accepted retry request as a retry, so
            // a distinct request either registers one or is rejected.
            if state.retry_events.iter().any(|(u, w, id)| {
                u == unit && w == worker && incoming.ingress_id.as_deref() == Some(&id.0)
            }) {
                return Ok(deltas);
            }
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let previous =
                attempt(&state, unit, worker).ok_or_else(|| rejected("worker has no attempt"))?;
            if !matches!(previous.status, AttemptStatus::Failed { .. }) {
                return Err(rejected("latest attempt has not failed"));
            }
            if latest_retry(&state, unit, worker)
                .is_some_and(|last| !is_retry_spent(&state, unit, worker, last))
            {
                return Err(rejected("a retry is already requested"));
            }
            // The ingress id is the retry's identity in every later
            // snapshot, so a retry without one could not be recognized.
            let id = EventId(
                incoming
                    .ingress_id
                    .clone()
                    .ok_or_else(|| rejected("a retry request needs an ingress id"))?,
            );
            record!(Delta::PushRetry(unit.clone(), worker.clone(), id));
        }
        Event::CancelRequested => {
            // A finished run stays finished; a cancelled one is cancelled once.
            match state.run.status {
                UnitStatus::Done { .. } => return Err(rejected("run is done")),
                UnitStatus::Cancelled => return Ok(deltas),
                _ => {}
            }
            for index in 0..state.units.len() {
                let unit = &state.units[index];
                if !matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled) {
                    record!(Delta::UnitStatus {
                        index,
                        status: UnitStatus::Cancelled
                    });
                }
            }
            record!(Delta::RunStatus(UnitStatus::Cancelled));
        }
    }
    Ok(deltas)
}
