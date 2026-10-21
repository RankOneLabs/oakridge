use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use workflow_compiler::compile_workflow;
use workflow_evaluator::*;
use workflow_model::*;
fn program() -> CheckedWorkflow {
    let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"simple", "input":{}, "run":{"units":{"document":{"stage":"document","input":{}}},"outcome":{"draft":"document.outcome.draft"}},
            "stages":{"document":{"input":{},"artifacts":{"draft":{"schema":"text"}},"workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},"inputs":{},"creates":["draft"]}},"done_when":"approved(draft)","outcome":{"draft":"latest(draft)"}}}
        })).unwrap();
    // Compiled rather than hand-assembled: the engine reads the
    // checked stages, so a stub with empty stages is not a program.
    let prompts: BTreeMap<String, String> = [("write.md".to_owned(), String::new())]
        .into_iter()
        .collect();
    workflow_compiler::compile_workflow(&source, &[], &prompts).unwrap()
}
#[test]
fn a_serialized_null_launch_input_remains_resolved_after_a_child_completes() {
    let source: Workflow = serde_json::from_value(serde_json::json!({
        "workflow": "null_input",
        "input": "optional(text)",
        "run": {
            "units": {"document": {"stage": "document", "input": {}}},
            "outcome": {"input": "input"}
        },
        "stages": {"document": {
            "input": {},
            "artifacts": {"draft": {"schema": "text"}},
            "workers": {"writer": {"kind": "agent", "prompts": {"initial": "write.md"},
                                   "inputs": {}, "creates": ["draft"]}},
            "done_when": "published(draft)",
            "outcome": {"draft": "latest(draft)"}
        }}
    }))
    .unwrap();
    let prompts = [("write.md".to_owned(), String::new())]
        .into_iter()
        .collect();
    let program = compile_workflow(&source, &[], &prompts).unwrap();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(Event::Launched { input: Value::Null }, "launch"),
    )
    .unwrap()
    .snapshot;
    let restored: StepSnapshot =
        serde_json::from_value(serde_json::to_value(launched).unwrap()).unwrap();
    let action = restored.attempts[0].action_id.clone();
    let completed = step(
        &program,
        &restored,
        &incoming(
            Event::RevisionPublished {
                unit: UnitId::from("run/document"),
                artifact: SymbolKey::from("draft"),
                body: serde_json::json!("done"),
                predecessor: None,
                subject: None,
                by: Some(action),
            },
            "publish",
        ),
    )
    .unwrap();
    let root = completed
        .snapshot
        .units
        .iter()
        .find(|unit| unit.id == completed.snapshot.run.root)
        .unwrap();
    assert_eq!(
        root.status,
        UnitStatus::Done {
            outcome: serde_json::json!({"input": null})
        }
    );
}
#[test]
fn valid_graph_accepts_a_long_chain_and_refuses_it_closed_into_a_cycle() {
    let chain = |is_closed: bool| -> Vec<Value> {
        (0..10_000)
            .map(|index: usize| {
                let previous = match index {
                    0 if is_closed => vec![format!("k{}", 9_999)],
                    0 => vec![],
                    _ => vec![format!("k{}", index - 1)],
                };
                serde_json::json!({ "id": format!("k{index}"), "after": previous })
            })
            .collect()
    };
    assert!(is_valid_graph(&chain(false), "id", "after"));
    assert!(!is_valid_graph(&chain(true), "id", "after"));
}
fn snapshot() -> StepSnapshot {
    StepSnapshot {
        run: RunState {
            id: "run".into(),
            root: UnitId::from("run"),
        },
        units: vec![],
        attempts: vec![],
        revisions: vec![],
        decisions: vec![],
        retry_events: vec![],
    }
}
fn incoming(event: Event, id: &str) -> Incoming {
    Incoming {
        event,
        writer: Writer::Engine,
        ingress_id: Some(id.into()),
    }
}
fn sample(name: &str) -> CheckedWorkflow {
    let content = match name {
        "review-loop" => include_str!("../../../fixtures/bundles/review-loop.json"),
        "fan-out" => include_str!("../../../fixtures/bundles/fan-out.json"),
        _ => panic!("unknown sample"),
    };
    let source: Workflow = serde_json::from_str(content).unwrap();
    let prompts: BTreeMap<String, String> = [
        (
            "review-loop/write.md",
            include_str!("../../../../workflow-config/prompts/review-loop/write.md"),
        ),
        (
            "review-loop/revise.md",
            include_str!("../../../../workflow-config/prompts/review-loop/revise.md"),
        ),
        (
            "review-loop/critique.md",
            include_str!("../../../../workflow-config/prompts/review-loop/critique.md"),
        ),
        (
            "review-loop/editor.md",
            include_str!("../../../../workflow-config/prompts/review-loop/editor.md"),
        ),
        (
            "fan-out/item.md",
            include_str!("../../../../workflow-config/prompts/fan-out/item.md"),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    let operations = vec![CodeOperation {
        key: SymbolKey::from("repository.prepare"),
        input_schema: TypeExpression::Record(
            [
                (
                    "repository_path".into(),
                    TypeExpression::Name("repo_path".into()),
                ),
                (
                    "expected_head".into(),
                    TypeExpression::Name("optional(text)".into()),
                ),
                ("base_branch".into(), TypeExpression::Name("text".into())),
                (
                    "integration_branch".into(),
                    TypeExpression::Name("text".into()),
                ),
            ]
            .into(),
        ),
        output_schema: TypeExpression::Record(
            [
                (
                    "repository_path".into(),
                    TypeExpression::Name("repo_path".into()),
                ),
                (
                    "push_remote_owner".into(),
                    TypeExpression::Name("ident".into()),
                ),
                ("head".into(), TypeExpression::Name("ident".into())),
                ("base_branch".into(), TypeExpression::Name("text".into())),
            ]
            .into(),
        ),
        error_codes: vec![],
    }];
    compile_workflow(&source, &operations, &prompts).unwrap()
}
fn event(spec: &Value, state: &StepSnapshot) -> Event {
    let unit = spec["unit"].as_str().unwrap_or("");
    let worker = spec["worker"].as_str().unwrap_or("");
    let action = || {
        state
            .attempts
            .iter()
            .rev()
            .find(|a| a.unit.0 == unit && a.worker.0 == worker)
            .unwrap()
            .action_id
            .clone()
    };
    match spec["op"].as_str().unwrap() {
        "launch" => Event::Launched {
            input: spec["input"].clone(),
        },
        "started" => Event::WorkerStarted {
            action: action(),
            kbbl_session_id: Some(format!("session:{unit}:{worker}")),
        },
        "ended" => Event::WorkerEnded {
            action: action(),
            result: if spec["result"] == "succeeded" {
                WorkerResult::Succeeded
            } else {
                WorkerResult::Failed {
                    code: "failed".into(),
                    detail: "test failure".into(),
                }
            },
        },
        "publish" => Event::RevisionPublished {
            unit: UnitId::from(unit),
            artifact: SymbolKey::from(spec["artifact"].as_str().unwrap()),
            body: spec["body"].clone(),
            predecessor: spec["predecessor"].as_str().map(RevisionId::from),
            subject: spec["subject"].as_str().map(RevisionId::from),
            by: Some(action()),
        },
        "decide" => Event::OperatorDecided {
            unit: UnitId::from(unit),
            review: SymbolKey::from(spec["review"].as_str().unwrap()),
            decision: SymbolKey::from(spec["decision"].as_str().unwrap()),
            target: RevisionId::from(spec["target"].as_str().unwrap()),
            payload: spec["payload"].clone(),
        },
        "retry" => Event::RetryRequested {
            unit: UnitId::from(unit),
            worker: WorkerKey::from(worker),
        },
        _ => panic!("unknown event"),
    }
}
fn status_name(status: &UnitStatus) -> &'static str {
    match status {
        UnitStatus::NotStarted => "not_started",
        UnitStatus::Active => "active",
        UnitStatus::Done { .. } => "done",
        UnitStatus::Cancelled => "cancelled",
    }
}
fn status_rank(status: &UnitStatus) -> u8 {
    match status {
        UnitStatus::NotStarted => 0,
        UnitStatus::Active => 1,
        UnitStatus::Done { .. } | UnitStatus::Cancelled => 2,
    }
}
fn assert_never_regresses(before: &StepSnapshot, after: &StepSnapshot) {
    for old in &before.units {
        let current = after.units.iter().find(|unit| unit.id == old.id).unwrap();
        assert!(
            status_rank(&current.status) >= status_rank(&old.status),
            "{} regressed",
            old.id
        );
    }
}
fn assert_one_live_attempt_per_worker(state: &StepSnapshot) {
    let mut live = BTreeSet::new();
    for attempt in &state.attempts {
        if matches!(
            attempt.status,
            AttemptStatus::Pending | AttemptStatus::Running
        ) {
            assert!(
                live.insert((attempt.unit.clone(), attempt.worker.clone())),
                "two live attempts for {}:{}",
                attempt.unit,
                attempt.worker
            );
        }
    }
}

#[test]
fn named_schemas_resolve_through_optional_lists_and_records() {
    let source: Workflow = serde_json::from_value(serde_json::json!({
        "workflow":"aliases", "input":{"items":"optional(titles)"},
        "schemas":{"title":"text","titles":"list(title)"},
        "run":{"units":{},"outcome":{}},"stages":{}
    }))
    .unwrap();
    let program = compile_workflow(&source, &[], &BTreeMap::new()).unwrap();
    assert!(check_type(
        &program.input,
        &serde_json::json!({"items": ["one"]})
    ));
    assert!(check_type(
        &program.input,
        &serde_json::json!({"items": null})
    ));
    assert!(!check_type(
        &program.input,
        &serde_json::json!({"items": [1]})
    ));
}

#[test]
fn checked_artifact_and_decision_schemas_contain_resolved_types() {
    let source: Workflow = serde_json::from_value(serde_json::json!({
        "workflow":"aliases", "input":{},
        "schemas":{"title":"text","titles":"list(title)"},
        "run":{"units":{"write":{"stage":"write","input":{}}},"outcome":{}},
        "stages":{"write":{
            "input":{}, "artifacts":{"draft":{"schema":"titles"}},
            "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},
                "inputs":{},"creates":["draft"]}},
            "reviews":{"editor":{"of":"draft","by":"operator","prompt":"review.md",
                "decisions":{"approve":{"effect":"approve","label":"Approve",
                    "payload":"optional(titles)"}}}},
            "done_when":"approved(draft)","outcome":{}
        }}
    }))
    .unwrap();
    let prompts = BTreeMap::from([
        ("write.md".into(), String::new()),
        ("review.md".into(), String::new()),
    ]);
    let program = compile_workflow(&source, &[], &prompts).unwrap();
    let stage = &program.stages[0];
    assert_eq!(
        stage.artifacts[0].schema,
        CheckedType::List {
            item: Box::new(CheckedType::Text)
        }
    );
    let CheckedReview::Operator { decisions, .. } = &stage.reviews[0] else {
        panic!("review is operator")
    };
    assert_eq!(
        decisions["approve"].payload,
        Some(CheckedType::Optional {
            value: Box::new(CheckedType::List {
                item: Box::new(CheckedType::Text)
            })
        })
    );
}

