//! Conservative finite state/event analysis. Payload conditions produce both possible edges.
use crate::{error, variants};
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;
pub(crate) fn variant(value: &CheckedValue) -> Option<String> {
    match &value.data {
        CheckedData::Variant { variant, .. } | CheckedData::Enum { variant } => {
            Some(variant.clone())
        }
        CheckedData::Optional { value } => {
            Some(if value.is_some() { "some" } else { "none" }.into())
        }
        CheckedData::Boolean { value } => Some(value.to_string()),
        _ => None,
    }
}
fn expression_variant(e: &CheckedExpression, state: &str, trigger: &str) -> Option<String> {
    match &e.node {
        CheckedExpressionNode::Literal { value } => variant(value),
        CheckedExpressionNode::Variant { variant, .. } => Some(variant.clone()),
        CheckedExpressionNode::Reference {
            root: ReferenceRoot::State,
            selectors,
        } if selectors.is_empty() => Some(state.into()),
        CheckedExpressionNode::Reference {
            root: ReferenceRoot::Trigger,
            selectors,
        } if selectors.is_empty() => Some(trigger.into()),
        _ => None,
    }
}
fn condition(e: &CheckedExpression, state: &str, trigger: &str) -> Option<bool> {
    match &e.node {
        CheckedExpressionNode::Literal {
            value:
                CheckedValue {
                    data: CheckedData::Boolean { value },
                    ..
                },
        } => Some(*value),
        CheckedExpressionNode::IsVariant { value, variant } => {
            expression_variant(value, state, trigger).map(|v| v == *variant)
        }
        CheckedExpressionNode::Not { value } => condition(value, state, trigger).map(|v| !v),
        _ => None,
    }
}
fn leaves<'a>(
    tree: &'a CheckedTree,
    state: &str,
    trigger: &str,
    result: &mut Vec<&'a CheckedTree>,
) {
    match tree {
        CheckedTree::Match {
            value,
            cases,
            otherwise,
            ..
        } => {
            if let Some(v) = expression_variant(value, state, trigger) {
                if let Some(case) = cases.iter().find(|c| c.variant == v) {
                    leaves(&case.node, state, trigger, result);
                } else if let Some(n) = otherwise {
                    leaves(n, state, trigger, result);
                }
            } else {
                for c in cases {
                    leaves(&c.node, state, trigger, result);
                }
                if let Some(n) = otherwise {
                    leaves(n, state, trigger, result);
                }
            }
        }
        CheckedTree::If {
            condition: expr,
            then,
            otherwise,
            ..
        } => match condition(expr, state, trigger) {
            Some(true) => leaves(then, state, trigger, result),
            Some(false) => leaves(otherwise, state, trigger, result),
            None => {
                leaves(then, state, trigger, result);
                leaves(otherwise, state, trigger, result);
            }
        },
        _ => result.push(tree),
    }
}
pub fn analyze(
    bundle: &DefinitionBundle,
    owner: &ScopeDefinition,
    tree: &CheckedTree,
) -> CoreResult<ScopeAnalysis> {
    let states = variants(bundle, &owner.state_schema)?;
    let outcomes = variants(bundle, &owner.outcome_schema)?;
    let initial = crate::check_value(bundle, &owner.state_schema, &owner.initial)?;
    let initial = variant(&initial).ok_or_else(|| {
        error(
            DomainErrorKind::InvalidAssignment,
            owner.key.to_string(),
            "initial value must be a finite variant",
        )
    })?;
    let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut terminal = BTreeSet::new();
    let mut selected: BTreeMap<String, Vec<ActionSelection>> = BTreeMap::new();
    let mut exported: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for state in &states {
        let triggers: Vec<_> = owner
            .facts
            .iter()
            .map(|f| f.key.0.as_str())
            .chain(
                owner
                    .commands
                    .iter()
                    .filter(|c| c.available_in.contains(state))
                    .map(|c| c.key.0.as_str()),
            )
            .collect();
        for trigger in triggers {
            let mut possible = Vec::new();
            leaves(tree, state, trigger, &mut possible);
            let command = owner
                .commands
                .iter()
                .find(|c| c.key.0 == trigger && c.required);
            if command.is_some()
                && possible
                    .iter()
                    .all(|leaf| matches!(leaf, CheckedTree::Reject { .. }))
            {
                return Err(error(
                    DomainErrorKind::UnhandledCommand,
                    format!("{}/{state}/{trigger}", owner.key),
                    "required available command has no handling path",
                ));
            }
            for leaf in possible {
                if let CheckedTree::Apply {
                    mutations,
                    actions,
                    outcome,
                    ..
                } = leaf
                {
                    selected
                        .entry(state.clone())
                        .or_default()
                        .extend(actions.iter().map(|a| a.selection.clone()));
                    let mut next = state.clone();
                    for mutation in mutations {
                        if let CheckedMutation::SetState { value } = mutation {
                            let Some(v) = expression_variant(value, state, trigger) else {
                                return Err(error(
                                    DomainErrorKind::InvalidAssignment,
                                    owner.key.to_string(),
                                    "state variant selection must be structurally identifiable",
                                ));
                            };
                            next = v;
                        }
                    }
                    if let Some(value) = outcome {
                        let Some(v) = expression_variant(value, state, trigger) else {
                            return Err(error(
                                DomainErrorKind::InvalidAssignment,
                                owner.key.to_string(),
                                "terminal outcome must have a structurally identifiable variant",
                            ));
                        };
                        terminal.insert(state.clone());
                        exported.entry(state.clone()).or_default().insert(v);
                    } else {
                        edges.entry(state.clone()).or_default().insert(next);
                    }
                }
            }
        }
    }
    let mut reached = BTreeSet::from([initial]);
    loop {
        let expanded: Vec<_> = reached
            .iter()
            .flat_map(|s| edges.get(s).into_iter().flatten().cloned())
            .collect();
        let before = reached.len();
        reached.extend(expanded);
        if before == reached.len() {
            break;
        }
    }
    if states.iter().any(|s| !reached.contains(s)) {
        return Err(error(
            DomainErrorKind::UnreachableDeclaration,
            owner.key.to_string(),
            "declared state is structurally unreachable",
        ));
    }
    let mut actions: Vec<_> = reached
        .iter()
        .flat_map(|s| selected.get(s).into_iter().flatten().cloned())
        .collect();
    actions
        .sort_by(|left, right| (&left.worker, &left.action).cmp(&(&right.worker, &right.action)));
    actions.dedup_by(|left, right| left.worker == right.worker && left.action == right.action);
    if owner.workers.iter().any(|w| {
        w.actions.iter().any(|a| {
            !actions
                .iter()
                .any(|s| s.worker == w.key && s.action == a.key)
        })
    }) {
        return Err(error(
            DomainErrorKind::UnreachableDeclaration,
            owner.key.to_string(),
            "declared action is structurally unreachable",
        ));
    }
    let seen_outcomes: BTreeSet<_> = reached
        .iter()
        .flat_map(|s| exported.get(s).into_iter().flatten().cloned())
        .collect();
    if outcomes.iter().any(|v| !seen_outcomes.contains(v)) {
        return Err(error(
            DomainErrorKind::UnreachableDeclaration,
            owner.key.to_string(),
            "declared outcome is structurally unreachable",
        ));
    }
    let mut live = terminal;
    loop {
        let before = live.len();
        for state in &states {
            if edges
                .get(state)
                .is_some_and(|e| e.iter().any(|n| live.contains(n)))
            {
                live.insert(state.clone());
            }
        }
        if live.len() == before {
            break;
        }
    }
    if reached.iter().any(|s| !live.contains(s)) {
        return Err(error(
            DomainErrorKind::DeadRegion,
            owner.key.to_string(),
            "closed nonterminal control-flow region has no structural outcome route",
        ));
    }
    let reachable_states = BTreeSet::from_iter(reached).into_iter().collect();
    let outcomes = BTreeSet::from_iter(seen_outcomes).into_iter().collect();
    Ok(ScopeAnalysis {
        scope: owner.key.clone(),
        reachable_states,
        actions,
        outcomes,
    })
}
