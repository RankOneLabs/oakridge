use super::*;
pub(super) fn compile_stage(
    key: &str,
    stage: &Stage,
    workflow: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Result<(CheckedStage, TypeExpression), DomainError> {
    let stage_path = format!("stages.{key}");
    set_path(&stage_path);
    let empty = BTreeMap::new();
    let base = Scope {
        input: &stage.input,
        artifacts: &stage.artifacts,
        outcomes: &empty,
        each: None,
        item: None,
        aliases: &workflow.schemas,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: BTreeSet::new(),
    };
    let mut owners = BTreeMap::<String, String>::new();
    let mut workers = Vec::new();
    for (worker_key, worker) in &stage.workers {
        set_path(format!("{stage_path}.workers.{worker_key}"));
        let created = match worker {
            Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates,
        };
        if created.is_empty() {
            return Err(failure(7, format!("worker {worker_key} creates nothing")));
        }
        for artifact in created {
            if !stage.artifacts.contains_key(&artifact.0) {
                return Err(failure(1, format!("artifact {artifact} absent")));
            }
            if owners
                .insert(artifact.0.clone(), worker_key.clone())
                .is_some()
            {
                return Err(failure(
                    7,
                    format!("artifact {artifact} has multiple creators"),
                ));
            }
        }
        let guard = match worker {
            Worker::Agent { when, .. } | Worker::Code { when, .. } => when.as_deref(),
        };
        set_path(format!("{stage_path}.workers.{worker_key}.when"));
        let when = guard
            .map(|text| checked_guard(text, &base, 9, &format!("worker {worker_key} when")))
            .transpose()?;
        // A worker runs only while its guard holds, so what the guard proves
        // published types the worker's inputs and workspace.
        let worker_scope = Scope {
            guaranteed: when
                .as_ref()
                .map(|(_, proven)| proven.clone())
                .unwrap_or_default(),
            ..base.clone()
        };
        set_path(format!("{stage_path}.workers.{worker_key}"));
        let checked_worker = match worker {
            Worker::Agent {
                prompts: modes,
                inputs,
                creates,
                reviews,
                workspace,
                session,
                ..
            } => {
                set_path(format!("{stage_path}.workers.{worker_key}.inputs"));
                let input_fields = fields(inputs, &worker_scope)?;
                set_path(format!("{stage_path}.workers.{worker_key}.workspace"));
                let workspace = workspace_expression(workspace.as_deref(), &worker_scope)?;
                set_path(format!("{stage_path}.workers.{worker_key}"));
                if reviews.is_some() && !modes.contains_key("review") {
                    return Err(failure(
                        7,
                        format!("reviewer {worker_key} lacks review prompt"),
                    ));
                }
                if reviews.is_none() && !modes.contains_key("initial") {
                    return Err(failure(
                        7,
                        format!("agent {worker_key} lacks initial prompt"),
                    ));
                }
                if let Some(of) = reviews {
                    if !stage.artifacts.contains_key(&of.0) {
                        return Err(failure(8, format!("reviewed artifact {of} absent")));
                    }
                }
                let needs_revise = creates.iter().any(|artifact| {
                    !stage.artifacts[&artifact.0].validate.is_empty()
                        || stage
                            .reviews
                            .values()
                            .flat_map(|review| {
                                review.decisions.values().map(move |decision| {
                                    (decision.on.as_ref().unwrap_or(&review.of), decision)
                                })
                            })
                            .any(|(target, decision)| {
                                target == artifact
                                    && decision.effect == DecisionEffect::RequestChanges
                            })
                });
                if needs_revise && !modes.contains_key("revise") {
                    return Err(failure(
                        7,
                        format!("agent {worker_key} lacks revise prompt"),
                    ));
                }
                if modes.contains_key(HANDOFF_PROMPT)
                    && !matches!(session, Some(SessionMode::Fresh))
                {
                    return Err(failure(
                        7,
                        format!(
                            "agent {worker_key} has a handoff prompt but its session is not fresh"
                        ),
                    ));
                }
                for (mode, path) in modes {
                    set_path(format!("{stage_path}.workers.{worker_key}.prompts.{mode}"));
                    let engine_inputs = if mode == HANDOFF_PROMPT {
                        HANDOFF_ENGINE_INPUTS
                    } else {
                        MODE_ENGINE_INPUTS
                    };
                    prompt(path, inputs, prompts, engine_inputs)?;
                }
                set_path(format!("{stage_path}.workers.{worker_key}"));
                CheckedWorker::Agent {
                    key: WorkerKey::from(worker_key.as_str()),
                    inputs: input_fields,
                    creates: creates.clone(),
                    reviews: reviews.clone(),
                    workspace,
                    when: when.map(|(expression, _)| expression),
                }
            }
            Worker::Code {
                operation,
                inputs,
                creates,
                every,
                ..
            } => {
                if let Some(interval) = every {
                    if !is_duration(interval) {
                        return Err(failure(
                            12,
                            format!("code worker {worker_key} every {interval} is not a duration"),
                        ));
                    }
                }
                if creates.len() != 1 {
                    return Err(failure(
                        12,
                        format!("code worker {worker_key} must create one artifact"),
                    ));
                }
                set_path(format!("{stage_path}.workers.{worker_key}.operation"));
                let contract = operations
                    .iter()
                    .find(|o| o.key == *operation)
                    .ok_or_else(|| failure(12, format!("operation {operation} absent")))?;
                set_path(format!("{stage_path}.workers.{worker_key}.inputs"));
                let input_fields = fields(inputs, &worker_scope)?;
                set_path(format!("{stage_path}.workers.{worker_key}"));
                let mut bindings = BTreeMap::new();
                if !unify(
                    &contract.input_schema,
                    &checked_record(&input_fields),
                    &workflow.schemas,
                    &mut bindings,
                ) {
                    return Err(failure(12, format!("operation {operation} input mismatch")));
                }
                if !unify(
                    &contract.output_schema,
                    &stage.artifacts[&creates[0].0].schema,
                    &workflow.schemas,
                    &mut bindings,
                ) {
                    return Err(failure(
                        12,
                        format!("operation {operation} output mismatch"),
                    ));
                }
                CheckedWorker::Code {
                    key: WorkerKey::from(worker_key.as_str()),
                    inputs: input_fields,
                    creates: creates.clone(),
                    every: every.clone(),
                    when: when.map(|(expression, _)| expression),
                }
            }
        };
        workers.push(checked_worker);
    }
    for artifact in stage.artifacts.keys() {
        set_path(format!("{stage_path}.artifacts.{artifact}"));
        if !owners.contains_key(artifact) {
            return Err(failure(7, format!("artifact {artifact} has no creator")));
        }
    }
    let mut artifacts = Vec::new();
    for (artifact_key, artifact) in &stage.artifacts {
        set_path(format!("{stage_path}.artifacts.{artifact_key}"));
        let own = Scope {
            body: Some((artifact_key, &artifact.schema)),
            ..base.clone()
        };
        let validations = artifact
            .validate
            .iter()
            .map(|rule| {
                set_path(format!(
                    "{stage_path}.artifacts.{artifact_key}.validate.check"
                ));
                let expression = checked(&rule.check, &own)?;
                if expression.value_type != Type::Boolean {
                    return Err(failure(8, "validation check must be boolean"));
                }
                Ok(CheckedArtifactValidation {
                    expression,
                    message: rule.message.clone(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        artifacts.push(CheckedArtifact {
            key: SymbolKey::from(artifact_key.as_str()),
            schema: checked_type(&artifact.schema, &workflow.schemas)?,
            validations,
        });
    }
    let mut reviews = Vec::new();
    for (review_key, review) in &stage.reviews {
        set_path(format!("{stage_path}.reviews.{review_key}"));
        if !stage.artifacts.contains_key(&review.of.0) {
            return Err(failure(8, format!("review {review_key} artifact absent")));
        }
        set_path(format!("{stage_path}.reviews.{review_key}.when"));
        let when = review
            .when
            .as_deref()
            .map(|text| checked_guard(text, &base, 9, &format!("review {review_key} when")))
            .transpose()?
            .map(|(expression, _)| expression);
        set_path(format!("{stage_path}.reviews.{review_key}.prompt"));
        match review.by {
            ReviewBy::Operator => check_operator_review(review_key, review, prompts)?,
            ReviewBy::Engine => check_engine_review(review_key, review, when.is_some())?,
        }
        set_path(format!("{stage_path}.reviews.{review_key}.inputs"));
        let review_inputs = fields(&review.inputs, &base).map_err(|mut error| {
            error.entity_id = "check 8".into();
            error
        })?;
        set_path(format!("{stage_path}.reviews.{review_key}"));
        let key = SymbolKey::from(review_key.as_str());
        let checked_review = match review.by {
            ReviewBy::Operator => CheckedReview::Operator {
                key,
                of: review.of.clone(),
                inputs: review_inputs,
                when,
                decisions: review
                    .decisions
                    .iter()
                    .map(|(key, decision)| {
                        Ok((
                            key.clone(),
                            CheckedDecision {
                                effect: decision.effect.clone(),
                                on: decision.on.clone(),
                                payload: decision
                                    .payload
                                    .as_ref()
                                    .map(|ty| checked_type(ty, &workflow.schemas))
                                    .transpose()?,
                            },
                        ))
                    })
                    .collect::<Result<_, DomainError>>()?,
            },
            ReviewBy::Engine => {
                let (decision_key, decision) = review.decisions.iter().next().unwrap();
                CheckedReview::Engine {
                    key,
                    of: review.of.clone(),
                    when: when.unwrap(),
                    decision: CheckedEngineDecision {
                        key: SymbolKey::from(decision_key.as_str()),
                        effect: decision.effect.clone(),
                        on: decision.on.clone(),
                        feedback: decision.feedback.clone().unwrap(),
                    },
                }
            }
        };
        reviews.push(checked_review);
        for decision in review.decisions.values() {
            let target = decision.on.as_ref().unwrap_or(&review.of);
            let Some(owner) = owners.get(&target.0) else {
                return Err(failure(8, format!("decision target {target} absent")));
            };
            // Only a request for changes needs a worker that can revise; an
            // approval may be of any artifact (a reviewer's, a code worker's).
            if decision.effect == DecisionEffect::RequestChanges
                && !matches!(stage.workers[owner], Worker::Agent { reviews: None, .. })
            {
                return Err(failure(
                    8,
                    format!("decision target {target} is not agent-created"),
                ));
            }
        }
    }
    set_path(format!("{stage_path}.done_when"));
    let done = stage
        .done_when
        .as_deref()
        .ok_or_else(|| failure(9, format!("stage {key} lacks done_when")))?;
    let (done_when, proven) = checked_guard(done, &base, 9, &format!("stage {key} done_when"))?;
    let outcome_scope = Scope {
        guaranteed: proven,
        ..base
    };
    set_path(format!("{stage_path}.outcome"));
    let outcome = fields(&stage.outcome, &outcome_scope)?;
    let outcome_type = checked_record(&outcome);
    Ok((
        CheckedStage {
            key: SymbolKey::from(key),
            workers,
            done_when,
            outcome,
            artifacts,
            reviews,
        },
        outcome_type,
    ))
}