#[test]
fn wrapped_record_aliases_preserve_field_names_in_checked_schemas() {
    let source: Workflow = serde_json::from_value(serde_json::json!({
        "workflow":"aliases", "input":{"items":"list(row)","maybe":"optional(row)"},
        "schemas":{"row":{"a,b":"text"}},
        "run":{"units":{"write":{"stage":"write","input":{}}},"outcome":{}},
        "stages":{"write":{
            "input":{}, "artifacts":{"draft":{"schema":"list(row)"}},
            "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},
                "inputs":{},"creates":["draft"]}},
            "reviews":{"editor":{"of":"draft","by":"operator","prompt":"review.md",
                "decisions":{"approve":{"effect":"approve","label":"Approve",
                    "payload":"optional(row)"}}}},
            "done_when":"approved(draft)","outcome":{}
        }}
    }))
    .unwrap();
    let prompts = BTreeMap::from([
        ("write.md".into(), String::new()),
        ("review.md".into(), String::new()),
    ]);
    let program = compile_workflow(&source, &[], &prompts).unwrap();
    let valid_row = serde_json::json!({"a,b":"ok"});
    let invalid_row = serde_json::json!({"b":"ok"});
    assert!(check_type(
        &program.input,
        &serde_json::json!({"items":[valid_row],"maybe":valid_row})
    ));
    assert!(!check_type(
        &program.input,
        &serde_json::json!({"items":[invalid_row],"maybe":null})
    ));
    let stage = &program.stages[0];
    assert!(check_type(
        &stage.artifacts[0].schema,
        &serde_json::json!([valid_row])
    ));
    assert!(!check_type(
        &stage.artifacts[0].schema,
        &serde_json::json!([invalid_row])
    ));
    let CheckedReview::Operator { decisions, .. } = &stage.reviews[0] else {
        panic!("review is operator")
    };
    let payload = decisions["approve"].payload.as_ref().unwrap();
    assert!(check_type(payload, &valid_row));
    assert!(!check_type(payload, &invalid_row));
}

#[test]
fn host_limits_reject_large_inputs_and_exhausted_expression_budget() {
    let program = sample("fan-out");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let launch = incoming(event(&trace["rows"][0]["events"][0], &snapshot()), "launch");
    let mut limits = ResourceLimits {
        max_list_items: 3,
        ..ResourceLimits::default()
    };
    assert!(
        matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
            Err(StepError::Rejected { reason, .. }) if reason == "max_list_items exceeded")
    );
    limits.max_list_items = 10_000;
    limits.evaluation_budget = 0;
    assert!(
        matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
            Err(StepError::Rejected { reason, .. }) if reason == "evaluation_budget exceeded")
    );
    limits.evaluation_budget = 1_000_000;
    limits.max_depth = 1;
    assert!(
        matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
            Err(StepError::Rejected { reason, .. }) if reason == "max_depth exceeded")
    );
}

#[test]
fn reviewer_needs_every_output_for_its_subject() {
    let mut program = sample("review-loop");
    let stage = program
        .stages
        .iter_mut()
        .find(|stage| stage.key.0 == "document")
        .unwrap();
    let CheckedWorker::Agent { creates, .. } = stage
        .workers
        .iter_mut()
        .find(|worker| worker.key().0 == "critic")
        .unwrap()
    else {
        panic!("critic is an agent")
    };
    creates.push(SymbolKey::from("summary"));
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap()[..=1].iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    state
        .attempts
        .retain(|attempt| attempt.worker.0 != "critic");
    state.revisions.push(RevisionState {
        id: RevisionId::from("run/document:critique:1"),
        unit: UnitId::from("run/document"),
        artifact: SymbolKey::from("critique"),
        seq: 1,
        body: serde_json::json!({"notes": []}),
        predecessor: None,
        subject: Some(RevisionId::from("run/document:draft:1")),
        by: Some(ActionKey::from("previous-review")),
    });
    let unit = state
        .units
        .iter()
        .find(|unit| unit.id.0 == "run/document")
        .unwrap();
    assert!(stage_actions(
        &program,
        &state,
        unit,
        &mut EvaluationContext::new(&ResourceLimits::default())
    )
    .unwrap()
    .iter()
    .any(|action| matches!(
        action, Action::RunWorker { worker, mode: Mode::Review, .. } if worker.0 == "critic"
    )));
}

#[test]
fn a_review_repeating_its_body_about_a_new_subject_is_a_new_revision() {
    let program = sample("review-loop");
    let mut trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let first_critique = trace["rows"][2]["events"][0]["body"].clone();
    let rows = trace["rows"].as_array_mut().unwrap();
    for event in rows[7]["events"].as_array_mut().unwrap() {
        if event["artifact"] == "critique" {
            event["body"] = first_critique.clone();
        }
    }
    let mut state = snapshot();
    for (index, row) in rows.iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    let subjects: Vec<_> = state
        .revisions
        .iter()
        .filter(|revision| revision.artifact.0 == "critique")
        .map(|revision| revision.subject.as_ref().map(|id| id.0.as_str()))
        .collect();
    assert_eq!(
        subjects,
        [Some("run/document:draft:1"), Some("run/document:draft:3")]
    );
    assert!(matches!(
        state
            .units
            .iter()
            .find(|unit| unit.id == state.run.root)
            .unwrap()
            .status,
        UnitStatus::Done { .. }
    ));
}

