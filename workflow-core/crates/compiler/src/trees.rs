use crate::expressions::{boolean_schema, compatible, compile_expression, Context};
use crate::{check_value, error, unique, variants};
use std::collections::BTreeSet;
use workflow_model::*;
/// Write keys that name different mutations of one entity. Their host-side
/// effects do not commute, so one leaf may carry at most one of each pair:
/// activating a child while cancelling it, and binding or clearing a resource
/// while observing it (the observation reads the binding being rewritten).
fn opposing_field(field: &str) -> Option<String> {
    const PAIRS: [(&str, &str); 2] = [("child/", "cancel_child/"), ("resource/", "observe/")];
    PAIRS.iter().find_map(|(left, right)| {
        field
            .strip_prefix(left)
            .map(|key| format!("{right}{key}"))
            .or_else(|| field.strip_prefix(right).map(|key| format!("{left}{key}")))
    })
}
pub(crate) fn compile_tree(
    bundle: &DefinitionBundle,
    owner: &ScopeDefinition,
    tree: &DecisionTree,
    context: &Context,
    ids: &mut BTreeSet<NodeId>,
    depth: usize,
) -> CoreResult<CheckedTree> {
    if depth > bundle.limits.max_depth {
        return Err(error(
            DomainErrorKind::ResourceLimit,
            owner.key.to_string(),
            "tree exceeds nesting limit",
        ));
    }
    let id = match tree {
        DecisionTree::Match { id, .. }
        | DecisionTree::If { id, .. }
        | DecisionTree::Apply { id, .. }
        | DecisionTree::Wait { id, .. }
        | DecisionTree::Reject { id, .. } => id,
    };
    if id.0.is_empty() || !ids.insert(id.clone()) {
        return Err(error(
            DomainErrorKind::DuplicateSymbol,
            id.to_string(),
            "empty or duplicate node ID",
        ));
    }
    let expr = |e: &Expression| compile_expression(bundle, owner, e, context, depth + 1);
    Ok(match tree {
        DecisionTree::Match {
            id,
            value,
            cases,
            otherwise,
        } => {
            let checked = expr(value)?;
            let choices = variants(bundle, &checked.schema)?;
            unique(cases.iter().map(|c| c.variant.as_str()), &id.0)?;
            if cases.iter().any(|c| !choices.contains(&c.variant)) {
                return Err(error(
                    DomainErrorKind::UndeclaredTrigger,
                    id.to_string(),
                    "match case not in local declared finite variants",
                ));
            }
            if otherwise.is_none()
                && choices
                    .iter()
                    .any(|v| !cases.iter().any(|c| c.variant == *v))
            {
                return Err(error(
                    DomainErrorKind::NonExhaustiveMatch,
                    id.to_string(),
                    "finite match requires full coverage or explicit fallback",
                ));
            }
            let mut checked_cases = Vec::new();
            for case in cases {
                let mut narrowed = context.clone();
                if let Expression::Reference { root, path } = value {
                    narrowed
                        .guards
                        .push((root.clone(), path.clone(), case.variant.clone()));
                }
                checked_cases.push(CheckedCase {
                    variant: case.variant.clone(),
                    node: compile_tree(bundle, owner, &case.node, &narrowed, ids, depth + 1)?,
                });
            }
            let otherwise = otherwise
                .as_ref()
                .map(|n| compile_tree(bundle, owner, n, context, ids, depth + 1).map(Box::new))
                .transpose()?;
            CheckedTree::Match {
                id: id.clone(),
                value: checked,
                cases: checked_cases,
                otherwise,
            }
        }
        DecisionTree::If {
            id,
            condition,
            then,
            otherwise,
        } => {
            let condition = expr(condition)?;
            compatible(bundle, &boolean_schema(bundle)?, &condition.schema, &id.0)?;
            CheckedTree::If {
                id: id.clone(),
                condition,
                then: Box::new(compile_tree(bundle, owner, then, context, ids, depth + 1)?),
                otherwise: Box::new(compile_tree(
                    bundle,
                    owner,
                    otherwise,
                    context,
                    ids,
                    depth + 1,
                )?),
            }
        }
        DecisionTree::Apply {
            id,
            mutations,
            actions,
            outcome,
        } => {
            let mut writes = BTreeSet::new();
            let mut checked = Vec::new();
            for mutation in mutations {
                let (field, value) = match mutation {
                    Mutation::SetState { value } => {
                        let value = expr(value)?;
                        compatible(bundle, &owner.state_schema, &value.schema, &id.0).map_err(
                            |mut e| {
                                e.kind = DomainErrorKind::InvalidAssignment;
                                e
                            },
                        )?;
                        ("state".into(), CheckedMutation::SetState { value })
                    }
                    Mutation::Export { key, value } => {
                        let target =
                            owner
                                .exports
                                .iter()
                                .find(|e| e.key == *key)
                                .ok_or_else(|| {
                                    error(
                                        DomainErrorKind::MissingSymbol,
                                        key.to_string(),
                                        "export undeclared",
                                    )
                                })?;
                        let value = expr(value)?;
                        compatible(bundle, &target.schema, &value.schema, &id.0)?;
                        (
                            format!("export/{key}"),
                            CheckedMutation::Export {
                                key: key.clone(),
                                value,
                            },
                        )
                    }
                    Mutation::ActivateChild { key } => {
                        if !owner.children.iter().any(|c| c.key == *key) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                key.to_string(),
                                "child undeclared",
                            ));
                        }
                        (
                            format!("child/{key}"),
                            CheckedMutation::ActivateChild { key: key.clone() },
                        )
                    }
                    Mutation::ClearOutput { key } => {
                        if !owner.outputs.iter().any(|output| output.key == *key) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                key.to_string(),
                                "output clearing undeclared",
                            ));
                        }
                        (
                            format!("clear_output/{key}"),
                            CheckedMutation::ClearOutput { key: key.clone() },
                        )
                    }
                    Mutation::CancelChildren { key } => {
                        if !owner.children.iter().any(|child| child.key == *key) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                key.to_string(),
                                "child cancellation undeclared",
                            ));
                        }
                        (
                            format!("cancel_child/{key}"),
                            CheckedMutation::CancelChildren { key: key.clone() },
                        )
                    }
                    Mutation::Acquire { pool } | Mutation::Release { pool } => {
                        if !owner.pools.iter().any(|p| p.key == *pool) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                pool.to_string(),
                                "pool undeclared",
                            ));
                        }
                        (
                            format!("pool/{pool}"),
                            match mutation {
                                Mutation::Acquire { .. } => {
                                    CheckedMutation::Acquire { pool: pool.clone() }
                                }
                                _ => CheckedMutation::Release { pool: pool.clone() },
                            },
                        )
                    }
                    Mutation::Revoke { worker } | Mutation::Stop { worker } => {
                        if !owner.workers.iter().any(|w| w.key == *worker) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                worker.to_string(),
                                "worker undeclared",
                            ));
                        }
                        (
                            format!(
                                "{}/{worker}",
                                if matches!(mutation, Mutation::Revoke { .. }) {
                                    "revoke"
                                } else {
                                    "stop"
                                }
                            ),
                            match mutation {
                                Mutation::Revoke { .. } => CheckedMutation::Revoke {
                                    worker: worker.clone(),
                                },
                                _ => CheckedMutation::Stop {
                                    worker: worker.clone(),
                                },
                            },
                        )
                    }
                    Mutation::BindResource { key, value } => {
                        let target = owner
                            .resources
                            .iter()
                            .find(|resource| resource.key == *key)
                            .ok_or_else(|| {
                                error(
                                    DomainErrorKind::MissingSymbol,
                                    key.to_string(),
                                    "resource binding undeclared",
                                )
                            })?;
                        let value = expr(value)?;
                        compatible(bundle, &target.schema, &value.schema, &id.0)?;
                        (
                            format!("resource/{key}"),
                            CheckedMutation::BindResource {
                                key: key.clone(),
                                value,
                            },
                        )
                    }
                    Mutation::ClearResource { key } => {
                        if !owner.resources.iter().any(|resource| resource.key == *key) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                key.to_string(),
                                "resource clearing undeclared",
                            ));
                        }
                        (
                            format!("resource/{key}"),
                            CheckedMutation::ClearResource { key: key.clone() },
                        )
                    }
                    Mutation::Observe { resource } => {
                        if !owner.resources.iter().any(|r| r.key == *resource) {
                            return Err(error(
                                DomainErrorKind::MissingSymbol,
                                resource.to_string(),
                                "resource undeclared",
                            ));
                        }
                        (
                            format!("observe/{resource}"),
                            CheckedMutation::Observe {
                                resource: resource.clone(),
                            },
                        )
                    }
                };
                if writes.contains(&field) {
                    return Err(error(
                        DomainErrorKind::ConflictingWrite,
                        id.to_string(),
                        "leaf writes the same owned field twice",
                    ));
                }
                if let Some(opposed) = opposing_field(&field) {
                    if writes.contains(&opposed) {
                        return Err(error(
                            DomainErrorKind::ConflictingWrite,
                            id.to_string(),
                            format!("leaf mutates {field} and {opposed}; the outcome would depend on host mutation order"),
                        ));
                    }
                }
                writes.insert(field);
                checked.push(value);
            }
            let mut launches = BTreeSet::new();
            let mut checked_actions = Vec::new();
            for selection in actions {
                let worker = owner
                    .workers
                    .iter()
                    .find(|w| w.key == selection.worker)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::MissingSymbol,
                            selection.worker.to_string(),
                            "worker undeclared",
                        )
                    })?;
                if !launches.insert(worker.key.clone()) && worker.exclusive {
                    return Err(error(
                        DomainErrorKind::DuplicateLaunch,
                        id.to_string(),
                        "duplicate exclusive worker selection",
                    ));
                }
                if mutations.iter().any(|m|matches!(m,Mutation::Revoke{worker:w}|Mutation::Stop{worker:w} if w==&worker.key)){return Err(error(DomainErrorKind::DuplicateLaunch,id.to_string(),"launch conflicts with revoke or stop"));}
                let action = worker
                    .actions
                    .iter()
                    .find(|a| a.key == selection.action)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::MissingSymbol,
                            selection.action.to_string(),
                            "action undeclared",
                        )
                    })?;
                let input = expr(&action.input)?;
                compatible(bundle, &action.input_schema, &input.schema, &id.0)?;
                checked_actions.push(CheckedAction {
                    selection: selection.clone(),
                    definition: action.into(),
                    input,
                    prompt_key: action.prompt.clone(),
                });
            }
            let outcome = outcome
                .as_ref()
                .map(|e| {
                    let value = expr(e)?;
                    compatible(bundle, &owner.outcome_schema, &value.schema, &id.0).map_err(
                        |mut e| {
                            e.kind = DomainErrorKind::InvalidAssignment;
                            e
                        },
                    )?;
                    Ok(value)
                })
                .transpose()?;
            CheckedTree::Apply {
                id: id.clone(),
                mutations: checked,
                actions: checked_actions,
                outcome,
            }
        }
        DecisionTree::Wait {
            id,
            continuations,
            reason,
            attention,
        } => {
            unique(continuations.iter().map(|c| c.0.as_str()), &id.0)?;
            if reason.is_empty() || continuations.is_empty() {
                return Err(error(
                    DomainErrorKind::DeadRegion,
                    id.to_string(),
                    "nonterminal wait requires a declared continuation",
                ));
            }
            if continuations.iter().any(|k| {
                !owner.commands.iter().any(|c| c.key == *k)
                    && !owner.facts.iter().any(|f| f.key == *k)
            }) {
                return Err(error(
                    DomainErrorKind::UndeclaredTrigger,
                    id.to_string(),
                    "wait continuation undeclared",
                ));
            }
            if attention.label.trim().is_empty() {
                return Err(error(
                    DomainErrorKind::MissingBinding,
                    id.to_string(),
                    "wait attention label is required",
                ));
            }
            if !continuations.contains(&attention.trigger) {
                return Err(error(
                    DomainErrorKind::UndeclaredTrigger,
                    id.to_string(),
                    "wait attention trigger must be a declared continuation",
                ));
            }
            CheckedTree::Wait {
                id: id.clone(),
                continuations: continuations.clone(),
                reason: reason.clone(),
                attention: attention.clone(),
            }
        }
        DecisionTree::Reject {
            id,
            error: key,
            detail,
        } => {
            let declaration = owner.errors.iter().find(|e| e.key == *key).ok_or_else(|| {
                error(
                    DomainErrorKind::MissingSymbol,
                    key.to_string(),
                    "rejection error is not declared",
                )
            })?;
            let detail = check_value(bundle, &declaration.payload_schema, detail)?;
            CheckedTree::Reject {
                id: id.clone(),
                error: key.clone(),
                detail,
            }
        }
    })
}
