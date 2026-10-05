use serde_json::{json, Value};
use workflow_compiler::{check_value, compile};
use workflow_evaluator::{evaluate, materialize};
use workflow_model::*;
fn bundle(name: &str) -> DefinitionBundle {
    let text = match name {
        "minimal" => include_str!("../../../fixtures/bundles/minimal.json"),
        "1" => include_str!("../../../fixtures/bundles/children-1.json"),
        "5" => include_str!("../../../fixtures/bundles/children-5.json"),
        "6" => include_str!("../../../fixtures/bundles/children-6.json"),
        "7" => include_str!("../../../fixtures/bundles/children-7.json"),
        "dynamic" => include_str!("../../../fixtures/bundles/dynamic.json"),
        _ => panic!("unknown fixture"),
    };
    serde_json::from_str(text).unwrap()
}
fn snapshot(b: &DefinitionBundle, input: Value, state: &str, trigger: &str) -> Snapshot {
    let owner = &b.scopes[0];
    Snapshot {
        owner: InstanceId::from("instance"),
        scope: owner.key.clone(),
        version: 9,
        input: check_value(b, &owner.input_schema, &input).unwrap(),
        state: check_value(b, &owner.state_schema, &json!({"kind":state,"value":{}})).unwrap(),
        trigger: Trigger {
            id: TriggerId::from("command-1"),
            key: SymbolKey::from(trigger),
            payload: check_value(b, &SchemaId::from("unit"), &json!({})).unwrap(),
        },
        observations: vec![],
        timestamp_ms: 42,
        random_seed: 7,
    }
}
#[test]
fn same_snapshot_replays_byte_identical_decision() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(&b, json!({}), "ready", "begin");
    assert_eq!(
        serde_json::to_vec(&evaluate(&p, &s).unwrap()).unwrap(),
        serde_json::to_vec(&evaluate(&p, &s).unwrap()).unwrap()
    );
}
#[test]
fn action_inputs_use_predecision_snapshot_and_freeze_prompt() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(&b, json!({}), "ready", "begin");
    let DecisionOutcome::Apply { invocations, .. } = evaluate(&p, &s).unwrap() else {
        panic!("expected apply")
    };
    assert_eq!(invocations[0].input, s.input);
}
#[test]
fn explanation_includes_exact_observation_versions() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "ready", "begin");
    s.observations.push(VersionedValue {
        identity: "resource-binding".into(),
        version: 3,
        root: ReferenceRoot::Resource {
            key: SymbolKey::from("source"),
        },
        value: check_value(
            &b,
            &SchemaId::from("resource"),
            &json!({"brand":"resource","id":"r"}),
        )
        .unwrap(),
    });
    let DecisionOutcome::Apply { explanation, .. } = evaluate(&p, &s).unwrap() else {
        panic!("expected apply")
    };
    assert_eq!(
        explanation.read_set,
        vec![
            ReadVersion {
                identity: "instance".into(),
                version: 9
            },
            ReadVersion {
                identity: "resource-binding".into(),
                version: 3
            }
        ]
    );
}
#[test]
fn command_is_rejected_outside_seen_state() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    assert_eq!(
        evaluate(&p, &snapshot(&b, json!({}), "ready", "publish"))
            .unwrap_err()
            .kind,
        DomainErrorKind::UndeclaredTrigger
    );
}
#[test]
fn forged_checked_payload_is_rejected() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "ready", "begin");
    s.input.data = CheckedData::Boolean { value: true };
    assert_eq!(
        evaluate(&p, &s).unwrap_err().kind,
        DomainErrorKind::InvalidSnapshot
    );
}
#[test]
fn same_engine_creates_one_five_six_and_seven_children() {
    for count in [1, 5, 6, 7] {
        let b = bundle(&count.to_string());
        let p = compile(&b, &b.operations).unwrap();
        let DecisionOutcome::Apply { mutations, .. } =
            evaluate(&p, &snapshot(&b, json!({}), "ready", "begin")).unwrap()
        else {
            panic!("expected apply")
        };
        assert_eq!(
            mutations
                .iter()
                .filter(|m| matches!(m, MutationValue::ActivateChild { .. }))
                .count(),
            count
        );
    }
}
#[test]
fn parent_consumes_declared_exports_only() {
    let b = bundle("5");
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "waiting", "publish");
    for child in &b.scopes[0].children {
        s.observations.push(VersionedValue {
            identity: child.key.0.clone(),
            version: 1,
            root: ReferenceRoot::Child {
                key: child.key.clone(),
                export: SymbolKey::from("released"),
            },
            value: check_value(&b, &SchemaId::from("flag"), &json!(true)).unwrap(),
        });
    }
    assert!(matches!(
        evaluate(&p, &s).unwrap(),
        DecisionOutcome::Apply {
            outcome: Some(_),
            ..
        }
    ));
}
#[test]
fn unready_child_export_selects_configured_wait() {
    let b = bundle("1");
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "waiting", "publish");
    s.observations.push(VersionedValue {
        identity: "child".into(),
        version: 1,
        root: ReferenceRoot::Child {
            key: SymbolKey::from("item_0"),
            export: SymbolKey::from("released"),
        },
        value: check_value(&b, &SchemaId::from("flag"), &json!(false)).unwrap(),
    });
    assert!(matches!(
        evaluate(&p, &s).unwrap(),
        DecisionOutcome::Wait { .. }
    ));
}
#[test]
fn independent_sibling_policy_is_configuration() {
    let mut b = bundle("1");
    let DecisionTree::Match { cases, .. } = &mut b.scopes[0].tree else {
        panic!()
    };
    let DecisionTree::If { otherwise, .. } = &mut cases[1].node else {
        panic!()
    };
    **otherwise = DecisionTree::Apply {
        id: NodeId::from("continue"),
        mutations: vec![],
        actions: vec![],
        outcome: Some(Expression::Literal {
            schema: SchemaId::from("result"),
            value: json!({"kind":"withdrawn","value":{}}),
        }),
    };
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "waiting", "publish");
    s.observations.push(VersionedValue {
        identity: "child".into(),
        version: 1,
        root: ReferenceRoot::Child {
            key: SymbolKey::from("item_0"),
            export: SymbolKey::from("released"),
        },
        value: check_value(&b, &SchemaId::from("flag"), &json!(false)).unwrap(),
    });
    assert!(matches!(
        evaluate(&p, &s).unwrap(),
        DecisionOutcome::Apply {
            outcome: Some(_),
            ..
        }
    ));
}
#[test]
fn capacity_one_four_eight_uses_identical_constructs() {
    for limit in [1, 4, 8] {
        let mut b = bundle("minimal");
        b.scopes[0].pools[0].limit = limit;
        let p = compile(&b, &b.operations).unwrap();
        assert!(matches!(
            evaluate(&p, &snapshot(&b, json!({}), "ready", "begin")).unwrap(),
            DecisionOutcome::Apply { .. }
        ));
    }
}
#[test]
fn publication_revocation_and_stop_are_separate_mutations() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let DecisionOutcome::Apply { mutations, .. } =
        evaluate(&p, &snapshot(&b, json!({}), "ready", "cancel")).unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        mutations.as_slice(),
        [MutationValue::Revoke { .. }, MutationValue::Stop { .. }]
    ));
}
#[test]
fn dynamic_collection_materializes_whole_dependency_graph() {
    let b = bundle("dynamic");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(
        &b,
        json!([{"key":"first","input":{},"dependencies":[]},{"key":"second","input":{},"dependencies":["first"]}]),
        "ready",
        "begin",
    );
    assert_eq!(
        materialize(&p, &s, &SymbolKey::from("items"))
            .unwrap()
            .children[1]
            .depends_on,
        vec!["first"]
    );
}
#[test]
fn invalid_dynamic_dependency_returns_no_partial_batch() {
    let b = bundle("dynamic");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(
        &b,
        json!([{"key":"first","input":{},"dependencies":[]},{"key":"second","input":{},"dependencies":["missing"]}]),
        "ready",
        "begin",
    );
    assert_eq!(
        materialize(&p, &s, &SymbolKey::from("items"))
            .unwrap_err()
            .kind,
        DomainErrorKind::InvalidTemplate
    );
}
#[test]
fn dynamic_cycle_is_rejected() {
    let b = bundle("dynamic");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(
        &b,
        json!([{"key":"first","input":{},"dependencies":["second"]},{"key":"second","input":{},"dependencies":["first"]}]),
        "ready",
        "begin",
    );
    assert_eq!(
        materialize(&p, &s, &SymbolKey::from("items"))
            .unwrap_err()
            .kind,
        DomainErrorKind::CyclicPrerequisite
    );
}
#[test]
fn empty_collection_uses_declared_outcome() {
    let b = bundle("dynamic");
    let p = compile(&b, &b.operations).unwrap();
    assert!(materialize(
        &p,
        &snapshot(&b, json!([]), "ready", "begin"),
        &SymbolKey::from("items")
    )
    .unwrap()
    .empty_outcome
    .is_some());
}
#[test]
fn bounded_evaluation_reports_engine_error() {
    let mut b = bundle("minimal");
    b.limits.evaluation_budget = 1;
    let p = compile(&b, &b.operations).unwrap();
    assert_eq!(
        evaluate(&p, &snapshot(&b, json!({}), "ready", "begin"))
            .unwrap_err()
            .kind,
        DomainErrorKind::ResourceLimit
    );
}