#[test]
fn an_assessment_cannot_be_approved_while_its_subject_is_being_replaced() {
    let mut source: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
    source["stages"]["document"]["workers"]["critic"]["prompts"]["revise"] =
        serde_json::json!("check.md");
    source["stages"]["document"]["reviews"]["critique_check"] = serde_json::json!({
        "of": "critique", "by": "operator", "prompt": "check.md",
        "decisions": {
            "accept": {"effect": "approve", "label": "Accept"},
            "request_assessment_changes": {"effect": "request_changes", "label": "Revise assessment", "fields": {"feedback": "What?"}},
            "request_build_changes": {"effect": "request_changes", "on": "draft", "label": "Request build changes", "fields": {"feedback": "What?"}}
        }
    });
    let prompts = [
        "review-loop/write.md",
        "review-loop/revise.md",
        "review-loop/critique.md",
        "review-loop/editor.md",
        "check.md",
    ]
    .into_iter()
    .map(|path| (path.to_owned(), String::new()))
    .collect();
    let program =
        compile_workflow(&serde_json::from_value(source).unwrap(), &[], &prompts).unwrap();
    let first = step_specs(
        &program,
        &snapshot(),
        &[
            serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer","artifact":"draft","body":{"title":"First","body":"Long"}}),
            serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"critic"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"critic","artifact":"critique","body":{"notes":[]},"subject":"run/document:draft:1"}),
        ],
    );
    assert!(!first
        .reviews
        .iter()
        .any(|review| review.review.0 == "critique_check"));
    let ready = step_specs(
        &program,
        &first.snapshot,
        &[
            serde_json::json!({"op":"ended","unit":"run/document","worker":"critic","result":"succeeded"}),
        ],
    );
    assert!(ready
        .reviews
        .iter()
        .any(|review| review.review.0 == "critique_check"));
    let assessment_revision = step_specs(
        &program,
        &ready.snapshot,
        &[
            serde_json::json!({"op":"decide","unit":"run/document","review":"critique_check","decision":"request_assessment_changes","target":"run/document:critique:1","payload":{"feedback":"Fix the cohort reference"}}),
        ],
    );
    let revise = resolved_for(&assessment_revision, "critic");
    assert_eq!(
        revise
            .previous
            .as_ref()
            .map(|revision| revision.id.0.as_str()),
        Some("run/document:critique:1")
    );
    assert_eq!(
        revise.feedback,
        Some(serde_json::json!({"feedback":"Fix the cohort reference"}))
    );
    assert_eq!(
        revise
            .subject
            .as_ref()
            .map(|revision| revision.id.0.as_str()),
        Some("run/document:draft:1")
    );
    let revised = step_specs(
        &program,
        &assessment_revision.snapshot,
        &[
            serde_json::json!({"op":"started","unit":"run/document","worker":"critic"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"critic","artifact":"critique","body":{"notes":["Correct cohort"]},"predecessor":"run/document:critique:1","subject":"run/document:draft:1"}),
            serde_json::json!({"op":"ended","unit":"run/document","worker":"critic","result":"succeeded"}),
        ],
    );
    assert!(revised
        .reviews
        .iter()
        .any(|review| review.review.0 == "critique_check"
            && review.target.0 == "run/document:critique:2"));
    let requested = step_specs(
        &program,
        &ready.snapshot,
        &[
            serde_json::json!({"op":"decide","unit":"run/document","review":"critique_check","decision":"request_build_changes","target":"run/document:draft:1","payload":{"feedback":"Rebuild"}}),
        ],
    );
    assert!(!requested
        .reviews
        .iter()
        .any(|review| review.review.0 == "critique_check"));
    let replacing = step_specs(
        &program,
        &requested.snapshot,
        &[
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer","artifact":"draft","body":{"title":"Second","body":"Better"},"predecessor":"run/document:draft:1"}),
            serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
        ],
    );
    assert!(!replacing
        .reviews
        .iter()
        .any(|review| review.review.0 == "critique_check"));
    let stale_accept = step(
        &program,
        &replacing.snapshot,
        &incoming(
            Event::OperatorDecided {
                unit: UnitId::from("run/document"),
                review: SymbolKey::from("critique_check"),
                decision: SymbolKey::from("accept"),
                target: RevisionId::from("run/document:critique:1"),
                payload: serde_json::json!({}),
            },
            "stale-accept",
        ),
    );
    assert!(stale_accept.is_err());
}

#[test]
fn member_outcomes_are_projected_in_key_order() {
    let program = sample("fan-out");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap()[..=1].iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    for child in state
        .units
        .iter_mut()
        .filter(|unit| unit.parent.as_ref().is_some_and(|id| id.0 == "run/work"))
    {
        child.status = UnitStatus::Done {
            outcome: Value::String(child.id.0.clone()),
        };
    }
    state.units.reverse();
    let owner = state
        .units
        .iter()
        .find(|unit| unit.id.0 == "run/work")
        .unwrap();
    let expression = Expression::Reference {
        root: ReferenceRoot::MemberOutcomes {
            unit: SymbolKey::from("item"),
        },
        path: vec![],
    };
    assert_eq!(
        eval_expression(
            &expression,
            owner,
            &state,
            None,
            None,
            &mut EvaluationContext::new(&ResourceLimits::default())
        ),
        Ok(Some(serde_json::json!([
            "run/work/a",
            "run/work/b",
            "run/work/c",
            "run/work/d"
        ])))
    );
}

#[test]
fn failed_code_validation_does_not_publish_a_revision() {
    let mut source: Workflow =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    source
        .stages
        .get_mut("prepare")
        .unwrap()
        .artifacts
        .get_mut("workspace")
        .unwrap()
        .validate
        .push(ValidationCheck {
            check: "false".into(),
            message: "invalid workspace".into(),
        });
    let original = sample("fan-out");
    let operations = [CodeOperation {
        key: SymbolKey::from("repository.prepare"),
        input_schema: TypeExpression::Record(BTreeMap::from([
            (
                "repository_path".into(),
                TypeExpression::Name("repo_path".into()),
            ),
            (
                "expected_head".into(),
                TypeExpression::Name("optional(text)".into()),
            ),
            ("base_branch".into(), TypeExpression::Name("text".into())),
            (
                "integration_branch".into(),
                TypeExpression::Name("text".into()),
            ),
        ])),
        output_schema: source.stages["prepare"].artifacts["workspace"]
            .schema
            .clone(),
        error_codes: vec![],
    }];
    let prompts = BTreeMap::from([("fan-out/item.md".into(), String::new())]);
    let program = compile_workflow(&source, &operations, &prompts).unwrap();
    assert_eq!(program.stages.len(), original.stages.len());
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let launch = &trace["rows"][0]["events"][0];
    let state = step(
        &program,
        &snapshot(),
        &incoming(event(launch, &snapshot()), "launch"),
    )
    .unwrap()
    .snapshot;
    let publication = event(&trace["rows"][1]["events"][0], &state);
    let result = step(&program, &state, &incoming(publication, "publish")).unwrap();
    assert!(result.snapshot.revisions.is_empty());
    assert!(matches!(
        result.snapshot.attempts[0].status,
        AttemptStatus::Failed { .. }
    ));
    assert!(matches!(
        result
            .snapshot
            .units
            .iter()
            .find(|unit| unit.id.0 == "run/prepare")
            .unwrap()
            .status,
        UnitStatus::Active
    ));
}

#[test]
fn operator_decision_uses_its_declared_target_artifact() {
    let mut program = sample("review-loop");
    let stage = program
        .stages
        .iter_mut()
        .find(|stage| stage.key.0 == "document")
        .unwrap();
    let CheckedReview::Operator { decisions, .. } = stage
        .reviews
        .iter_mut()
        .find(|review| review.key().0 == "editor")
        .unwrap()
    else {
        panic!("editor is an operator review")
    };
    decisions.get_mut("approve").unwrap().on = Some(SymbolKey::from("critique"));
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap()[..=2].iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    let result = step(
        &program,
        &state,
        &incoming(
            Event::OperatorDecided {
                unit: UnitId::from("run/document"),
                review: SymbolKey::from("editor"),
                decision: SymbolKey::from("approve"),
                target: RevisionId::from("run/document:critique:1"),
                payload: serde_json::json!({}),
            },
            "approve-critique",
        ),
    )
    .unwrap();
    assert_eq!(
        result.snapshot.decisions.last().unwrap().target().0,
        "run/document:critique:1"
    );
}
fn apply_row(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    row: &Value,
    row_number: usize,
) -> StepSnapshot {
    let mut state = state.clone();
    let before = state.attempts.len();
    for (index, spec) in row["events"].as_array().unwrap().iter().enumerate() {
        let incoming = incoming(event(spec, &state), &format!("{row_number}:{index}"));
        let next = step(program, &state, &incoming).unwrap().snapshot;
        assert_never_regresses(&state, &next);
        assert_one_live_attempt_per_worker(&next);
        state = next;
    }
    for (key, expected) in row["status"].as_object().unwrap() {
        let actual = if key == "run" {
            &state
                .units
                .iter()
                .find(|unit| unit.id == state.run.root)
                .unwrap()
                .status
        } else {
            &state.units.iter().find(|u| u.id.0 == *key).unwrap().status
        };
        assert_eq!(
            status_name(actual),
            if expected.as_str() == Some("blocked") {
                "not_started"
            } else {
                expected.as_str().unwrap()
            },
            "row {row_number} {key}"
        );
    }
    if let Some(expected) = row.get("new_workers") {
        let actual: Vec<_> = state.attempts[before..]
            .iter()
            .map(|a| format!("{}:{}", a.unit.0, a.worker.0))
            .collect();
        let expected: Vec<_> = expected
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(actual, expected, "row {row_number} new workers");
    }
    state
}
/// Steps each event spec in order; returns the last step's result.
fn step_specs(program: &CheckedWorkflow, state: &StepSnapshot, specs: &[Value]) -> StepResult {
    let mut state = state.clone();
    let mut last = None;
    for (index, spec) in specs.iter().enumerate() {
        let incoming = incoming(event(spec, &state), &format!("resolved:{index}"));
        let result = step(program, &state, &incoming).unwrap();
        state = result.snapshot.clone();
        last = Some(result);
    }
    last.unwrap()
}
fn resolved_for<'a>(result: &'a StepResult, worker: &str) -> &'a ResolvedRunWorker {
    let attempt = result
        .snapshot
        .attempts
        .iter()
        .rev()
        .find(|attempt| attempt.worker.0 == worker)
        .unwrap();
    &result
        .wanted
        .iter()
        .find(|wanted| wanted.action_id == attempt.action_id)
        .unwrap()
        .resolved
}
#[test]
fn an_awaiting_review_resolves_its_inputs_and_a_decided_one_drops_out() {
    let program = sample("review-loop");
    let published = [
        serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
        serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
        serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                "artifact":"draft","body":{"title":"First","body":"Long"}}),
    ];
    let awaiting = step_specs(&program, &snapshot(), &published);
    let [editor] = awaiting.reviews.as_slice() else {
        panic!("one review awaits: {:?}", awaiting.reviews)
    };
    assert_eq!(
        (
            editor.review.0.as_str(),
            editor.target.0.as_str(),
            &editor.inputs["topic"],
            &editor.inputs["draft"],
            &editor.inputs["critique"]
        ),
        (
            "editor",
            "run/document:draft:1",
            &serde_json::json!("Oakridge"),
            &serde_json::json!({"title":"First","body":"Long"}),
            &Value::Null
        )
    );
    let decided = step_specs(&program, &snapshot(), &[
            published.as_slice(),
            &[serde_json::json!({"op":"decide","unit":"run/document","review":"editor",
                "decision":"request_changes","target":"run/document:draft:1","payload":{"feedback":"shorter"}})],
        ].concat());
    assert!(decided.reviews.is_empty());
}

