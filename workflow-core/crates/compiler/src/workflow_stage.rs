use super::worker::StageCheck;
use super::*;

pub(super) fn compile_stage(
    key: &str,
    stage: &Stage,
    workflow: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Result<(CheckedStage, TypeExpression), Vec<CompileError>> {
    let reserved_errors: Vec<_> = stage
        .artifacts
        .keys()
        .map(|key| ("artifacts", key))
        .chain(stage.reviews.keys().map(|key| ("reviews", key)))
        .filter(|(_, key)| matches!(key.as_str(), BLOCKER_ARTIFACT | BLOCKER_REVIEW))
        .map(|(section, name)| {
            CompileError::new(
                CheckKind::Name,
                format!("stages.{key}.{section}.{name}"),
                SourceSpan::default(),
                format!("reserved name {name}"),
            )
        })
        .collect();
    if !reserved_errors.is_empty() {
        return Err(reserved_errors);
    }
    let empty = BTreeMap::new();
    let base = Scope {
        input: &stage.input,
        artifacts: &stage.artifacts,
        outcomes: &empty,
        each: None,
        item: None,
        aliases: &workflow.schemas,
        lets: &stage.let_bindings,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: BTreeSet::new(),
        diagnostic_path: String::new(),
        diagnostic_span: SourceSpan::default(),
    };
    let mut state = StageCheck {
        stage,
        workflow,
        operations,
        prompts,
        base,
        path: format!("stages.{key}"),
        owners: BTreeMap::new(),
        errors: Vec::new(),
    };
    for (name, source) in &stage.let_bindings {
        let path = format!("stages.{key}.let.{name}");
        state.capture(checked(source, &state.base, &path));
    }
    let mut workers = Vec::new();
    for (worker_key, worker) in &stage.workers {
        if let Some(checked) = state.worker(worker_key, worker) {
            workers.push(checked);
        }
    }
    for artifact_key in stage.artifacts.keys() {
        if !state.owners.contains_key(artifact_key) {
            state.error(
                CheckKind::Worker,
                &format!("stages.{key}.artifacts.{artifact_key}"),
                format!("artifact {artifact_key} has no creator"),
            );
        }
    }

    let mut artifacts = Vec::new();
    for (artifact_key, artifact) in &stage.artifacts {
        let before = state.errors.len();
        let own = Scope {
            body: Some((artifact_key, &artifact.schema)),
            ..state.base.clone()
        };
        let mut validations = Vec::new();
        for (index, rule) in artifact.validate.iter().enumerate() {
            let path = format!("stages.{key}.artifacts.{artifact_key}.validate.{index}.check");
            if let Some(expression) = state.capture(checked(&rule.check, &own, &path)) {
                if expression.value_type != Type::Boolean {
                    state.error(CheckKind::Review, &path, "validation check must be boolean");
                } else {
                    validations.push(CheckedArtifactValidation {
                        expression,
                        message: rule.message.clone(),
                    });
                }
            }
        }
        let schema = state.capture(checked_type(
            &artifact.schema,
            &workflow.schemas,
            &format!("stages.{key}.artifacts.{artifact_key}.schema"),
        ));
        if state.errors.len() == before {
            artifacts.push(CheckedArtifact {
                key: SymbolKey::from(artifact_key.as_str()),
                schema: schema.expect("valid artifact schema"),
                edit_policy: artifact.edit_policy.clone(),
                validations,
            });
        }
    }

    let mut reviews = Vec::new();
    for (review_key, review) in &stage.reviews {
        let before = state.errors.len();
        let path = format!("stages.{key}.reviews.{review_key}");
        if !stage.artifacts.contains_key(&review.of.0) {
            state.error(
                CheckKind::Review,
                &format!("{path}.of"),
                format!("review {review_key} artifact absent"),
            );
        }
        let when = review.when.as_deref().and_then(|text| {
            let result = checked_guard(
                text,
                &state.base,
                &format!("{path}.when"),
                CheckKind::ExpressionType,
                &format!("review {review_key} when"),
            );
            state.capture(result).map(|(expression, _)| expression)
        });
        let result = match review.by {
            ReviewBy::Operator => check_operator_review(review_key, review, prompts, &path),
            ReviewBy::Engine => {
                check_engine_review(review_key, review, review.when.is_some(), &path)
            }
        };
        state.capture(result);
        let adjudication_errors =
            adjudication::check_adjudication(adjudication::AdjudicationCheck {
                review_key,
                review,
                stage_key: key,
                stage,
                path: &path,
            });
        for error in adjudication_errors {
            state.error(error.check, &error.path.0, error.detail);
        }
        let input_before = state.errors.len();
        let review_inputs = state.fields(
            &review.inputs,
            &state.base.clone(),
            &format!("{path}.inputs"),
        );
        for error in &mut state.errors[input_before..] {
            error.check = CheckKind::Review;
        }
        let mut decisions = BTreeMap::new();
        for (decision_key, decision) in &review.decisions {
            let payload = decision
                .payload
                .as_ref()
                .map(|ty| {
                    checked_type(
                        ty,
                        &workflow.schemas,
                        &format!("{path}.decisions.{decision_key}.payload"),
                    )
                })
                .transpose();
            let decision_path = format!("{path}.decisions.{decision_key}");
            let guard = decision.when.as_ref().and_then(|guard| {
                if guard.reason.trim().is_empty() {
                    state.error(
                        CheckKind::Review,
                        &format!("{decision_path}.when.reason"),
                        "decision when requires a non-empty reason",
                    );
                }
                let body = stage
                    .artifacts
                    .get(&review.of.0)
                    .map(|artifact| (review.of.0.as_str(), &artifact.schema));
                // Decision checks see only the reviewed body and input, not latest mutable artifacts.
                let no_artifacts = BTreeMap::new();
                let no_lets = BTreeMap::new();
                let guard_scope = Scope {
                    artifacts: &no_artifacts,
                    lets: &no_lets,
                    body,
                    ..state.base.clone()
                };
                let check = state.capture(checked(
                    &guard.check,
                    &guard_scope,
                    &format!("{decision_path}.when.check"),
                ))?;
                if check.value_type != Type::Boolean {
                    state.error(
                        CheckKind::ExpressionType,
                        &format!("{decision_path}.when.check"),
                        "decision when check must be boolean",
                    );
                }
                Some(CheckedDecisionGuard {
                    check,
                    reason: guard.reason.clone(),
                })
            });
            if let Some(payload) = state.capture(payload) {
                if let Some(field) = &decision.feedback_field {
                    if decision.on.is_none()
                        || !matches!(&payload, Some(Type::Record { fields }) if fields.get(field) == Some(&Type::Text))
                    {
                        state.error(CheckKind::Review, &format!("{decision_path}.feedback_field"), "feedback_field requires an on target and a text field in the payload record");
                    }
                }
                decisions.insert(
                    decision_key.clone(),
                    CheckedDecision {
                        when: guard,
                        feedback_field: decision.feedback_field.clone(),
                        effect: decision.effect.clone(),
                        on: normalized_decision_target(decision.on.as_ref(), &review.of),
                        payload,
                    },
                );
            }
            let target = decision.on.as_ref().unwrap_or(&review.of);
            match state.owners.get(&target.0) {
                None => state.error(
                    CheckKind::Review,
                    &format!("{path}.decisions.{decision_key}.on"),
                    format!("decision target {target} absent"),
                ),
                Some(owner)
                    if decision.effect == DeclaredDecisionEffect::RequestChanges
                        && !matches!(stage.workers.get(owner), Some(Worker::Agent { .. })) =>
                {
                    state.error(
                        CheckKind::Review,
                        &format!("{path}.decisions.{decision_key}.on"),
                        format!("decision target {target} is not agent-created"),
                    );
                }
                Some(_) => {}
            }
        }
        if state.errors.len() != before {
            continue;
        }
        let review_key_value = SymbolKey::from(review_key.as_str());
        reviews.push(match review.by {
            ReviewBy::Operator => CheckedReview::Operator {
                key: review_key_value,
                of: review.of.clone(),
                inputs: review_inputs.expect("valid review inputs"),
                when,
                decisions,
            },
            ReviewBy::Engine => {
                let (decision_key, decision) = review
                    .decisions
                    .iter()
                    .next()
                    .expect("validated engine decision");
                CheckedReview::Engine {
                    key: review_key_value,
                    of: review.of.clone(),
                    when: when.expect("validated engine guard"),
                    decision: CheckedEngineDecision {
                        when: decisions
                            .get(decision_key)
                            .and_then(|decision| decision.when.clone()),
                        key: SymbolKey::from(decision_key.as_str()),
                        effect: decision.effect.clone(),
                        on: normalized_decision_target(decision.on.as_ref(), &review.of),
                        feedback: decision
                            .feedback
                            .clone()
                            .expect("validated engine feedback"),
                    },
                }
            }
        });
    }
    for artifact in &artifacts {
        if stage.artifacts[&artifact.key.0].kind == ArtifactKind::Assessment
            && matches!(&artifact.schema, Type::Record { fields } if fields.contains_key("next_actions"))
            && !adjudication::has_adjudication_coverage(stage, &artifact.key)
        {
            state.error(
                CheckKind::Review,
                &format!("stages.{key}.artifacts.{}", artifact.key),
                format!(
                    "assessment {} has next_actions but no review adjudicates it with accept and feedback",
                    artifact.key
                ),
            );
        }
    }
    let done = match stage.done_when.as_deref() {
        Some(text) => {
            let result = checked_guard(
                text,
                &state.base,
                &format!("stages.{key}.done_when"),
                CheckKind::ExpressionType,
                &format!("stage {key} done_when"),
            );
            state.capture(result)
        }
        None => {
            state.error(
                CheckKind::ExpressionType,
                &format!("stages.{key}.done_when"),
                format!("stage {key} lacks done_when"),
            );
            None
        }
    };
    let outcome_scope = Scope {
        guaranteed: done
            .as_ref()
            .map(|(_, proven)| proven.clone())
            .unwrap_or_default(),
        ..state.base.clone()
    };
    let outcome = state.fields(
        &stage.outcome,
        &outcome_scope,
        &format!("stages.{key}.outcome"),
    );
    if !state.errors.is_empty() {
        return Err(state.errors);
    }
    let outcome = outcome.expect("valid outcome fields");
    let outcome_type = checked_record(&outcome);
    if workers
        .iter()
        .any(|worker| matches!(worker, CheckedWorker::Agent { .. }))
    {
        artifacts.push(CheckedArtifact {
            key: SymbolKey::from(BLOCKER_ARTIFACT),
            schema: blocker_schema(),
            edit_policy: EditPolicy::Always,
            validations: vec![],
        });
        reviews.push(CheckedReview::Operator {
            key: SymbolKey::from(BLOCKER_REVIEW),
            of: SymbolKey::from(BLOCKER_ARTIFACT),
            inputs: vec![],
            when: None,
            decisions: blocker_review()
                .decisions
                .into_iter()
                .map(|(key, value)| {
                    (
                        key,
                        CheckedDecision {
                            effect: value.effect,
                            on: value.on,
                            payload: value.payload,
                            when: None,
                            feedback_field: value.feedback_field,
                        },
                    )
                })
                .collect(),
        });
    }
    Ok((
        CheckedStage {
            key: SymbolKey::from(key),
            workers,
            done_when: done.expect("valid done guard").0,
            outcome,
            artifacts,
            reviews,
        },
        outcome_type,
    ))
}
