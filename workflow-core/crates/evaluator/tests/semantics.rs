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
        "revision-loop" => include_str!("../../../fixtures/bundles/revision-loop.json"),
        "exact-review-target" => include_str!("../../../fixtures/bundles/exact-review-target.json"),
        "held-reservation" => include_str!("../../../fixtures/bundles/held-reservation.json"),
        "terminal-replacement" => {
            include_str!("../../../fixtures/bundles/terminal-replacement.json")
        }
        "publication-pair" => include_str!("../../../fixtures/bundles/publication-pair.json"),
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
fn native_snapshot_metadata_is_checked_before_evaluation() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    for field in [
        "version",
        "random_seed",
        "timestamp_ms",
        "observation_version",
    ] {
        let mut s = snapshot(&b, json!({}), "ready", "begin");
        match field {
            "version" => s.version = u64::MAX,
            "random_seed" => s.random_seed = u64::MAX,
            "timestamp_ms" => s.timestamp_ms = i64::MIN,
            _ => s.observations.push(VersionedValue {
                identity: "output".into(),
                version: u64::MAX,
                root: ReferenceRoot::Output {
                    key: SymbolKey::from("document"),
                },
                value: s.input.clone(),
            }),
        }
        assert_eq!(
            evaluate(&p, &s).unwrap_err().kind,
            DomainErrorKind::InvalidSnapshot,
            "{field}"
        );
    }
}
#[test]
fn action_inputs_use_predecision_snapshot_and_pinned_prompt_key() {
    let b = bundle("minimal");
    let p = compile(&b, &b.operations).unwrap();
    let s = snapshot(&b, json!({}), "ready", "begin");
    let DecisionOutcome::Apply { invocations, .. } = evaluate(&p, &s).unwrap() else {
        panic!("expected apply")
    };
    assert_eq!(invocations[0].input, s.input);
    assert_eq!(
        invocations[0].prompt_key,
        Some(SymbolKey::from("shared_content"))
    );
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
    let DecisionOutcome::Wait { attention, .. } = evaluate(&p, &s).unwrap() else {
        panic!("expected configured wait")
    };
    let attention = attention.expect("Sec 4.5 Wait attention reaches the caller");
    assert_eq!(attention.label, "Awaiting input");
    assert_eq!(attention.trigger, SymbolKey::from("publish"));
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
fn repeated_unchanged_assignments_wait_without_committing() {
    let b = bundle("minimal");
    let mut p = compile(&b, &b.operations).unwrap();
    let CheckedTree::Match { cases, .. } = &mut p.scopes[0].tree else {
        panic!("dispatch match")
    };
    let CheckedTree::Apply {
        mutations,
        actions,
        outcome,
        ..
    } = &mut cases[0].node
    else {
        panic!("begin apply")
    };
    let unchanged = CheckedMutation::SetState {
        value: CheckedExpression {
            schema: SchemaId::from("position"),
            node: CheckedExpressionNode::Reference {
                root: ReferenceRoot::State,
                selectors: vec![],
            },
        },
    };
    *mutations = vec![unchanged.clone(), unchanged];
    actions.clear();
    *outcome = None;
    let result = evaluate(&p, &snapshot(&b, json!({}), "ready", "begin")).unwrap();
    assert!(matches!(result, DecisionOutcome::Wait { .. }), "{result:?}");
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
                    attention: AttentionMetadata {
                        label: "Awaiting input".into(),
                        trigger: SymbolKey::from("cancel"),
                    },
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
            attention: AttentionMetadata {
                label: "Awaiting input".into(),
                trigger: SymbolKey::from("cancel"),
            },
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

#[test]
fn revision_restarts_inside_the_same_scope_without_child_activation() {
    let b = bundle("revision-loop");
    let p = compile(&b, &b.operations).unwrap();
    assert!(b.scopes[0].children.is_empty());
    for (phase, command, next) in [
        ("unlit", "light", "firing"),
        ("firing", "inspect", "inspection"),
        ("inspection", "rework", "firing"),
    ] {
        let DecisionOutcome::Apply { mutations, .. } =
            evaluate(&p, &snapshot(&b, json!({}), phase, command)).unwrap()
        else {
            panic!("expected state transition")
        };
        assert!(mutations.iter().any(|mutation| matches!(mutation,
            MutationValue::SetState { value } if value == &check_value(&b, &SchemaId::from("phase"), &json!({"kind":next,"value":{}})).unwrap()
        )));
        assert!(!mutations
            .iter()
            .any(|mutation| matches!(mutation, MutationValue::ActivateChild { .. })));
    }
}

fn observed_revision(b: &DefinitionBundle, key: &str, id: &str, version: u64) -> VersionedValue {
    VersionedValue {
        identity: format!("artifact:{key}"),
        version,
        root: ReferenceRoot::Output {
            key: SymbolKey::from(key),
        },
        value: check_value(
            b,
            &SchemaId::from("revision"),
            &json!({"brand":"artifact_revision","id":id}),
        )
        .unwrap(),
    }
}

#[test]
fn approval_rejects_a_revision_superseded_by_later_publication() {
    let b = bundle("exact-review-target");
    let p = compile(&b, &b.operations).unwrap();
    let mut first = snapshot(&b, json!({}), "inspection", "certify");
    first
        .observations
        .push(observed_revision(&b, "specimen", "r", 3));
    first.trigger.payload = check_value(
        &b,
        &SchemaId::from("inspection_request"),
        &json!({"specimen":{"brand":"artifact_revision","id":"r"}}),
    )
    .unwrap();
    let DecisionOutcome::Apply {
        targets: old_targets,
        explanation: old_pin,
        ..
    } = evaluate(&p, &first).unwrap()
    else {
        panic!()
    };
    let mut later = first.clone();
    later.observations[0] = observed_revision(&b, "specimen", "r-plus-one", 4);
    assert!(matches!(
        evaluate(&p, &later).unwrap(),
        DecisionOutcome::Reject { .. }
    ));
    later.trigger.payload = check_value(
        &b,
        &SchemaId::from("inspection_request"),
        &json!({"specimen":{"brand":"artifact_revision","id":"r-plus-one"}}),
    )
    .unwrap();
    let DecisionOutcome::Apply {
        targets: new_targets,
        explanation: new_pin,
        ..
    } = evaluate(&p, &later).unwrap()
    else {
        panic!()
    };
    assert_ne!(old_targets, new_targets);
    assert_eq!(old_targets, vec![first.observations[0].value.clone()]);
    assert_eq!(
        old_pin
            .read_set
            .iter()
            .find(|pin| pin.identity == "artifact:specimen")
            .unwrap()
            .version,
        3
    );
    assert_eq!(
        new_pin
            .read_set
            .iter()
            .find(|pin| pin.identity == "artifact:specimen")
            .unwrap()
            .version,
        4
    );
}

fn reservation_snapshot(
    b: &DefinitionBundle,
    phase: &str,
    command: &str,
    occupied: usize,
) -> Snapshot {
    let mut s = snapshot(b, json!({}), phase, command);
    s.observations.push(VersionedValue {
        identity: "pool:furnace_slot".into(),
        version: occupied as u64 + 1,
        root: ReferenceRoot::Resource {
            key: SymbolKey::from("furnace_occupancy"),
        },
        value: check_value(b, &SchemaId::from("slot_occupancy"), &json!(occupied)).unwrap(),
    });
    s
}

#[test]
fn reservation_remains_held_during_pause_review_and_dispatch() {
    let b = bundle("held-reservation");
    let p = compile(&b, &b.operations).unwrap();
    let decisions = [
        ("unlit", "light"),
        ("firing", "fault"),
        ("paused", "resume"),
        ("firing", "inspect"),
        ("inspection", "send"),
        ("dispatch", "unload"),
    ];
    let mut occupied = 0;
    let DecisionOutcome::Apply {
        mutations: next_activation,
        ..
    } = evaluate(&p, &reservation_snapshot(&b, "unlit", "light", 0)).unwrap()
    else {
        panic!()
    };
    let slots_needed = next_activation
        .iter()
        .filter(|mutation| matches!(mutation, MutationValue::Acquire { .. }))
        .count();
    assert_eq!(slots_needed, 1);
    for (index, (phase, command)) in decisions.into_iter().enumerate() {
        let DecisionOutcome::Apply { mutations, .. } =
            evaluate(&p, &reservation_snapshot(&b, phase, command, occupied)).unwrap()
        else {
            panic!()
        };
        for mutation in mutations {
            match mutation {
                MutationValue::Acquire { .. } => occupied += 1,
                MutationValue::Release { .. } => occupied -= 1,
                _ => {}
            }
        }
        assert_eq!(occupied, if index == 5 { 0 } else { 1 });
        let competing = reservation_snapshot(&b, "unlit", "light", occupied);
        let decision = evaluate(&p, &competing).unwrap();
        let explanation = match &decision {
            DecisionOutcome::Apply { explanation, .. }
            | DecisionOutcome::Reject { explanation, .. } => explanation,
            _ => panic!("expected capacity decision"),
        };
        assert_eq!(
            explanation
                .read_set
                .iter()
                .find(|pin| pin.identity == "pool:furnace_slot")
                .unwrap()
                .version,
            occupied as u64 + 1
        );
        if index == 5 {
            assert!(matches!(decision,
                DecisionOutcome::Apply { mutations, .. } if mutations.iter().any(|m| matches!(m, MutationValue::Acquire { .. }))));
        } else {
            assert!(matches!(decision, DecisionOutcome::Reject { .. }));
        }
    }
}

#[test]
fn replacement_requires_terminal_external_observation() {
    let b = bundle("terminal-replacement");
    let p = compile(&b, &b.operations).unwrap();
    let mut s = snapshot(&b, json!({}), "dispatch", "recast");
    assert_eq!(
        evaluate(&p, &s).unwrap_err().kind,
        DomainErrorKind::InvalidSnapshot
    );
    s.observations.push(VersionedValue {
        identity: "shipment-status".into(),
        version: 2,
        root: ReferenceRoot::Resource {
            key: SymbolKey::from("shipment"),
        },
        value: check_value(
            &b,
            &SchemaId::from("shipment_state"),
            &json!({"kind":"in_transit","value":{}}),
        )
        .unwrap(),
    });
    assert!(matches!(
        evaluate(&p, &s).unwrap(),
        DecisionOutcome::Reject { .. }
    ));
    s.observations[0].value = check_value(
        &b,
        &SchemaId::from("shipment_state"),
        &json!({"kind":"returned","value":{}}),
    )
    .unwrap();
    assert!(
        matches!(evaluate(&p, &s).unwrap(), DecisionOutcome::Apply { invocations, .. } if invocations.len() == 1)
    );
}

#[test]
fn publication_policies_reject_each_stale_predecessor() {
    let b = bundle("publication-pair");
    let p = compile(&b, &b.operations).unwrap();
    assert!(matches!(
        b.scopes[0].outputs[0].policy,
        PublicationPolicy::AppendRevision
    ));
    assert!(matches!(
        b.scopes[0].outputs[1].policy,
        PublicationPolicy::ReplaceArtifact
    ));
    let mut s = snapshot(&b, json!({}), "inspection", "amend");
    s.observations
        .push(observed_revision(&b, "assay_log", "log-2", 2));
    s.observations
        .push(observed_revision(&b, "current_label", "label-7", 7));
    s.trigger.payload = check_value(
        &b,
        &SchemaId::from("amendment_request"),
        &json!({"assay_log":{"brand":"artifact_revision","id":"log-2"},
                "current_label":{"brand":"artifact_revision","id":"label-7"}}),
    )
    .unwrap();
    let DecisionOutcome::Apply {
        targets,
        explanation,
        ..
    } = evaluate(&p, &s).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        targets,
        s.observations
            .iter()
            .map(|o| o.value.clone())
            .collect::<Vec<_>>()
    );
    for (identity, version) in [
        ("artifact:assay_log", 2),
        ("artifact:current_label", 7),
        ("instance", 9),
    ] {
        assert_eq!(
            explanation
                .read_set
                .iter()
                .find(|pin| pin.identity == identity)
                .unwrap()
                .version,
            version
        );
    }
    // Each policy rejects its stale predecessor even while the other is current.
    for (key, successor, version) in [("assay_log", "log-3", 3), ("current_label", "label-8", 8)] {
        let mut stale = s.clone();
        let index = stale
            .observations
            .iter()
            .position(|o| {
                o.root
                    == ReferenceRoot::Output {
                        key: SymbolKey::from(key),
                    }
            })
            .unwrap();
        stale.observations[index] = observed_revision(&b, key, successor, version);
        assert!(matches!(
            evaluate(&p, &stale).unwrap(),
            DecisionOutcome::Reject { .. }
        ));
    }
    let mut republished = s.clone();
    republished.observations[0] = observed_revision(&b, "assay_log", "log-3", 3);
    republished.observations[1] = observed_revision(&b, "current_label", "label-8", 8);
    assert!(matches!(
        evaluate(&p, &republished).unwrap(),
        DecisionOutcome::Reject { .. }
    ));
    republished.trigger.payload = check_value(
        &b,
        &SchemaId::from("amendment_request"),
        &json!({"assay_log":{"brand":"artifact_revision","id":"log-3"},
                "current_label":{"brand":"artifact_revision","id":"label-8"}}),
    )
    .unwrap();
    let DecisionOutcome::Apply {
        targets: successors,
        ..
    } = evaluate(&p, &republished).unwrap()
    else {
        panic!()
    };
    assert_ne!(targets, successors);
}

#[test]
fn collection_constraints_are_generic_transforms_before_materialization() {
    let mut b = bundle("dynamic");
    let child = &mut b.scopes[0].children[0];
    let collection = child.collection.as_mut().unwrap();
    collection.source = serde_json::from_value(json!({"kind":"check_collection","source":{"kind":"reference","root":{"kind":"input"},"path":[]},"key_field":"key","dependencies_field":"dependencies"})).unwrap();
    let p = compile(&b, &b.operations).unwrap();
    for (input, expected) in [
        (
            json!([{"key":"first","input":{},"dependencies":[]},{"key":"first","input":{},"dependencies":[]}]),
            DomainErrorKind::InvalidTemplate,
        ),
        (
            json!([{"key":"first","input":{},"dependencies":["missing"]}]),
            DomainErrorKind::InvalidTemplate,
        ),
        (
            json!([{"key":"first","input":{},"dependencies":["second"]},{"key":"second","input":{},"dependencies":["first"]}]),
            DomainErrorKind::CyclicPrerequisite,
        ),
    ] {
        let s = snapshot(&b, input, "ready", "begin");
        assert_eq!(
            materialize(&p, &s, &SymbolKey::from("items"))
                .unwrap_err()
                .kind,
            expected
        );
    }
}