#[test]
fn an_action_id_is_a_fixed_length_hash_of_its_parts() {
    let short = action_id(
        &UnitId::from("run/document"),
        &WorkerKey::from("writer"),
        &Mode::Revise,
        &Cause::ChangesRequested {
            decision: DecisionId::from("run/document:d1"),
        },
    );
    let long_unit = UnitId::from(format!("run/work/{}", "k".repeat(400)).as_str());
    let long = action_id(
        &long_unit,
        &WorkerKey::from("writer"),
        &Mode::Initial,
        &Cause::Missing,
    );
    let again = action_id(
        &long_unit,
        &WorkerKey::from("writer"),
        &Mode::Initial,
        &Cause::Missing,
    );
    assert_eq!(
        (short.0.len(), long.0.len(), long == again, short == long),
        (32, 32, true, false)
    );
}

#[test]
fn a_collection_key_longer_than_an_ident_is_refused_at_launch() {
    let program = sample("fan-out");
    let input = |key: String| {
        serde_json::json!({"repository":{"repository_path":"/tmp/repo","expected_head":null,"base_branch":"epic/sample","integration_branch":"main"},
            "items":[{"key":key,"text":"t","after":[]}]})
    };
    let launch = |key: String| {
        step(
            &program,
            &snapshot(),
            &incoming(
                event(
                    &serde_json::json!({"op":"launch","input":input(key)}),
                    &snapshot(),
                ),
                "launch",
            ),
        )
    };
    assert!(launch("k".repeat(MAX_IDENT_CHARS)).is_ok());
    assert!(matches!(
        launch("k".repeat(MAX_IDENT_CHARS + 1)),
        Err(StepError::Rejected { .. })
    ));
}

