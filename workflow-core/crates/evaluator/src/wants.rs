use super::*;
/// Whether an expression reads an artifact of its unit: `latest`,
/// `published`, `approved` or `changes_requested` of it.
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
        Expression::Default {
            value: left,
            fallback: right,
        }
        | Expression::Equals { left, right }
        | Expression::GreaterThan { left, right }
        | Expression::GreaterOrEqual { left, right }
        | Expression::LessThan { left, right }
        | Expression::LessOrEqual { left, right } => reads(left) || reads(right),
        Expression::Len { value }
        | Expression::Flatten { value }
        | Expression::Unique { value }
        | Expression::Not { value }
        | Expression::Field { value, .. }
        | Expression::Present { value, .. }
        | Expression::Require { value } => reads(value),
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Readiness {
    Blocked,
    Ready,
    RetryAuthorized { event: EventId },
}

pub(super) fn can_run(state: &StepSnapshot, unit: &UnitId, worker: &WorkerKey) -> Readiness {
    let Some(previous) = attempt(state, unit, worker) else {
        return Readiness::Ready;
    };
    match previous.status {
        AttemptStatus::Pending | AttemptStatus::Running => Readiness::Blocked,
        AttemptStatus::Failed { .. } => {
            // A later failure waits for a new retry once the latest is spent.
            let Some(retry) = latest_retry(state, unit, worker) else {
                return Readiness::Blocked;
            };
            if is_retry_spent(state, unit, worker, retry) {
                Readiness::Blocked
            } else {
                Readiness::RetryAuthorized {
                    event: retry.clone(),
                }
            }
        }
        AttemptStatus::Succeeded => Readiness::Ready,
    }
}
/// Whether an optional guard holds; no guard always holds, and an
/// unresolved one does not.
pub(super) fn holds(
    guard: Option<&CheckedStageExpression>,
    unit: &UnitState,
    state: &StepSnapshot,
    context: &mut EvaluationContext<'_>,
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
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<Action>, StepError> {
    let checked = checked_stage(program, unit)?;
    let mut wanted = Vec::new();
    if let Some(revision) = parked_blocker(state, &unit.id) {
        let blocker = &revision.id;
        let publisher = revision
            .by
            .as_ref()
            .and_then(|action| {
                state
                    .attempts
                    .iter()
                    .find(|attempt| &attempt.action_id == action)
            })
            .ok_or_else(|| invalid("blocker publisher absent"))?;
        let decision = state.decisions.iter().rev().find(|decision| {
            decision.unit() == &unit.id
                && decision
                    .review()
                    .is_some_and(|review| review.0 == BLOCKER_REVIEW)
                && decision.target() == blocker
        });
        if let Some(decision) = decision {
            let cause = match can_run(state, &unit.id, &publisher.worker) {
                Readiness::Blocked => return Ok(wanted),
                Readiness::RetryAuthorized { event } => Cause::Retry {
                    event,
                    mode: Mode::Revise,
                },
                Readiness::Ready => Cause::ChangesRequested {
                    decision: decision.id().clone(),
                },
            };
            wanted.push(Action::RunWorker {
                unit: unit.id.clone(),
                worker: publisher.worker.clone(),
                mode: Mode::Revise,
                cause,
            });
        }
        return Ok(wanted);
    }
    for checked_worker in &checked.workers {
        let worker_key = checked_worker.key();
        let readiness = can_run(state, &unit.id, worker_key);
        if readiness == Readiness::Blocked {
            continue;
        }
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
                let already = creates
                    .iter()
                    .filter(|artifact| artifact.0 != BLOCKER_ARTIFACT)
                    .all(|artifact| {
                        state.revisions.iter().any(|r| {
                            r.unit == unit.id
                                && r.artifact == *artifact
                                && r.subject.as_ref() == Some(&subject.id)
                        })
                    });
                if !already {
                    Some((
                        Mode::Review,
                        Cause::ReviewOf {
                            revision: subject.id.clone(),
                        },
                    ))
                } else {
                    reviewer_changes_requested(
                        ReviewerChangeSearch {
                            program,
                            state,
                            unit,
                            creates,
                        },
                        context,
                    )?
                    .map(|decision| {
                        (
                            Mode::Revise,
                            Cause::ChangesRequested {
                                decision: decision.id().clone(),
                            },
                        )
                    })
                }
            }
            CheckedWorker::Agent {
                creates,
                reviews: None,
                ..
            } => {
                if creates
                    .iter()
                    .filter(|artifact| artifact.0 != BLOCKER_ARTIFACT)
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    changes_requested(state, &unit.id, creates)
                        .or_else(|| {
                            redirected_request(checked, state, &unit.id, creates)
                                .map(|(_, decision)| decision)
                        })
                        .map(|decision| {
                            (
                                Mode::Revise,
                                Cause::ChangesRequested {
                                    decision: decision.id().clone(),
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
                    .filter(|artifact| artifact.0 != BLOCKER_ARTIFACT)
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    None
                }
            }
        };
        if let Some((mode, cause)) = candidate {
            let cause = match readiness {
                Readiness::RetryAuthorized { event } => Cause::Retry {
                    event,
                    mode: mode.clone(),
                },
                Readiness::Ready => cause,
                Readiness::Blocked => unreachable!("blocked workers were skipped"),
            };
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
/// A review must not open only because a periodic watch still carries evidence
/// about old inputs. A manual fallback may remain open if its guard still
/// holds with that stale evidence removed.
pub(super) fn operator_review_is_open(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    when: Option<&CheckedStageExpression>,
    context: &mut EvaluationContext<'_>,
) -> Result<bool, StepError> {
    if !holds(when, unit, state, context)? {
        return Ok(false);
    }
    let Some(guard) = when else {
        return Ok(true);
    };
    let unobserved = unobserved_watch_artifacts(program, state, unit, context)?;
    if !reads_any(&guard.expression, &unobserved) {
        return Ok(true);
    }
    let mut without_stale_evidence = state.clone();
    without_stale_evidence
        .revisions
        .retain(|revision| revision.unit != unit.id || !unobserved.contains(&revision.artifact));
    holds(when, unit, &without_stale_evidence, context)
}

/// An operator may review an artifact only once the attempt producing it has
/// finished, so a worker that publishes several artifacts cannot have the
/// first approved before the rest exist. A review-worker's output must also
/// still describe the latest subject revision: a request for changes on the
/// subject can start its replacement while the previous assessment remains
/// published, and that assessment must not be approved during the replacement.
pub(super) fn reviewed_output_is_current(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    artifact: &SymbolKey,
) -> Result<bool, StepError> {
    let stage = checked_stage(program, unit)?;
    if artifact.0 == BLOCKER_ARTIFACT {
        return Ok(parked_blocker(state, &unit.id).is_some());
    }
    if parked_blocker(state, &unit.id).is_some() {
        return Ok(false);
    }
    if is_output_in_progress(stage, state, &unit.id, artifact) {
        return Ok(false);
    }
    // A review that sent the latest revision's changes to another worker's
    // artifact has spent it: the creator revises it once that is answered.
    if pending_redirects(stage, state, &unit.id, artifact)
        .next()
        .is_some()
    {
        return Ok(false);
    }
    for worker in &stage.workers {
        let CheckedWorker::Agent {
            creates,
            reviews: Some(subject),
            ..
        } = worker
        else {
            continue;
        };
        if !creates.contains(artifact) {
            continue;
        }
        let Some(output) = latest(state, &unit.id, artifact) else {
            return Ok(false);
        };
        let Some(current_subject) = latest(state, &unit.id, subject) else {
            return Ok(false);
        };
        if is_creator_working(stage, state, &unit.id, artifact)
            || is_creator_working(stage, state, &unit.id, subject)
            || changes_requested(state, &unit.id, std::slice::from_ref(subject)).is_some()
            || output.subject.as_ref() != Some(&current_subject.id)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The operator reviews of a stage a decision is legal on now, each with its
/// inputs evaluated against the stepped state (an unresolved read as null).
pub(super) fn resolve_reviews(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &mut EvaluationContext<'_>,
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
        if !operator_review_is_open(program, state, unit, when.as_ref(), context)?
            || !reviewed_output_is_current(program, state, unit, of)?
        {
            continue;
        }
        let Some(target) = latest(state, &unit.id, of) else {
            continue;
        };
        if is_decided_by(state, &unit.id, key, &target.id) {
            continue;
        }
        let decisions = open_decisions(
            OpenDecisionScope {
                state,
                unit,
                review: key,
                of,
                decisions,
            },
            context,
        )?;
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
        matches!(decision, DecisionState::Review { unit: decided_unit, review: decided_review, target: decided_target, .. }
            if decided_unit == unit && decided_review == review && decided_target == target)
    })
}
/// Whether a revision's declared artifact validation failed on publication.
/// The failure belongs to that revision alone: a corrected revision is judged
/// on its own publication, and an earlier failure stays as history.
pub(super) fn has_failed_validation(state: &StepSnapshot, revision: &RevisionId) -> bool {
    state.decisions.iter().any(|decision| {
        matches!(decision, DecisionState::Validation { target, .. } if target == revision)
    })
}
pub(super) struct DecisionAvailability<'a> {
    pub guard: Option<&'a CheckedDecisionGuard>,
    pub of: &'a SymbolKey,
    pub unit: &'a UnitState,
    pub state: &'a StepSnapshot,
}
pub(super) fn decision_disabled_reason(
    request: DecisionAvailability<'_>,
    context: &mut EvaluationContext<'_>,
) -> Result<Option<String>, StepError> {
    let DecisionAvailability {
        guard,
        of,
        unit,
        state,
    } = request;
    let Some(guard) = guard else {
        return Ok(None);
    };
    let body = latest(state, &unit.id, of).map(|revision| (of.0.as_str(), &revision.body));
    Ok(
        (eval_expression(&guard.check.expression, unit, state, None, body, context)?
            != Some(Value::Bool(true)))
        .then(|| guard.reason.clone()),
    )
}
struct OpenDecisionScope<'a> {
    state: &'a StepSnapshot,
    unit: &'a UnitState,
    review: &'a SymbolKey,
    of: &'a SymbolKey,
    decisions: &'a BTreeMap<String, CheckedDecision>,
}
fn open_decisions(
    scope: OpenDecisionScope<'_>,
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<ResolvedDecision>, StepError> {
    let OpenDecisionScope {
        state,
        unit,
        review,
        of,
        decisions,
    } = scope;
    let mut resolved = Vec::new();
    for (key, decision) in decisions {
        let Some(target) = latest(state, &unit.id, decided_artifact(of, &decision.on)) else {
            continue;
        };
        let is_refused = decision.effect == DeclaredDecisionEffect::Approve
            && has_failed_validation(state, &target.id);
        if is_refused || is_decided_by(state, &unit.id, review, &target.id) {
            continue;
        }
        let disabled_reason = decision_disabled_reason(
            DecisionAvailability {
                guard: decision.when.as_ref(),
                of,
                unit,
                state,
            },
            context,
        )?;
        resolved.push(ResolvedDecision {
            decision: SymbolKey::from(key.as_str()),
            target: target.id.clone(),
            is_available: disabled_reason.is_none(),
            disabled_reason,
        });
    }
    Ok(resolved)
}
/// Evaluate what a wanted `RunWorker` runs with against the stepped state.
pub(super) fn resolve_run_worker(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    action: &RunWorkerAction<'_>,
    context: &mut EvaluationContext<'_>,
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
    let subject = match (action.mode, checked) {
        (
            Mode::Review | Mode::Revise,
            CheckedWorker::Agent {
                reviews: Some(of), ..
            },
        ) => latest(state, &unit.id, of).cloned(),
        _ => None,
    };
    let (previous, feedback) = match action.mode {
        Mode::Revise => match if parked_blocker(state, &unit.id).is_none()
            && matches!(action.cause, Cause::Retry { .. })
            && matches!(
                checked,
                CheckedWorker::Agent {
                    reviews: Some(_),
                    ..
                }
            ) {
            reviewer_changes_requested(
                ReviewerChangeSearch {
                    program,
                    state,
                    unit,
                    creates: checked.creates(),
                },
                context,
            )?
            .and_then(|decision| {
                state
                    .revisions
                    .iter()
                    .find(|revision| &revision.id == decision.target())
                    .map(|revision| (revision, decision))
            })
        } else if let Some(blocker) = parked_blocker(state, &unit.id) {
            state
                .decisions
                .iter()
                .rev()
                .find(|decision| {
                    decision.unit() == &unit.id
                        && decision
                            .review()
                            .is_some_and(|review| review.0 == BLOCKER_REVIEW)
                        && decision.target() == &blocker.id
                })
                .map(|decision| (blocker, decision))
        } else {
            answered_decision(state, &unit.id, checked.creates(), action.cause)
                .filter(|(revision, _)| checked.creates().contains(&revision.artifact))
                .or_else(|| {
                    // A request redirected upstream: revise the reviewed
                    // revision against the redirected decision.
                    redirected_request(
                        checked_stage(program, unit).ok()?,
                        state,
                        &unit.id,
                        checked.creates(),
                    )
                })
        } {
            Some((revision, decision)) if decision.target() != &revision.id => {
                (Some(revision.clone()), redirected_feedback(decision))
            }
            Some((revision, _decision)) => (
                Some(revision.clone()),
                feedback_on(state, &unit.id, &revision.id, revision.decision_cursor),
            ),
            None => (None, Vec::new()),
        },
        Mode::Review => match reviewed_before(
            state,
            &unit.id,
            checked.creates(),
            subject.as_ref().map(|revision| &revision.id),
        ) {
            Some((revision, feedback)) => (Some(revision.clone()), feedback),
            None => (None, Vec::new()),
        },
        _ => (None, Vec::new()),
    };
    let stage = checked_stage(program, unit)?;
    let feedback = feedback
        .into_iter()
        .map(|entry| forward_feedback(stage, entry))
        .collect();
    let review_history = if matches!(checked, CheckedWorker::Agent { .. })
        && matches!(action.mode, Mode::Revise | Mode::Review)
    {
        unit_review_history(state, &unit.id)
    } else {
        vec![]
    };
    Ok(ResolvedRunWorker {
        review_history,
        input_provenance: unit.input_provenance.clone(),
        action_id: action_id(&unit.id, action.worker, action.mode, action.cause),
        inputs: Value::Object(inputs),
        previous,
        feedback,
        subject,
        workspace,
    })
}
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
    let mut cause_wire = serde_json::to_value(cause).expect("cause serializes");
    // The retry mode is already the third hash component. Preserve action
    // identity while making the cause self-contained in stored state.
    if let Some(fields) = cause_wire.as_object_mut() {
        fields.remove("mode");
    }
    ActionKey(json_digest(&serde_json::json!([
        unit, worker, mode, cause_wire
    ])))
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
    context: &mut EvaluationContext<'_>,
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

struct ReviewerChangeSearch<'a> {
    program: &'a CheckedWorkflow,
    state: &'a StepSnapshot,
    unit: &'a UnitState,
    creates: &'a [SymbolKey],
}

fn reviewer_changes_requested<'a>(
    search: ReviewerChangeSearch<'a>,
    context: &mut EvaluationContext<'_>,
) -> Result<Option<&'a DecisionState>, StepError> {
    let ReviewerChangeSearch {
        program,
        state,
        unit,
        creates,
    } = search;
    let checked = checked_stage(program, unit)?;
    let mut deferred_validation = Vec::new();
    for review in &checked.reviews {
        let CheckedReview::Operator {
            key,
            of,
            when,
            decisions,
            ..
        } = review
        else {
            continue;
        };
        if !creates.contains(of)
            || !operator_review_is_open(program, state, unit, when.as_ref(), context)?
        {
            continue;
        }
        let can_request_changes = open_decisions(
            OpenDecisionScope {
                state,
                unit,
                review: key,
                of,
                decisions,
            },
            context,
        )?
        .iter()
        .any(|offered| {
            let decision = &decisions[&offered.decision.0];
            offered.is_available
                && decision.effect == DeclaredDecisionEffect::RequestChanges
                && decided_artifact(of, &decision.on) == of
        });
        if can_request_changes {
            deferred_validation.push(of.clone());
        }
    }
    Ok(changes_requested_except(ChangeRequestSearch {
        state,
        unit: &unit.id,
        artifacts: creates,
        deferred_validation: &deferred_validation,
    }))
}

/// Select only the declared text field for delivery, leaving stored history intact.
fn forward_feedback(stage: &CheckedStage, mut entry: FeedbackEntry) -> FeedbackEntry {
    let field = stage.reviews.iter().find_map(|review| match review {
        CheckedReview::Operator { key, decisions, .. } if key == &entry.review => decisions
            .get(&entry.decision.0)
            .and_then(|decision| decision.feedback_field.as_ref()),
        _ => None,
    });
    if let Some(field) = field {
        entry.payload = serde_json::json!({"feedback": entry.payload.get(field).cloned().unwrap_or(Value::Null)});
    }
    entry
}

/// All of the unit's review decisions in durable snapshot order, with original payloads.
fn unit_review_history(state: &StepSnapshot, unit: &UnitId) -> Vec<FeedbackEntry> {
    state
        .decisions
        .iter()
        .filter_map(|record| match record {
            DecisionState::Review {
                id,
                unit: owner,
                review,
                decision,
                target,
                payload,
                ..
            } if owner == unit => Some(FeedbackEntry {
                id: id.clone(),
                review: review.clone(),
                decision: decision.clone(),
                target: target.clone(),
                payload: payload.clone(),
            }),
            _ => None,
        })
        .collect()
}
