use std::collections::HashSet;
use workflow_compiler::{binding_value, compile, validate_payload};
use workflow_model::{
    CoreResult, Decision, DecisionOutcome, DefinitionBundle, DomainError, DomainErrorKind, Effect,
    Expression, Observation, Policy, Release, Snapshot,
};

fn expression_value(
    expression: &Expression,
    bundle: &DefinitionBundle,
    snapshot: &Snapshot,
) -> CoreResult<bool> {
    match expression {
        Expression::Fact { name } => Ok(snapshot.facts.contains(name)),
        Expression::Equals { binding, value } => {
            let declaration = bundle
                .bindings
                .iter()
                .find(|item| item.id == *binding)
                .ok_or_else(|| {
                    DomainError::new(
                        "evaluate",
                        binding,
                        DomainErrorKind::UnknownBinding,
                        "binding was not compiled",
                    )
                })?;
            Ok(binding_value(&snapshot.values, declaration)? == value)
        }
        Expression::All { items } => {
            for item in items {
                if !expression_value(item, bundle, snapshot)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Expression::Any { items } => {
            for item in items {
                if expression_value(item, bundle, snapshot)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Expression::Not { item } => Ok(!expression_value(item, bundle, snapshot)?),
    }
}

pub fn evaluate(bundle: &DefinitionBundle, snapshot: &Snapshot) -> CoreResult<DecisionOutcome> {
    compile(bundle)?;
    let mut trace = vec![format!("bundle:{}@{}", bundle.id, bundle.version)];
    let mut node = &bundle.decision;
    loop {
        match node {
            Decision::If {
                expression,
                then,
                otherwise,
            } => {
                let answer = expression_value(expression, bundle, snapshot)?;
                trace.push(format!("if:{answer}"));
                node = if answer { then } else { otherwise };
            }
            Decision::Apply {
                scope,
                state,
                action,
            } => {
                trace.push(format!("apply:{scope}:{state}:{action}"));
                return Ok(DecisionOutcome {
                    effect: Effect::Apply {
                        scope: scope.clone(),
                        state: state.clone(),
                        action: action.clone(),
                    },
                    trace,
                });
            }
            Decision::Wait { reason } => {
                trace.push(format!("wait:{reason}"));
                return Ok(DecisionOutcome {
                    effect: Effect::Wait {
                        reason: reason.clone(),
                    },
                    trace,
                });
            }
            Decision::Reject { reason } => {
                trace.push(format!("reject:{reason}"));
                return Ok(DecisionOutcome {
                    effect: Effect::Reject {
                        reason: reason.clone(),
                    },
                    trace,
                });
            }
        }
    }
}

fn policy_for<'a>(bundle: &'a DefinitionBundle, collection: &str) -> Option<&'a Policy> {
    bundle
        .policies
        .iter()
        .find(|policy| policy.collection == collection)
}

pub fn materialize(
    bundle: &DefinitionBundle,
    collection_id: &str,
    observations: &[Observation],
) -> CoreResult<Vec<String>> {
    compile(bundle)?;
    let collection = bundle
        .collections
        .iter()
        .find(|item| item.id == collection_id)
        .ok_or_else(|| {
            DomainError::new(
                "materialize",
                collection_id,
                DomainErrorKind::UnknownCollection,
                "collection not declared",
            )
        })?;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for observation in observations
        .iter()
        .filter(|item| item.collection == collection_id)
    {
        if observation.item_id.is_empty() || !seen.insert(&observation.item_id) {
            return Err(DomainError::new(
                "materialize",
                collection_id,
                DomainErrorKind::InvalidShape,
                "empty or duplicate item id",
            ));
        }
        validate_payload(bundle, collection_id, &observation.payload)?;
        let is_released = match policy_for(bundle, collection_id).map(|policy| &policy.release) {
            None | Some(Release::Immediate) => true,
            Some(Release::Accepted | Release::Complete) => observation.accepted,
        };
        if is_released {
            ids.push(observation.item_id.clone());
        }
    }
    if collection.required && ids.is_empty() {
        return Err(DomainError::new(
            "materialize",
            collection_id,
            DomainErrorKind::MissingObservation,
            "required collection has no released items",
        ));
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bundle() -> DefinitionBundle {
        serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap()
    }

    fn snapshot(approved: bool) -> Snapshot {
        Snapshot {
            facts: vec![],
            values: json!({ "approved": approved }),
            observations: vec![],
            timestamp_ms: 42,
            random_seed: 7,
        }
    }

    #[test]
    fn same_snapshot_replays_same_decision() {
        let definition = bundle();
        let first = evaluate(&definition, &snapshot(true)).unwrap();
        let second = evaluate(&definition, &snapshot(true)).unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(second).unwrap()
        );
    }

    #[test]
    fn false_binding_waits() {
        let outcome = evaluate(&bundle(), &snapshot(false)).unwrap();
        assert!(matches!(outcome.effect, Effect::Wait { .. }));
    }

    #[test]
    fn collection_policy_releases_only_accepted_items() {
        let observations = vec![
            Observation {
                collection: "evidence".into(),
                item_id: "first".into(),
                payload: json!({}),
                accepted: true,
            },
            Observation {
                collection: "evidence".into(),
                item_id: "second".into(),
                payload: json!({}),
                accepted: false,
            },
        ];
        assert_eq!(
            materialize(&bundle(), "evidence", &observations).unwrap(),
            vec!["first"]
        );
    }
}