#[test]
fn initial_worker_inputs_resolve_with_unpublished_reads_as_null() {
    let program = sample("review-loop");
    let result = step_specs(
        &program,
        &snapshot(),
        &[serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}})],
    );
    let writer = resolved_for(&result, "writer");
    assert_eq!(
        (
            &writer.inputs,
            &writer.previous,
            &writer.subject,
            &writer.workspace
        ),
        (
            &serde_json::json!({"topic":"Oakridge","critique":null}),
            &None,
            &None,
            &None
        )
    );
}
#[test]
fn a_reviewer_waits_for_its_subjects_creator_to_end_its_attempt() {
    let program = sample("review-loop");
    let published = [
        serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
        serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
        serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                "artifact":"draft","body":{"title":"First","body":"Long"}}),
    ];
    let wants_critic = |result: &StepResult| {
        result
            .wanted
            .iter()
            .any(|wanted| wanted.worker.0 == "critic")
    };
    let writing = step_specs(&program, &snapshot(), &published);
    let ended = step_specs(
            &program,
            &snapshot(),
            &[
                published.as_slice(),
                &[serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"})],
            ]
            .concat(),
        );
    assert_eq!(
        (wants_critic(&writing), wants_critic(&ended)),
        (false, true)
    );
}
#[test]
fn reviewer_receives_the_revision_it_reviews_as_subject() {
    let program = sample("review-loop");
    let result = step_specs(
        &program,
        &snapshot(),
        &[
            serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                    "artifact":"draft","body":{"title":"First","body":"Long"}}),
            serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
        ],
    );
    let subject = resolved_for(&result, "critic").subject.as_ref().unwrap();
    assert_eq!(
        (&subject.id.0, &subject.body),
        (
            &"run/document:draft:1".to_owned(),
            &serde_json::json!({"title":"First","body":"Long"})
        )
    );
}
#[test]
fn revise_receives_the_requested_revision_and_decision_payload() {
    let program = sample("review-loop");
    let result = step_specs(
        &program,
        &snapshot(),
        &[
            serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                    "artifact":"draft","body":{"title":"First","body":"Long"}}),
            serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
            serde_json::json!({"op":"decide","unit":"run/document","review":"editor",
                    "decision":"request_changes","target":"run/document:draft:1","payload":{"feedback":"shorter"}}),
        ],
    );
    let writer = resolved_for(&result, "writer");
    assert_eq!(
        (
            writer
                .previous
                .as_ref()
                .map(|revision| revision.id.0.as_str()),
            &writer.feedback
        ),
        (
            Some("run/document:draft:1"),
            &Some(serde_json::json!({"feedback":"shorter"}))
        )
    );
}
/// One writer creating `plan` then `build`, and an operator review of
/// `plan` whose `fix_build` decides on `build` instead.
fn plan_and_build_program() -> CheckedWorkflow {
    let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"plan_and_build", "input":{}, "run":{"units":{"work":{"stage":"work","input":{}}},"outcome":{}},
            "stages":{"work":{"input":{},"artifacts":{"plan":{"schema":"text"},"build":{"schema":"text"}},
                "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md","revise":"revise.md"},"inputs":{},"creates":["plan","build"]}},
                "reviews":{"check":{"of":"plan","by":"operator","prompt":"check.md","decisions":{
                    "accept":{"effect":"approve","label":"Accept"},
                    "fix_plan":{"effect":"request_changes","label":"Fix plan","fields":{"feedback":"What?"}},
                    "fix_build":{"effect":"request_changes","on":"build","label":"Fix build","fields":{"feedback":"What?"}}}}},
                "done_when":"approved(plan)","outcome":{}}}
        }))
        .unwrap();
    let prompts: BTreeMap<String, String> = ["write.md", "revise.md", "check.md"]
        .into_iter()
        .map(|path| (path.to_owned(), String::new()))
        .collect();
    compile_workflow(&source, &[], &prompts).unwrap()
}
fn plan_and_build_published() -> Vec<Value> {
    vec![
        serde_json::json!({"op":"launch","input":{}}),
        serde_json::json!({"op":"started","unit":"run/work","worker":"writer"}),
        serde_json::json!({"op":"publish","unit":"run/work","worker":"writer","artifact":"plan","body":"plan one"}),
        serde_json::json!({"op":"publish","unit":"run/work","worker":"writer","artifact":"build","body":"build one"}),
    ]
}
#[test]
fn an_awaiting_review_advertises_each_decisions_own_target() {
    let program = plan_and_build_program();
    let awaiting = step_specs(&program, &snapshot(), &plan_and_build_published());
    let [check] = awaiting.reviews.as_slice() else {
        panic!("one review awaits: {:?}", awaiting.reviews)
    };
    let targets: Vec<_> = check
        .decisions
        .iter()
        .map(|decision| (decision.decision.0.as_str(), decision.target.0.as_str()))
        .collect();
    assert_eq!(
        targets,
        [
            ("accept", "run/work:plan:1"),
            ("fix_build", "run/work:build:1"),
            ("fix_plan", "run/work:plan:1")
        ]
    );
}
#[test]
fn a_decision_on_its_advertised_target_is_accepted() {
    let program = plan_and_build_program();
    let awaiting = step_specs(&program, &snapshot(), &plan_and_build_published());
    let fix_build = awaiting.reviews[0]
        .decisions
        .iter()
        .find(|decision| decision.decision.0 == "fix_build")
        .unwrap();
    let result = step(
        &program,
        &awaiting.snapshot,
        &incoming(
            Event::OperatorDecided {
                unit: UnitId::from("run/work"),
                review: SymbolKey::from("check"),
                decision: fix_build.decision.clone(),
                target: fix_build.target.clone(),
                payload: serde_json::json!({"feedback":"rebuild"}),
            },
            "fix-build",
        ),
    );
    assert!(result.is_ok(), "{result:?}");
}
#[test]
fn a_decided_target_stops_advertising_its_decisions() {
    let program = plan_and_build_program();
    let decided = step_specs(&program, &snapshot(), &[
            plan_and_build_published().as_slice(),
            &[serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                "decision":"fix_build","target":"run/work:build:1","payload":{"feedback":"rebuild"}})],
        ].concat());
    let advertised: Vec<_> = decided.reviews[0]
        .decisions
        .iter()
        .map(|decision| decision.decision.0.as_str())
        .collect();
    assert_eq!(advertised, ["accept", "fix_plan"]);
}
#[test]
fn revise_answers_the_decision_its_cause_names_not_the_newest() {
    let program = plan_and_build_program();
    // Both requests land while the writer is still running, so its
    // revise is wanted only once both exist: pinned to the one on
    // `plan`, the first artifact it creates, though `build`'s is newer.
    let result = step_specs(&program, &snapshot(), &[
            plan_and_build_published().as_slice(),
            &[
                serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                    "decision":"fix_plan","target":"run/work:plan:1","payload":{"feedback":"replan"}}),
                serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                    "decision":"fix_build","target":"run/work:build:1","payload":{"feedback":"rebuild"}}),
                serde_json::json!({"op":"ended","unit":"run/work","worker":"writer","result":"succeeded"}),
            ],
        ].concat());
    let writer = resolved_for(&result, "writer");
    assert_eq!(
        (
            writer
                .previous
                .as_ref()
                .map(|revision| revision.id.0.as_str()),
            &writer.feedback
        ),
        (
            Some("run/work:plan:1"),
            &Some(serde_json::json!({"feedback":"replan"}))
        )
    );
}
#[test]
fn repository_workspace_resolves_from_the_stage_input() {
    let program = sample("fan-out");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let rows = trace["rows"].as_array().unwrap();
    // The workspace publication completes prepare and starts the items.
    let specs = [rows[0]["events"][0].clone(), rows[1]["events"][0].clone()];
    let result = step_specs(&program, &snapshot(), &specs);
    let item = resolved_for(&result, "worker");
    assert_eq!(
        item.workspace,
        Some(
            serde_json::json!({"repository_path":"/tmp/repo","push_remote_owner":"owner","head":"abc","base_branch":"epic/x"})
        )
    );
}
#[test]
fn revision_and_decision_ids_are_unique_across_units() {
    let program = sample("fan-out");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    let ids: BTreeSet<_> = state.revisions.iter().map(|r| r.id.0.clone()).collect();
    assert_eq!((ids.len() > 1, ids.len()), (true, state.revisions.len()));
}
#[test]
fn sample_traces_replay_every_prefix_and_never_regress_unit_status() {
    for (name, trace) in [
        (
            "review-loop",
            include_str!("../../../fixtures/traces/review-loop.json"),
        ),
        (
            "fan-out",
            include_str!("../../../fixtures/traces/fan-out.json"),
        ),
    ] {
        let program = sample(name);
        let trace: Value = serde_json::from_str(trace).unwrap();
        let rows = trace["rows"].as_array().unwrap();
        let mut state = snapshot();
        for (index, row) in rows.iter().enumerate() {
            let before = state.clone();
            state = apply_row(&program, &state, row, index);
            assert_never_regresses(&before, &state);
            let mut replay = snapshot();
            for (prefix, row) in rows[..=index].iter().enumerate() {
                replay = apply_row(&program, &replay, row, prefix);
            }
            assert_eq!(replay, state, "{name} prefix {index}");
        }
    }
}
#[test]
fn every_event_kind_preserves_unit_status_order() {
    for (name, trace) in [
        (
            "review-loop",
            include_str!("../../../fixtures/traces/review-loop.json"),
        ),
        (
            "fan-out",
            include_str!("../../../fixtures/traces/fan-out.json"),
        ),
    ] {
        let program = sample(name);
        let trace: Value = serde_json::from_str(trace).unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
            let action = state
                .attempts
                .last()
                .map(|attempt| attempt.action_id.clone())
                .unwrap_or_else(|| ActionKey::from("absent"));
            let unit = state
                .units
                .iter()
                .find(|unit| unit.kind.stage().is_some())
                .map(|unit| unit.id.clone())
                .unwrap_or_else(|| UnitId::from("absent"));
            // Keep this list exhaustive against Event's wire schema below.
            let candidates = [
                Event::Launched {
                    input: serde_json::json!({"topic":"Oakridge"}),
                },
                Event::WorkerStarted {
                    action: action.clone(),
                    kbbl_session_id: None,
                },
                Event::WorkerEnded {
                    action: action.clone(),
                    result: WorkerResult::Succeeded,
                },
                Event::RevisionPublished {
                    unit: unit.clone(),
                    artifact: SymbolKey::from("draft"),
                    body: serde_json::json!({"title":"x","body":"x"}),
                    predecessor: None,
                    subject: None,
                    by: Some(action),
                },
                Event::OperatorDecided {
                    unit: unit.clone(),
                    review: SymbolKey::from("editor"),
                    decision: SymbolKey::from("approve"),
                    target: RevisionId::from("run/document:draft:1"),
                    payload: serde_json::json!({}),
                },
                Event::RetryRequested {
                    unit,
                    worker: WorkerKey::from("writer"),
                },
                Event::CancelRequested,
            ];
            assert_eq!(candidates.len(), 7);
            for (kind, candidate) in candidates.into_iter().enumerate() {
                if let Ok(result) = step(
                    &program,
                    &state,
                    &incoming(candidate, &format!("probe:{name}:{index}:{kind}")),
                ) {
                    assert_never_regresses(&state, &result.snapshot);
                    assert_one_live_attempt_per_worker(&result.snapshot);
                }
            }
            state = apply_row(&program, &state, row, index);
        }
    }
}
#[test]
fn fan_out_stall_variant_keeps_failed_attempt_and_held_slot() {
    let program = sample("fan-out");
    let variant: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out-stall.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in variant["rows"].as_array().unwrap().iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    for (key, expected) in variant["status"].as_object().unwrap() {
        let actual = if key == "run" {
            &state
                .units
                .iter()
                .find(|unit| unit.id == state.run.root)
                .unwrap()
                .status
        } else {
            &state.units.iter().find(|u| u.id.0 == *key).unwrap().status
        };
        assert_eq!(
            status_name(actual),
            if expected.as_str() == Some("blocked") {
                "not_started"
            } else {
                expected.as_str().unwrap()
            }
        );
    }
    assert!(state
        .attempts
        .iter()
        .any(|a| a.unit.0 == "run/work/b" && matches!(a.status, AttemptStatus::Failed { .. })));
    assert!(!state.attempts.iter().any(|a| a.unit.0 == "run/work/d"));
}
#[test]
fn failed_attempt_stalls_until_retry_and_duplicates_change_nothing() {
    let program = program();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap();
    assert_eq!(launched.wanted.len(), 1);
    let attempt = launched.snapshot.attempts[0].action_id.clone();
    let started = step(
        &program,
        &launched.snapshot,
        &incoming(
            Event::WorkerStarted {
                action: attempt.clone(),
                kbbl_session_id: Some("session".into()),
            },
            "start",
        ),
    )
    .unwrap();
    let ended = step(
        &program,
        &started.snapshot,
        &incoming(
            Event::WorkerEnded {
                action: attempt.clone(),
                result: WorkerResult::Failed {
                    code: "oops".into(),
                    detail: "failed".into(),
                },
            },
            "end",
        ),
    )
    .unwrap();
    assert!(ended.wanted.is_empty());
    let duplicate = step(
        &program,
        &ended.snapshot,
        &incoming(
            Event::WorkerEnded {
                action: attempt,
                result: WorkerResult::Failed {
                    code: "oops".into(),
                    detail: "failed".into(),
                },
            },
            "end",
        ),
    )
    .unwrap();
    assert_eq!(duplicate.snapshot, ended.snapshot);
    let retry = step(
        &program,
        &ended.snapshot,
        &incoming(
            Event::RetryRequested {
                unit: UnitId::from("run/document"),
                worker: WorkerKey::from("writer"),
            },
            "retry",
        ),
    )
    .unwrap();
    assert_eq!(retry.wanted.len(), 1);
    assert_eq!(retry.snapshot.attempts.len(), 2);
}
#[test]
fn a_failed_retry_attempt_waits_for_another_retry() {
    let program = program();
    let mut state = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap()
    .snapshot;
    let fail = |state: &StepSnapshot, action: ActionKey, id: &str| {
        let started = step(
            &program,
            state,
            &incoming(
                Event::WorkerStarted {
                    action: action.clone(),
                    kbbl_session_id: None,
                },
                &format!("{id}:start"),
            ),
        )
        .unwrap();
        step(
            &program,
            &started.snapshot,
            &incoming(
                Event::WorkerEnded {
                    action,
                    result: WorkerResult::Failed {
                        code: "oops".into(),
                        detail: "failed".into(),
                    },
                },
                &format!("{id}:end"),
            ),
        )
        .unwrap()
    };
    state = fail(&state, state.attempts[0].action_id.clone(), "first").snapshot;
    state = step(
        &program,
        &state,
        &incoming(
            Event::RetryRequested {
                unit: UnitId::from("run/document"),
                worker: WorkerKey::from("writer"),
            },
            "retry",
        ),
    )
    .unwrap()
    .snapshot;
    let retried = state.attempts.last().unwrap().action_id.clone();
    let failed_again = fail(&state, retried, "second");
    assert!(failed_again
        .wanted
        .iter()
        .all(|wanted| wanted.worker.0 != "writer"));
    assert_eq!(failed_again.snapshot.attempts.len(), 2);
}
#[test]
fn a_retry_request_while_the_retry_attempt_is_live_is_rejected_and_registers_nothing() {
    let program = program();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap();
    let action = launched.snapshot.attempts[0].action_id.clone();
    let mut state = launched.snapshot;
    for (event, id) in [
        (
            Event::WorkerStarted {
                action: action.clone(),
                kbbl_session_id: None,
            },
            "start",
        ),
        (
            Event::WorkerEnded {
                action,
                result: WorkerResult::Failed {
                    code: "oops".into(),
                    detail: "failed".into(),
                },
            },
            "end",
        ),
    ] {
        state = step(&program, &state, &incoming(event, id))
            .unwrap()
            .snapshot;
    }
    let retry = |id: &str| {
        incoming(
            Event::RetryRequested {
                unit: UnitId::from("run/document"),
                worker: WorkerKey::from("writer"),
            },
            id,
        )
    };
    let retried = step(&program, &state, &retry("retry-1")).unwrap().snapshot;
    let replayed = step(&program, &retried, &retry("retry-1"))
        .unwrap()
        .snapshot;
    assert_eq!(replayed, retried);
    assert!(step(&program, &retried, &retry("retry-2")).is_err());
}
#[test]
fn a_retry_request_without_an_ingress_id_is_rejected() {
    let program = program();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap();
    let retry = Incoming {
        event: Event::RetryRequested {
            unit: UnitId::from("run/document"),
            worker: WorkerKey::from("writer"),
        },
        writer: Writer::Engine,
        ingress_id: None,
    };
    assert!(step(&program, &launched.snapshot, &retry).is_err());
}
#[test]
fn periodic_worker_uses_one_action_id_and_three_distinct_attempt_sequences() {
    let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"periodic", "input":{}, "run":{"units":{"watch":{"stage":"watch","input":{}}},"outcome":{}},
            "stages":{"watch":{"input":{},"artifacts":{"observation":{"schema":"text"}},"workers":{"observer":{"kind":"code","operation":"observe","inputs":{},"creates":["observation"],"every":"1s"}},"done_when":"false","outcome":{}}}
        })).unwrap();
    let observe = vec![CodeOperation {
        key: SymbolKey::from("observe"),
        input_schema: TypeExpression::Record(BTreeMap::new()),
        output_schema: TypeExpression::Name("text".into()),
        error_codes: vec![],
    }];
    let program = workflow_compiler::compile_workflow(&source, &observe, &BTreeMap::new()).unwrap();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap();
    let mut state = launched.snapshot;
    let action = state.attempts[0].action_id.clone();
    for tick in 1..=3 {
        state = step(
            &program,
            &state,
            &incoming(
                Event::WorkerStarted {
                    action: action.clone(),
                    kbbl_session_id: None,
                },
                &format!("start:{tick}"),
            ),
        )
        .unwrap()
        .snapshot;
        state = step(
            &program,
            &state,
            &incoming(
                Event::WorkerEnded {
                    action: action.clone(),
                    result: WorkerResult::Succeeded,
                },
                &format!("end:{tick}"),
            ),
        )
        .unwrap()
        .snapshot;
    }
    assert_eq!(
        state.attempts.iter().map(|a| a.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(state
        .attempts
        .iter()
        .all(|a| a.action_id == action && matches!(a.status, AttemptStatus::Succeeded)));
}
/// A builder agent publishing `pr`, and a watch observing `latest(pr)`
/// every second once it is published: the shape of `pr_watch`.
fn watch_program() -> CheckedWorkflow {
    let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"watch", "input":{}, "run":{"units":{"watch":{"stage":"watch","input":{}}},"outcome":{}},
            "stages":{"watch":{"input":{},"artifacts":{"pr":{"schema":"text"},"observation":{"schema":"text"}},
              "workers":{"builder":{"kind":"agent","prompts":{"initial":"build.md"},"inputs":{},"creates":["pr"]},
                "observer":{"kind":"code","operation":"observe","when":"published(pr)","inputs":{"branch":"latest(pr)"},"creates":["observation"],"every":"1s"}},
              "done_when":"false","outcome":{}}}
        })).unwrap();
    let observe = vec![CodeOperation {
        key: SymbolKey::from("observe"),
        input_schema: TypeExpression::Record(BTreeMap::from([(
            "branch".to_owned(),
            TypeExpression::Name("text".into()),
        )])),
        output_schema: TypeExpression::Name("text".into()),
        error_codes: vec![],
    }];
    let prompts = BTreeMap::from([("build.md".to_owned(), String::new())]);
    workflow_compiler::compile_workflow(&source, &observe, &prompts).unwrap()
}
fn latest_action(state: &StepSnapshot, worker: &str) -> ActionKey {
    state
        .attempts
        .iter()
        .rev()
        .find(|attempt| attempt.worker.0 == worker)
        .unwrap()
        .action_id
        .clone()
}
fn run_attempt(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    action: &ActionKey,
    result: WorkerResult,
    id: &str,
) -> StepResult {
    let started = step(
        program,
        state,
        &incoming(
            Event::WorkerStarted {
                action: action.clone(),
                kbbl_session_id: None,
            },
            &format!("{id}:start"),
        ),
    )
    .unwrap();
    step(
        program,
        &started.snapshot,
        &incoming(
            Event::WorkerEnded {
                action: action.clone(),
                result,
            },
            &format!("{id}:end"),
        ),
    )
    .unwrap()
}
/// An operator's edit of `pr`: what moves the watch's input in these tests.
fn edit_pr(program: &CheckedWorkflow, state: &StepSnapshot, branch: &str) -> StepResult {
    let unit = UnitId::from("run/watch");
    let predecessor = latest(state, &unit, &SymbolKey::from("pr")).map(|r| r.id.clone());
    step(
        program,
        state,
        &Incoming {
            event: Event::RevisionPublished {
                unit,
                artifact: SymbolKey::from("pr"),
                body: serde_json::json!(branch),
                predecessor,
                subject: None,
                by: None,
            },
            writer: Writer::Operator {
                subject: OperatorId::from("operator"),
            },
            ingress_id: Some(format!("edit:{branch}")),
        },
    )
    .unwrap()
}
/// Launched, the builder's `pr` published as "one", and the first watch
/// opened on it.
fn watching_one(program: &CheckedWorkflow) -> StepSnapshot {
    let launched = step(
        program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap()
    .snapshot;
    let builder = latest_action(&launched, "builder");
    let started = step(
        program,
        &launched,
        &incoming(
            Event::WorkerStarted {
                action: builder.clone(),
                kbbl_session_id: None,
            },
            "builder:start",
        ),
    )
    .unwrap()
    .snapshot;
    let published = step(
        program,
        &started,
        &incoming(
            Event::RevisionPublished {
                unit: UnitId::from("run/watch"),
                artifact: SymbolKey::from("pr"),
                body: serde_json::json!("one"),
                predecessor: None,
                subject: None,
                by: Some(builder.clone()),
            },
            "builder:publish",
        ),
    )
    .unwrap()
    .snapshot;
    step(
        program,
        &published,
        &incoming(
            Event::WorkerEnded {
                action: builder,
                result: WorkerResult::Succeeded,
            },
            "builder:end",
        ),
    )
    .unwrap()
    .snapshot
}
#[test]
fn a_watch_whose_inputs_change_is_replaced_by_one_pinned_to_the_new_inputs() {
    let program = watch_program();
    let state = watching_one(&program);
    let first = latest_action(&state, "observer");
    let state = run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
    let moved = edit_pr(&program, &state, "two");
    let second = latest_action(&moved.snapshot, "observer");
    assert_ne!(second, first);
    assert_eq!(
        resolved_for(&moved, "observer").inputs,
        serde_json::json!({"branch": "two"})
    );
    assert!(matches!(
        &moved.snapshot.attempts.last().unwrap().cause,
        Cause::Periodic { replaces: Some(replaced), .. } if *replaced == first
    ));
}
#[test]
fn a_replaced_watch_starts_no_further_attempt() {
    let program = watch_program();
    let state = watching_one(&program);
    let first = latest_action(&state, "observer");
    let state = run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
    let moved = edit_pr(&program, &state, "two").snapshot;
    let late_start = step(
        &program,
        &moved,
        &incoming(
            Event::WorkerStarted {
                action: first,
                kbbl_session_id: None,
            },
            "first:late",
        ),
    );
    assert!(matches!(late_start, Err(StepError::Rejected { .. })));
}
#[test]
fn a_watch_back_on_earlier_inputs_is_a_new_action() {
    let program = watch_program();
    let state = watching_one(&program);
    let first = latest_action(&state, "observer");
    let state = run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
    let state = edit_pr(&program, &state, "two").snapshot;
    let second = latest_action(&state, "observer");
    let state = run_attempt(&program, &state, &second, WorkerResult::Succeeded, "second").snapshot;
    let back = edit_pr(&program, &state, "one");
    let third = latest_action(&back.snapshot, "observer");
    assert!(third != first && third != second);
    assert_eq!(
        resolved_for(&back, "observer").inputs,
        serde_json::json!({"branch": "one"})
    );
}
#[test]
fn a_watch_on_unchanged_inputs_keeps_its_action() {
    let program = watch_program();
    let state = watching_one(&program);
    let first = latest_action(&state, "observer");
    let ended = run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first");
    assert_eq!(
        ended
            .snapshot
            .attempts
            .iter()
            .filter(|a| a.worker.0 == "observer")
            .count(),
        1
    );
}
#[test]
fn a_retried_watch_succeeds_on_an_unchanged_observation_and_resumes_its_schedule() {
    let program = watch_program();
    let state = watching_one(&program);
    let first = latest_action(&state, "observer");
    let state = run_attempt(
        &program,
        &state,
        &first,
        WorkerResult::Failed {
            code: "unavailable".into(),
            detail: "down".into(),
        },
        "first",
    )
    .snapshot;
    let state = step(
        &program,
        &state,
        &incoming(
            Event::RetryRequested {
                unit: UnitId::from("run/watch"),
                worker: WorkerKey::from("observer"),
            },
            "retry",
        ),
    )
    .unwrap()
    .snapshot;
    let retried = latest_action(&state, "observer");
    let ended = run_attempt(&program, &state, &retried, WorkerResult::Succeeded, "retry");
    let retry_attempt = ended
        .snapshot
        .attempts
        .iter()
        .find(|a| a.action_id == retried)
        .unwrap();
    assert_eq!(retry_attempt.status, AttemptStatus::Succeeded);
    let resumed = latest_action(&ended.snapshot, "observer");
    assert!(matches!(
        &ended.snapshot.attempts.last().unwrap().cause,
        Cause::Periodic { replaces: Some(replaced), .. } if *replaced == retried
    ));
    let state = run_attempt(
        &program,
        &ended.snapshot,
        &resumed,
        WorkerResult::Succeeded,
        "resumed:1",
    )
    .snapshot;
    let state = run_attempt(
        &program,
        &state,
        &resumed,
        WorkerResult::Succeeded,
        "resumed:2",
    )
    .snapshot;
    assert_eq!(
        state
            .attempts
            .iter()
            .filter(|a| a.action_id == resumed && a.status == AttemptStatus::Succeeded)
            .count(),
        2
    );
}
#[test]
fn duplicate_event_vocabulary_keeps_the_snapshot_identical() {
    let program = sample("review-loop");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let rows = trace["rows"].as_array().unwrap();
    let launched = apply_row(&program, &snapshot(), &rows[0], 0);
    let launch = event(&rows[0]["events"][0], &launched);
    assert_eq!(
        step(&program, &launched, &incoming(launch, "0:0"))
            .unwrap()
            .snapshot,
        launched
    );
    let published = apply_row(&program, &launched, &rows[1], 1);
    let writer = published
        .attempts
        .iter()
        .find(|a| a.worker.0 == "writer")
        .unwrap()
        .action_id
        .clone();
    let started = Event::WorkerStarted {
        action: writer.clone(),
        kbbl_session_id: Some("session:run/document:writer".into()),
    };
    assert_eq!(
        step(&program, &published, &incoming(started, "1:0"))
            .unwrap()
            .snapshot,
        published
    );
    let publication = event(&rows[1]["events"][1], &published);
    assert_eq!(
        step(&program, &published, &incoming(publication, "1:1"))
            .unwrap()
            .snapshot,
        published
    );
    let settled = apply_row(&program, &published, &rows[2], 2);
    let ended = Event::WorkerEnded {
        action: writer,
        result: WorkerResult::Succeeded,
    };
    assert_eq!(
        step(&program, &settled, &incoming(ended, "2:2"))
            .unwrap()
            .snapshot,
        settled
    );
    let decided = apply_row(&program, &settled, &rows[3], 3);
    let decision = event(&rows[3]["events"][0], &decided);
    assert_eq!(
        step(&program, &decided, &incoming(decision, "3:0"))
            .unwrap()
            .snapshot,
        decided
    );
    let mut state = decided;
    for (index, row) in rows[4..=6].iter().enumerate() {
        state = apply_row(&program, &state, row, index + 4);
    }
    let retry = event(&rows[6]["events"][0], &state);
    assert_eq!(
        step(&program, &state, &incoming(retry, "6:0"))
            .unwrap()
            .snapshot,
        state
    );
}
#[test]
fn stale_review_retry_and_publication_are_rejected() {
    let program = sample("review-loop");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let rows = trace["rows"].as_array().unwrap();
    let launched = apply_row(&program, &snapshot(), &rows[0], 0);
    assert!(matches!(
        step(
            &program,
            &launched,
            &incoming(
                Event::RetryRequested {
                    unit: UnitId::from("run/document"),
                    worker: WorkerKey::from("writer")
                },
                "bad-retry"
            )
        ),
        Err(StepError::Rejected { .. })
    ));
    assert!(matches!(
        step(
            &program,
            &launched,
            &incoming(
                Event::RevisionPublished {
                    unit: UnitId::from("run/document"),
                    artifact: SymbolKey::from("draft"),
                    body: serde_json::json!({"title":"x","body":"x"}),
                    predecessor: None,
                    subject: None,
                    by: Some(ActionKey::from("forged"))
                },
                "forged"
            )
        ),
        Err(StepError::Rejected { .. })
    ));
    let mut state = launched;
    for (index, row) in rows[..=4].iter().enumerate().skip(1) {
        state = apply_row(&program, &state, row, index);
    }
    assert!(matches!(
        step(
            &program,
            &state,
            &incoming(
                Event::OperatorDecided {
                    unit: UnitId::from("run/document"),
                    review: SymbolKey::from("editor"),
                    decision: SymbolKey::from("approve"),
                    target: RevisionId::from("run/document:draft:1"),
                    payload: serde_json::json!({})
                },
                "stale"
            )
        ),
        Err(StepError::Rejected { .. })
    ));
}
/// Fan-out launched over `items`, then its workspace published: the
/// step that starts the collection group.
fn fan_out_preparing(items: Value) -> (CheckedWorkflow, StepSnapshot, Incoming) {
    let program = sample("fan-out");
    let input = serde_json::json!({"repository":{"repository_path":"/tmp/repo","expected_head":null,"base_branch":"epic/sample","integration_branch":"main"},"items":items});
    let launched = step(
        &program,
        &snapshot(),
        &incoming(Event::Launched { input }, "launch"),
    )
    .unwrap()
    .snapshot;
    let git = launched.attempts[0].action_id.clone();
    let publish = Event::RevisionPublished {
        unit: UnitId::from("run/prepare"),
        artifact: SymbolKey::from("workspace"),
        body: serde_json::json!({"repository_path":"/tmp/repo","push_remote_owner":"owner","head":"abc","base_branch":"epic/x"}),
        predecessor: None,
        subject: None,
        by: Some(git),
    };
    (program, launched, incoming(publish, "publish"))
}
#[test]
fn a_collection_over_an_empty_list_completes_its_group_and_the_run() {
    let (program, launched, publish) = fan_out_preparing(serde_json::json!([]));
    let result = step(&program, &launched, &publish).unwrap();
    let work = result
        .snapshot
        .units
        .iter()
        .find(|unit| unit.id.0 == "run/work")
        .unwrap();
    assert_eq!(
        (
            &work.status,
            &result
                .snapshot
                .units
                .iter()
                .find(|unit| unit.id == result.snapshot.run.root)
                .unwrap()
                .status
        ),
        (
            &UnitStatus::Done {
                outcome: serde_json::json!({"results": []})
            },
            &UnitStatus::Done {
                outcome: serde_json::json!({"results": []})
            }
        )
    );
}
#[test]
fn a_group_that_cannot_materialize_after_launch_stalls_at_that_group() {
    let item = serde_json::json!({"key":"same","text":"t","after":[]});
    let (program, launched, publish) = fan_out_preparing(serde_json::json!([item.clone(), item]));
    assert!(matches!(
        step(&program, &launched, &publish),
        Err(StepError::Stalled { unit, reason })
            if unit.0 == "run/work" && reason.contains("duplicate key")
    ));
}
#[test]
fn an_inconsistency_found_advancing_another_unit_names_that_unit() {
    let (program, mut launched, publish) =
        fan_out_preparing(serde_json::json!([{"key":"a","text":"t","after":[]}]));
    let work = launched
        .units
        .iter_mut()
        .find(|unit| unit.id.0 == "run/work")
        .unwrap();
    work.kind = UnitKind::Stage(SymbolKey::from("absent"));
    assert!(matches!(
        step(&program, &launched, &publish),
        Err(StepError::Invalid { entity: StepEntity::Unit { unit }, .. }) if unit.0 == "run/work"
    ));
}
/// The review-loop trace played to its end: the run is done.
fn review_loop_done() -> (CheckedWorkflow, StepSnapshot) {
    let program = sample("review-loop");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    (program, state)
}
#[test]
fn a_done_run_refuses_cancel() {
    let (program, done) = review_loop_done();
    assert!(matches!(
        step(&program, &done, &incoming(Event::CancelRequested, "cancel")),
        Err(StepError::Rejected { reason, .. }) if reason == "run is done"
    ));
}
#[test]
fn a_done_unit_refuses_a_decision() {
    let (program, done) = review_loop_done();
    let decision = Event::OperatorDecided {
        unit: UnitId::from("run/document"),
        review: SymbolKey::from("editor"),
        decision: SymbolKey::from("request_changes"),
        target: RevisionId::from("run/document:draft:3"),
        payload: serde_json::json!({"feedback": "again"}),
    };
    assert!(matches!(
        step(&program, &done, &incoming(decision, "late")),
        Err(StepError::Rejected { reason, .. }) if reason == "unit is not active"
    ));
}
#[test]
fn a_cancelled_unit_refuses_a_retry_of_its_failed_worker() {
    let program = program();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap()
    .snapshot;
    let writer = launched.attempts[0].action_id.clone();
    let failed = run_attempt(
        &program,
        &launched,
        &writer,
        WorkerResult::Failed {
            code: "oops".into(),
            detail: "failed".into(),
        },
        "writer",
    )
    .snapshot;
    let cancelled = step(
        &program,
        &failed,
        &incoming(Event::CancelRequested, "cancel"),
    )
    .unwrap()
    .snapshot;
    let retry = Event::RetryRequested {
        unit: UnitId::from("run/document"),
        worker: WorkerKey::from("writer"),
    };
    assert!(matches!(
        step(&program, &cancelled, &incoming(retry, "retry")),
        Err(StepError::Rejected { reason, .. }) if reason == "unit is not active"
    ));
}
#[test]
fn cancel_is_terminal_and_idempotent_across_the_group_tree() {
    let program = sample("fan-out");
    let trace: Value =
        serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
    let mut state = snapshot();
    for (index, row) in trace["rows"].as_array().unwrap()[..=2].iter().enumerate() {
        state = apply_row(&program, &state, row, index);
    }
    let cancelled = step(
        &program,
        &state,
        &incoming(Event::CancelRequested, "cancel"),
    )
    .unwrap();
    assert!(matches!(
        cancelled
            .snapshot
            .units
            .iter()
            .find(|unit| unit.id == cancelled.snapshot.run.root)
            .unwrap()
            .status,
        UnitStatus::Cancelled
    ));
    assert!(cancelled
        .snapshot
        .units
        .iter()
        .all(|unit| matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled)));
    assert!(cancelled.wanted.is_empty());
    let duplicate = step(
        &program,
        &cancelled.snapshot,
        &incoming(Event::CancelRequested, "cancel"),
    )
    .unwrap();
    assert_eq!(duplicate.snapshot, cancelled.snapshot);
}