#[test]
fn optional_payload_is_bound_only_inside_presence_match() {
    let mut b = bundle("minimal");
    b.scopes[0].input_schema = SchemaId::from("optional_unit");
    b.scopes[0].workers[0].actions[0].input = Expression::Reference {
        root: ReferenceRoot::Input,
        path: vec![],
    };
    let DecisionTree::Match { cases, .. } = &mut b.scopes[0].tree else {
        panic!("event match");
    };
    let apply = cases[0].node.clone();
    cases[0].node = DecisionTree::Match {
        id: NodeId::from("presence"),
        value: Expression::Reference {
            root: ReferenceRoot::Input,
            path: vec![],
        },
        cases: vec![
            MatchCase {
                variant: "some".into(),
                node: apply,
            },
            MatchCase {
                variant: "none".into(),
                node: DecisionTree::Wait {
                    id: NodeId::from("missing_input"),
                    continuations: vec![SymbolKey::from("cancel")],
                    reason: "input absent".into(),
                },
            },
        ],
        otherwise: None,
    };
    let p = compile(&b, &b.operations).unwrap();
    let DecisionOutcome::Apply { invocations, .. } =
        evaluate(&p, &snapshot(&b, json!({}), "ready", "begin")).unwrap()
    else {
        panic!("presence should bind");
    };
    assert_eq!(invocations[0].input.schema, SchemaId::from("unit"));
    assert!(matches!(
        evaluate(&p, &snapshot(&b, json!(null), "ready", "begin")).unwrap(),
        DecisionOutcome::Wait { .. }
    ));
}
#[test]
fn state_worker_and_command_names_are_configuration_only() {
    let value = serde_json::to_value(bundle("minimal")).unwrap();
    fn rename(value: Value) -> Value {
        match value {
            Value::String(s) => Value::String(
                match s.as_str() {
                    "ready" => "new_private_state",
                    "waiting" => "reviewing_private_state",
                    "author" => "independent_worker",
                    "begin" => "custom_command",
                    _ => &s,
                }
                .to_owned(),
            ),
            Value::Array(items) => Value::Array(items.into_iter().map(rename).collect()),
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key, rename(value)))
                    .collect(),
            ),
            scalar => scalar,
        }
    }
    let b: DefinitionBundle = serde_json::from_value(rename(value)).unwrap();
    let p = compile(&b, &b.operations).unwrap();
    assert!(matches!(
        evaluate(
            &p,
            &snapshot(&b, json!({}), "new_private_state", "custom_command")
        )
        .unwrap(),
        DecisionOutcome::Apply { .. }
    ));
}

