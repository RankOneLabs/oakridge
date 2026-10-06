//! Pure checked-program evaluation. All dynamic inputs are revalidated at this boundary.
mod collections;
mod expressions;
pub use collections::materialize;
use std::collections::BTreeSet;
use workflow_compiler::validate_checked_value;
use workflow_model::*;
fn failure(
    kind: DomainErrorKind,
    entity: impl Into<String>,
    detail: impl Into<String>,
) -> DomainError {
    let mut e = DomainError::new(kind, entity, detail);
    e.operation = "evaluate".into();
    e
}
pub(crate) fn owner<'a>(
    program: &'a CheckedProgram,
    snapshot: &Snapshot,
) -> CoreResult<(&'a ScopeDefinition, &'a CheckedScope)> {
    let source = program
        .source
        .scopes
        .iter()
        .find(|s| s.key == snapshot.scope)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                snapshot.scope.to_string(),
                "scope not compiled",
            )
        })?;
    let checked = program
        .scopes
        .iter()
        .find(|s| s.key == snapshot.scope)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                snapshot.scope.to_string(),
                "checked scope unavailable",
            )
        })?;
    Ok((source, checked))
}
pub(crate) fn snapshot_valid(program: &CheckedProgram, snapshot: &Snapshot) -> CoreResult<()> {
    let maximum = wire_numbers::MAX_SAFE_INTEGER as u64;
    if snapshot.version > maximum
        || snapshot.random_seed > maximum
        || !(wire_numbers::MIN_SAFE_INTEGER..=wire_numbers::MAX_SAFE_INTEGER)
            .contains(&snapshot.timestamp_ms)
        || snapshot
            .observations
            .iter()
            .any(|observation| observation.version > maximum)
    {
        return Err(failure(
            DomainErrorKind::InvalidSnapshot,
            snapshot.owner.to_string(),
            "snapshot metadata exceeds JavaScript-safe wire range",
        ));
    }
    let (scope, _) = owner(program, snapshot)?;
    validate_checked_value(&program.source, &scope.input_schema, &snapshot.input)?;
    validate_checked_value(&program.source, &scope.state_schema, &snapshot.state)?;
    if snapshot.owner.0.is_empty() || snapshot.trigger.id.0.is_empty() {
        return Err(failure(
            DomainErrorKind::InvalidSnapshot,
            snapshot.scope.to_string(),
            "owner and trigger identities required",
        ));
    }
    let payload_schema = scope
        .commands
        .iter()
        .find(|c| c.key == snapshot.trigger.key)
        .map(|c| &c.payload_schema)
        .or_else(|| {
            scope
                .facts
                .iter()
                .find(|f| f.key == snapshot.trigger.key)
                .map(|f| &f.payload_schema)
        })
        .ok_or_else(|| {
            failure(
                DomainErrorKind::UndeclaredTrigger,
                snapshot.trigger.key.to_string(),
                "event belongs to another scope or is undeclared",
            )
        })?;
    validate_checked_value(&program.source, payload_schema, &snapshot.trigger.payload)?;
    let mut identities = BTreeSet::new();
    let mut roots = Vec::new();
    for observation in &snapshot.observations {
        if observation.identity == snapshot.owner.0
            || observation.identity.is_empty()
            || !identities.insert(&observation.identity)
            || roots.contains(&observation.root)
        {
            return Err(failure(
                DomainErrorKind::InvalidSnapshot,
                snapshot.owner.to_string(),
                "duplicate observed identity or root",
            ));
        }
        roots.push(observation.root.clone());
        let expected = match &observation.root {
            ReferenceRoot::Output { key } => scope
                .outputs
                .iter()
                .find(|x| x.key == *key)
                .map(|x| &x.schema),
            ReferenceRoot::Resource { key } => scope
                .resources
                .iter()
                .find(|x| x.key == *key)
                .map(|x| &x.schema),
            ReferenceRoot::Result { worker } => scope
                .workers
                .iter()
                .find(|x| x.key == *worker)
                .map(|x| &x.result_schema),
            ReferenceRoot::Child { key, export } => scope
                .children
                .iter()
                .find(|c| c.key == *key && c.imports.contains(export))
                .and_then(|c| program.source.scopes.iter().find(|s| s.key == c.scope))
                .and_then(|s| s.exports.iter().find(|e| e.key == *export))
                .map(|e| &e.schema),
            ReferenceRoot::OutputCollection { schema, .. }
            | ReferenceRoot::OutputRevisions { schema, .. }
            | ReferenceRoot::OutputRevision { schema, .. }
            | ReferenceRoot::OptionalOutputRevision { schema, .. }
            | ReferenceRoot::Children { schema, .. }
            | ReferenceRoot::ChildrenOutcomes { schema, .. }
            | ReferenceRoot::ChildrenComplete { schema, .. } => {
                workflow_compiler::validate_observation_root(
                    &program.source,
                    scope,
                    &observation.root,
                )?;
                Some(schema)
            }
            _ => None,
        }
        .ok_or_else(|| {
            failure(
                DomainErrorKind::PrivateRead,
                snapshot.owner.to_string(),
                "undeclared or private observed root",
            )
        })?;
        validate_checked_value(&program.source, expected, &observation.value)?;
    }
    Ok(())
}
pub fn evaluate(program: &CheckedProgram, snapshot: &Snapshot) -> CoreResult<DecisionOutcome> {
    snapshot_valid(program, snapshot)?;
    let (scope, checked) = owner(program, snapshot)?;
    let state = expressions::variant(&snapshot.state)?;
    let mut read_set = vec![ReadVersion {
        identity: snapshot.owner.0.clone(),
        version: snapshot.version,
    }];
    read_set.extend(snapshot.observations.iter().map(|o| ReadVersion {
        identity: o.identity.clone(),
        version: o.version,
    }));
    read_set.sort_by(|a, b| a.identity.cmp(&b.identity));
    let mut explanation = Explanation {
        bundle_digest: program.digest.clone(),
        owner: snapshot.owner.clone(),
        node_id: NodeId("".into()),
        trigger_id: snapshot.trigger.id.clone(),
        read_set,
        trace: Vec::new(),
    };
    if let Some(command) = scope
        .commands
        .iter()
        .find(|c| c.key == snapshot.trigger.key)
    {
        if !command.available_in.contains(&state) {
            return Err(failure(
                DomainErrorKind::UndeclaredTrigger,
                command.key.to_string(),
                "command unavailable in committed state",
            ));
        }
    }
    let mut budget = program.source.limits.evaluation_budget;
    let mut node = &checked.tree;
    loop {
        if budget == 0 {
            return Err(failure(
                DomainErrorKind::ResourceLimit,
                snapshot.owner.to_string(),
                "evaluation budget exhausted; no workflow transition",
            ));
        }
        budget -= 1;
        let id = match node {
            CheckedTree::Match { id, .. }
            | CheckedTree::If { id, .. }
            | CheckedTree::Apply { id, .. }
            | CheckedTree::Wait { id, .. }
            | CheckedTree::Reject { id, .. } => id,
        };
        explanation.node_id = id.clone();
        explanation.trace.push(id.0.clone());
        let mut context = expressions::EvaluationContext {
            program,
            snapshot,
            item: None,
            budget: &mut budget,
        };
        match node {
            CheckedTree::Match {
                value,
                cases,
                otherwise,
                ..
            } => {
                let value = expressions::evaluate_expression(value, &mut context)?;
                let choice = expressions::variant(&value)?;
                node = if let Some(case) = cases.iter().find(|c| c.variant == choice) {
                    &case.node
                } else {
                    otherwise.as_deref().ok_or_else(|| {
                        failure(
                            DomainErrorKind::InvalidSnapshot,
                            id.to_string(),
                            "checked match has no branch",
                        )
                    })?
                };
            }
            CheckedTree::If {
                condition,
                then,
                otherwise,
                ..
            } => {
                node = if expressions::boolean(&expressions::evaluate_expression(
                    condition,
                    &mut context,
                )?)? {
                    then
                } else {
                    otherwise
                };
            }
            CheckedTree::Wait {
                continuations,
                reason,
                attention,
                ..
            } => {
                return Ok(DecisionOutcome::Wait {
                    explanation,
                    continuations: continuations.clone(),
                    reason: reason.clone(),
                    attention: Some(attention.clone()),
                })
            }
            CheckedTree::Reject { error, detail, .. } => {
                return Ok(DecisionOutcome::Reject {
                    explanation,
                    error: error.clone(),
                    detail: detail.clone(),
                })
            }
            CheckedTree::Apply {
                mutations,
                actions,
                outcome,
                ..
            } => {
                let mut selected = Vec::new();
                for mutation in mutations {
                    selected.push(match mutation {
                        CheckedMutation::SetState { value } => MutationValue::SetState {
                            value: expressions::evaluate_expression(value, &mut context)?,
                        },
                        CheckedMutation::Export { key, value } => MutationValue::Export {
                            key: key.clone(),
                            value: expressions::evaluate_expression(value, &mut context)?,
                        },
                        CheckedMutation::ActivateChild { key } => {
                            let child =
                                checked.children.iter().find(|c| c.key == *key).ok_or_else(
                                    || {
                                        failure(
                                            DomainErrorKind::MissingSymbol,
                                            key.to_string(),
                                            "checked child missing",
                                        )
                                    },
                                )?;
                            if child.collection.is_some() {
                                selected.push(MutationValue::ActivateCollection {
                                    key: key.clone(),
                                    materialization: collections::materialize_with_budget(
                                        program,
                                        snapshot,
                                        key,
                                        context.budget,
                                    )?,
                                });
                                continue;
                            }
                            MutationValue::ActivateChild {
                                key: key.clone(),
                                input: expressions::evaluate_expression(
                                    &child.input,
                                    &mut context,
                                )?,
                            }
                        }
                        CheckedMutation::ClearOutput { key } => {
                            MutationValue::ClearOutput { key: key.clone() }
                        }
                        CheckedMutation::CancelChildren { key } => {
                            MutationValue::CancelChildren { key: key.clone() }
                        }
                        CheckedMutation::Acquire { pool } => {
                            MutationValue::Acquire { pool: pool.clone() }
                        }
                        CheckedMutation::Release { pool } => {
                            MutationValue::Release { pool: pool.clone() }
                        }
                        CheckedMutation::Revoke { worker } => MutationValue::Revoke {
                            worker: worker.clone(),
                        },
                        CheckedMutation::Stop { worker } => MutationValue::Stop {
                            worker: worker.clone(),
                        },
                        CheckedMutation::BindResource { key, value } => {
                            MutationValue::BindResource {
                                key: key.clone(),
                                value: expressions::evaluate_expression(value, &mut context)?,
                            }
                        }
                        CheckedMutation::ClearResource { key } => {
                            MutationValue::ClearResource { key: key.clone() }
                        }
                        CheckedMutation::Observe { resource } => MutationValue::Observe {
                            resource: resource.clone(),
                        },
                    });
                }
                let invocations = actions
                    .iter()
                    .map(|a| {
                        Ok(Invocation {
                            selection: a.selection.clone(),
                            definition: a.definition.clone(),
                            input: expressions::evaluate_expression(&a.input, &mut context)?,
                            prompt_content: a.prompt_content.clone(),
                        })
                    })
                    .collect::<CoreResult<_>>()?;
                let outcome = outcome
                    .as_ref()
                    .map(|e| expressions::evaluate_expression(e, &mut context))
                    .transpose()?;
                let targets = checked
                    .command_targets
                    .iter()
                    .find(|c| c.command == snapshot.trigger.key)
                    .map(|c| {
                        c.targets
                            .iter()
                            .map(|e| expressions::evaluate_expression(e, &mut context))
                            .collect::<CoreResult<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                if selected.len() == 1 && outcome.is_none() && actions.is_empty() {
                    if let MutationValue::SetState { value } = &selected[0] {
                        if *value == snapshot.state {
                            return Ok(DecisionOutcome::Wait {
                                explanation,
                                continuations: vec![snapshot.trigger.key.clone()],
                                reason: "unchanged state; awaiting a new trigger".into(),
                                attention: None,
                            });
                        }
                    }
                }
                if selected.is_empty() && outcome.is_none() && actions.is_empty() {
                    return Ok(DecisionOutcome::Wait {
                        explanation,
                        continuations: vec![snapshot.trigger.key.clone()],
                        reason: "mutation-free leaf; no commit required".into(),
                        attention: None,
                    });
                }
                return Ok(DecisionOutcome::Apply {
                    explanation,
                    mutations: selected,
                    invocations,
                    outcome,
                    targets,
                });
            }
        }
    }
}