#[test]
fn rejected_events_name_the_artifact_or_worker_at_fault() {
    let program = program();
    let launched = step(
        &program,
        &snapshot(),
        &incoming(
            Event::Launched {
                input: serde_json::json!({}),
            },
            "launch",
        ),
    )
    .unwrap();
    let artifact_error = step(
        &program,
        &launched.snapshot,
        &incoming(
            Event::RevisionPublished {
                unit: UnitId::from("run/document"),
                artifact: SymbolKey::from("missing"),
                body: Value::Null,
                predecessor: None,
                subject: None,
                by: None,
            },
            "publish",
        ),
    )
    .unwrap_err();
    assert!(matches!(artifact_error, StepError::Rejected {
        entity: StepEntity::Artifact { unit, artifact }, ..
    } if unit.0 == "run/document" && artifact.0 == "missing"));

    let worker_error = step(
        &program,
        &launched.snapshot,
        &incoming(
            Event::RetryRequested {
                unit: UnitId::from("run/document"),
                worker: WorkerKey::from("missing"),
            },
            "retry",
        ),
    )
    .unwrap_err();
    assert!(matches!(worker_error, StepError::Rejected {
        entity: StepEntity::Worker { unit, worker }, ..
    } if unit.0 == "run/document" && worker.0 == "missing"));
}