#[test]
fn optional_record_field_is_matched_before_required_binding() {
    let mut b = bundle("minimal");
    b.schemas.push(Schema {
        key: SchemaId::from("optional_record"),
        shape: SchemaShape::Record {
            fields: vec![SchemaField {
                key: "entry".into(),
                schema: SchemaId::from("unit"),
                required: false,
            }],
            dictionary: None,
        },
    });
    b.scopes[0].input_schema = SchemaId::from("optional_record");
    b.scopes[0].workers[0].actions[0].input = Expression::Reference {
        root: ReferenceRoot::Input,
        path: vec!["entry".into()],
    };
    let DecisionTree::Match { cases, .. } = &mut b.scopes[0].tree else {
        panic!("event match");
    };
    let apply = cases[0].node.clone();
    cases[0].node = DecisionTree::Match {
        id: NodeId::from("field_presence"),
        value: Expression::Reference {
            root: ReferenceRoot::Input,
            path: vec!["entry".into()],
        },
        cases: vec![MatchCase {
            variant: "some".into(),
            node: apply,
        }],
        otherwise: Some(Box::new(DecisionTree::Wait {
            id: NodeId::from("absent_field"),
            continuations: vec![SymbolKey::from("cancel")],
            reason: "missing entry".into(),
        })),
    };
    let p = compile(&b, &b.operations).unwrap();
    assert!(matches!(
        evaluate(&p, &snapshot(&b, json!({}), "ready", "begin")).unwrap(),
        DecisionOutcome::Wait { .. }
    ));
    let DecisionOutcome::Apply { invocations, .. } =
        evaluate(&p, &snapshot(&b, json!({"entry":{}}), "ready", "begin")).unwrap()
    else {
        panic!("expected present binding");
    };
    assert_eq!(invocations[0].input.schema, SchemaId::from("unit"));
}
