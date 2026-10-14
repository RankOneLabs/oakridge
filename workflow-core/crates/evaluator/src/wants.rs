use super::*;
pub(super) fn reads_artifact(expression: &Expression, artifact: &SymbolKey) -> bool {
    let reads = |inner: &Expression| reads_artifact(inner, artifact);
    match expression {
        Expression::Literal { .. } => false,
        Expression::Reference { root, .. } => matches!(
            root,
            ReferenceRoot::Latest { artifact: read }
                | ReferenceRoot::Published { artifact: read }
                | ReferenceRoot::Approved { artifact: read }
                | ReferenceRoot::ChangesRequested { artifact: read }
                if read == artifact
        ),
        Expression::Record { fields, .. } => fields.iter().any(|field| reads(&field.value)),
        Expression::List { items, .. } | Expression::All { items } | Expression::Any { items } => {
            items.iter().any(reads)
        }
        Expression::Equals { left, right }
        | Expression::GreaterThan { left, right }
        | Expression::GreaterOrEqual { left, right }
        | Expression::LessThan { left, right }
        | Expression::LessOrEqual { left, right } => reads(left) || reads(right),
        Expression::Len { value } | Expression::Not { value } | Expression::Field { value, .. } => {
            reads(value)
        }
        Expression::Map { source, value, .. }
        | Expression::Contains { source, value }
        | Expression::Lookup {
            source, key: value, ..
        }
        | Expression::Filter {
            source,
            predicate: value,
        }
        | Expression::Every {
            source,
            predicate: value,
        } => reads(source) || reads(value),
        Expression::CheckCollection { source, .. } => reads(source),
    }
}
/// The artifacts of a stage's watches that have not observed what they
/// watch now: a watch whose guard holds and whose inputs resolve, but whose
/// worker's latest action is not pinned to those inputs, or has never run
/// successfully. Such an artifact's latest revision is about inputs the watch
/// no longer watches (a pull request since replaced), so the stage is not
/// judged on it until the replacing watch has observed.
pub(super) fn can_run(
    state: &StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
) -> Option<Option<Cause>> {
    let Some(previous) = attempt(state, unit, worker) else {
        return Some(None);
    };
    match previous.status {
        AttemptStatus::Pending | AttemptStatus::Running => None,
        AttemptStatus::Failed { .. } => {
            // A later failure waits for a new retry once the latest is spent.
            let retry = latest_retry(state, unit, worker)?;
            if is_retry_spent(state, unit, worker, retry) {
                None
            } else {
                Some(Some(Cause::Retry {
                    event: retry.clone(),
                }))
            }
        }
        AttemptStatus::Succeeded => Some(None),
    }
}
/// Whether an optional guard holds; no guard always holds, and an
/// unresolved one does not.
pub(super) fn holds(
    guard: Option<&CheckedStageExpression>,
    unit: &UnitState,
    state: &StepSnapshot,
    context: &EvaluationContext<'_>,
) -> Result<bool, StepError> {
    let Some(guard) = guard else {
        return Ok(true);
    };
    Ok(
        eval_expression(&guard.expression, unit, state, None, None, context)?
            == Some(Value::Bool(true)),
    )
}
pub fn stage_actions(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Vec<Action>, StepError> {
    let checked = checked_stage(program, unit)?;
    let mut wanted = Vec::new();
    for checked_worker in &checked.workers {
        let worker_key = checked_worker.key();
        let Some(retry) = can_run(state, &unit.id, worker_key) else {
            continue;
        };
        if !holds(checked_worker.when(), unit, state, context)? {
            continue;
        }
        let candidate = match checked_worker {
            CheckedWorker::Agent {
                creates,
                reviews: Some(subject),
                ..
            } => {
                // The subject's creator may still replace it (a revise
                // publishes the new build before its PR): review only what
                // a finished attempt left.
                if is_creator_working(checked, state, &unit.id, subject) {
                    continue;
                }
                let Some(subject) = latest(state, &unit.id, subject) else {
                    continue;
                };
                let already = creates.iter().all(|artifact| {
                    state.revisions.iter().any(|r| {
                        r.unit == unit.id
                            && r.artifact == *artifact
                            && r.subject.as_ref() == Some(&subject.id)
                    })
                });
                if already {
                    None
                } else {
                    Some((
                        Mode::Review,
                        Cause::ReviewOf {
                            revision: subject.id.clone(),
                        },
                    ))
                }
            }
            CheckedWorker::Agent {
                creates,
                reviews: None,
                ..
            } => {
                if creates
                    .iter()
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    changes_requested(state, &unit.id, creates).map(|decision| {
                        (
                            Mode::Revise,
                            Cause::ChangesRequested {
                                decision: decision.id.clone(),
                            },
                        )
                    })
                }
            }
            // Part 1 §5.2 rule 4: wanted only once its inputs resolve.
            CheckedWorker::Code { every: Some(_), .. } => {
                eval_fields(checked_worker.inputs(), unit, state, None, context)?.map(|inputs| {
                    (
                        Mode::Initial,
                        periodic_cause(state, &unit.id, worker_key, inputs_digest(&inputs)),
                    )
                })
            }
            CheckedWorker::Code {
                creates,
                every: None,
                ..
            } => {
                if creates
                    .iter()
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    None
                }
            }
        };
        if let Some((mode, cause)) = candidate {
            let cause = retry.unwrap_or(cause);
            wanted.push(Action::RunWorker {
                unit: unit.id.clone(),
                worker: worker_key.clone(),
                mode,
                cause,
            });
        }
    }
    Ok(wanted)
}
/// The operator reviews of a stage a decision is legal on now, each with its
/// inputs evaluated against the stepped state (an unresolved read as null).
pub(super) fn resolve_reviews(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Vec<ResolvedReview>, StepError> {
    let mut resolved = Vec::new();
    for review in &checked_stage(program, unit)?.reviews {
        let CheckedReview::Operator {
            key,
            of,
            inputs,
            when,
            decisions,
        } = review
        else {
            continue;
        };
        if !holds(when.as_ref(), unit, state, context)? {
            continue;
        }
        let Some(target) = latest(state, &unit.id, of) else {
            continue;
        };
        if is_decided_by(state, &unit.id, key, &target.id) {
            continue;
        }
        let decisions = open_decisions(state, &unit.id, key, of, decisions);
        let mut resolved_inputs = serde_json::Map::new();
        for field in inputs {
            let value = eval_expression(&field.value.expression, unit, state, None, None, context)?;
            resolved_inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
        }
        resolved.push(ResolvedReview {
            unit: unit.id.clone(),
            review: key.clone(),
            target: target.id.clone(),
            decisions,
            inputs: Value::Object(resolved_inputs),
        });
    }
    Ok(resolved)
}
pub(super) fn decided_artifact<'a>(of: &'a SymbolKey, on: &'a Option<SymbolKey>) -> &'a SymbolKey {
    on.as_ref().unwrap_or(of)
}
pub(super) fn is_decided_by(
    state: &StepSnapshot,
    unit: &UnitId,
    review: &SymbolKey,
    target: &RevisionId,
) -> bool {
    state.decisions.iter().any(|decision| {
        decision.unit == *unit && decision.review == *review && decision.target == *target
    })
}
pub(super) fn open_decisions(
    state: &StepSnapshot,
    unit: &UnitId,
    review: &SymbolKey,
    of: &SymbolKey,
    decisions: &BTreeMap<String, CheckedDecision>,
) -> Vec<ResolvedDecision> {
    decisions
        .iter()
        .filter_map(|(key, decision)| {
            let target = latest(state, unit, decided_artifact(of, &decision.on))?;
            (!is_decided_by(state, unit, review, &target.id)).then(|| ResolvedDecision {
                decision: SymbolKey::from(key.as_str()),
                target: target.id.clone(),
            })
        })
        .collect()
}
/// Evaluate what a wanted `RunWorker` runs with against the stepped state.
pub(super) fn resolve_run_worker(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    action: &RunWorkerAction<'_>,
    context: &EvaluationContext<'_>,
) -> Result<ResolvedRunWorker, StepError> {
    let checked = checked_stage(program, unit)?
        .workers
        .iter()
        .find(|candidate| candidate.key() == action.worker)
        .ok_or_else(|| invalid(format!("checked worker {} absent", action.worker)))?;
    let mut inputs = serde_json::Map::new();
    for field in checked.inputs() {
        let value = eval_expression(&field.value.expression, unit, state, None, None, context)?;
        inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
    }
    let workspace_expression = match checked {
        CheckedWorker::Agent { workspace, .. } => workspace.as_ref(),
        CheckedWorker::Code { .. } => None,
    };
    let workspace = match workspace_expression {
        None => None,
        Some(expression) => Some(
            eval_expression(&expression.expression, unit, state, None, None, context)?
                .ok_or_else(|| invalid(format!("workspace of {} unresolved", action.worker)))?,
        ),
    };
    let (previous, feedback) = match action.mode {
        Mode::Revise => match answered_decision(state, &unit.id, checked.creates(), action.cause) {
            Some((revision, decision)) => (Some(revision.clone()), Some(decision.payload.clone())),
            None => (None, None),
        },
        _ => (None, None),
    };
    let subject = match (action.mode, checked) {
        (
            Mode::Review,
            CheckedWorker::Agent {
                reviews: Some(of), ..
            },
        ) => latest(state, &unit.id, of).cloned(),
        _ => None,
    };
    Ok(ResolvedRunWorker {
        action_id: action_id(&unit.id, action.worker, action.mode, action.cause),
        inputs: Value::Object(inputs),
        previous,
        feedback,
        subject,
        workspace,
    })
}
/// The request_changes decision a revise of `artifacts` answers: the
/// newest one on the latest revision of the first artifact, in `creates`
/// order, that has one.
pub(super) struct RunWorkerAction<'a> {
    pub(super) worker: &'a WorkerKey,
    pub(super) mode: &'a Mode,
    pub(super) cause: &'a Cause,
}
/// `hash(unit, worker, mode, cause)` (part 1 §4): 32 hex characters, so an
/// action's id is bounded however long its unit's path. The parts are
/// hashed as their wire JSON, which their schemas fix, not as Rust's
/// `Debug` output, which a refactor could change.
#[doc(hidden)]
pub fn action_id(unit: &UnitId, worker: &WorkerKey, mode: &Mode, cause: &Cause) -> ActionKey {
    ActionKey(json_digest(&serde_json::json!([unit, worker, mode, cause])))
}
pub(super) struct StageWants {
    pub(super) workers: Vec<workflow_model::protocol::WantedWorker>,
    pub(super) reviews: Vec<ResolvedReview>,
    pub(super) pending: Vec<Delta>,
}
/// Derive a stage's wanted workers and pending attempts without changing state.
pub(super) fn stage_wants(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    stage_unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<StageWants, StepError> {
    let actions = stage_actions(program, state, stage_unit, context)?;
    let mut workers = Vec::new();
    let mut pending = Vec::new();
    for action in &actions {
        let Action::RunWorker {
            unit,
            worker,
            mode,
            cause,
        } = action;
        let id = action_id(unit, worker, mode, cause);
        let resolved = resolve_run_worker(
            program,
            state,
            stage_unit,
            &RunWorkerAction {
                worker,
                mode,
                cause,
            },
            context,
        )?;
        let existing = state.attempts.iter().rev().find(|a| a.action_id == id);
        if existing.is_none() {
            pending.push(Delta::PushAttempt(AttemptState {
                action_id: id.clone(),
                seq: 1,
                unit: unit.clone(),
                worker: worker.clone(),
                mode: mode.clone(),
                cause: cause.clone(),
                status: AttemptStatus::Pending,
                kbbl_session_id: None,
                ended_at: None,
            }));
        }
        let attempt_seq = existing.map_or(1, |attempt| attempt.seq);
        workers.push(workflow_model::protocol::WantedWorker {
            unit: unit.clone(),
            worker: worker.clone(),
            action_id: id,
            attempt_seq,
            action: action.clone(),
            resolved,
        });
    }
    let reviews = resolve_reviews(program, state, stage_unit, context)?;
    Ok(StageWants {
        workers,
        reviews,
        pending,
    })
}