/// W6 projection back to the frozen wire: only fields this cohort moved out
/// of stored state are reconstructed, so all other replay bytes still compare.
fn w6_projection(result: &StepResult) -> Value {
    let mut value = serde_json::to_value(result).unwrap();
    let root = &result.snapshot.run.root;
    let root_unit = result
        .snapshot
        .units
        .iter()
        .find(|unit| &unit.id == root)
        .unwrap();
    let blocked: std::collections::BTreeMap<_, _> = result
        .blocked
        .iter()
        .map(|block| (&block.unit.0, &block.reason))
        .collect();
    let snapshot = value["snapshot"].as_object_mut().unwrap();
    snapshot["run"]["status"] = serde_json::to_value(&root_unit.status).unwrap();
    snapshot["run"]["input"] = root_unit.input.clone().unwrap_or(Value::Null);
    for unit in snapshot["units"].as_array_mut().unwrap() {
        let id = unit["id"].as_str().unwrap().to_owned();
        let kind = unit.as_object_mut().unwrap().remove("kind").unwrap();
        unit.as_object_mut().unwrap().remove("collection_key");
        unit["stage"] = kind.get("stage").cloned().unwrap_or(Value::Null);
        if let Some(reason) = blocked.get(&id) {
            unit["status"] = serde_json::json!({"kind": "blocked", "reason": reason});
        }
    }
    for attempt in snapshot["attempts"].as_array_mut().unwrap() {
        let ended = matches!(
            attempt["status"]["kind"].as_str(),
            Some("succeeded" | "failed")
        );
        attempt["ended_at"] = if ended {
            attempt["seq"].clone()
        } else {
            Value::Null
        };
        attempt["cause"].as_object_mut().unwrap().remove("mode");
    }
    for revision in snapshot["revisions"].as_array_mut().unwrap() {
        revision.as_object_mut().unwrap().remove("seq");
    }
    for decision in snapshot["decisions"].as_array_mut().unwrap() {
        let kind = decision["kind"].as_str().unwrap().to_owned();
        decision.as_object_mut().unwrap().remove("kind");
        if kind == "validation" {
            let artifact = decision.as_object_mut().unwrap().remove("artifact");
            let messages = decision
                .as_object_mut()
                .unwrap()
                .remove("messages")
                .unwrap();
            assert!(artifact.is_some());
            decision["review"] = Value::String(VALIDATION_REVIEW.to_owned());
            decision["decision"] = Value::String("request_changes".to_owned());
            decision["effect"] = Value::String("request_changes".to_owned());
            decision["payload"] = serde_json::json!({"feedback": messages.as_array().unwrap()
                .iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")});
        } else {
            decision["effect"] =
                Value::String(decision["effect"]["kind"].as_str().unwrap().to_owned());
        }
    }
    for retry in snapshot["retry_events"].as_array_mut().unwrap() {
        *retry = serde_json::json!([retry["unit"], retry["worker"], retry["event"]]);
    }
    value.as_object_mut().unwrap().remove("blocked");
    for wanted in value["wanted"].as_array_mut().unwrap() {
        wanted["action"]["cause"]
            .as_object_mut()
            .unwrap()
            .remove("mode");
        for key in ["previous", "subject"] {
            if let Some(revision) = wanted["resolved"][key].as_object_mut() {
                revision.remove("seq");
            }
        }
    }
    value
}

#[test]
fn frozen_trace_replay_matches_after_w6_projection() {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for (name, trace) in [
        (
            "review-loop",
            include_str!("../../../fixtures/traces/review-loop.json"),
        ),
        (
            "fan-out",
            include_str!("../../../fixtures/traces/fan-out.json"),
        ),
        (
            "fan-out",
            include_str!("../../../fixtures/traces/fan-out-stall.json"),
        ),
    ] {
        let program = sample(name);
        let trace: Value = serde_json::from_str(trace).unwrap();
        let mut state = snapshot();
        for (row_number, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
            for (index, spec) in row["events"].as_array().unwrap().iter().enumerate() {
                let incoming = incoming(event(spec, &state), &format!("{row_number}:{index}"));
                let result = step(&program, &state, &incoming).unwrap();
                let bytes = serde_json::to_vec(&w6_projection(&result)).unwrap();
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(&bytes);
                state = result.snapshot;
            }
        }
    }
    assert_eq!(
        format!("{:x}", digest.finalize()),
        // The base corpus serialized through serde_json::Value has this
        // canonical-key-order digest; w6_projection restores its old shape.
        "a2789f0ab4dca05165fc2057758db525b679ae7b076c0a6a211c9b9146c24f8f"
    );
}
