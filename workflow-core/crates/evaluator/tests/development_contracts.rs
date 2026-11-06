//! Contract checks use the complete, committed development source and prompts.
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
use workflow_evaluator::{eval_expression, step, EvaluationContext};
use workflow_model::*;

fn development() -> CheckedWorkflow {
    let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let operations: Vec<CodeOperation> =
        serde_json::from_slice(&std::fs::read(config.join("operation-registry.json")).unwrap())
            .unwrap();
    let prompts: BTreeMap<String, String> = std::fs::read_dir(config.join("prompts/development"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                format!(
                    "development/{}",
                    path.file_name().unwrap().to_str().unwrap()
                ),
                std::fs::read_to_string(path).unwrap(),
            )
        })
        .collect();
    let source = workflow_compiler::decode_workflow(include_bytes!(
        "../../../fixtures/bundles/development.json"
    ))
    .unwrap();
    workflow_compiler::compile_workflow(&source, &operations, &prompts).unwrap()
}

fn unit(stage: &str, input: Value) -> UnitState {
    UnitState {
        id: "run".into(),
        parent: None,
        declaration: stage.into(),
        kind: UnitKind::Stage(stage.into()),
        collection_key: None,
        status: UnitStatus::Active,
        input: Some(input),
        after: vec![],
        pool: None,
    }
}

fn snapshot(owner: UnitState) -> StepSnapshot {
    StepSnapshot {
        run: RunState {
            id: "run".into(),
            root: "run".into(),
        },
        units: vec![owner],
        attempts: vec![],
        revisions: vec![],
        decisions: vec![],
        retry_events: vec![],
    }
}

fn workspace() -> Value {
    json!({"repository_path":"/tmp/repo", "push_remote_owner":"owner", "head":"abc123", "base_branch":"develop"})
}

fn criteria(ids: &[&str]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| json!({"id": id, "text":"works", "task_ids":[], "decision_ids":[]}))
            .collect(),
    )
}

fn cohort(id: &str, ids: &[&str]) -> Value {
    json!({"id":id, "repository_key":"app", "title":id, "scope":"part", "depends_on":[],
        "description":null, "files_in_scope":[], "decisions":[], "acceptance_criteria":criteria(ids)})
}

fn publish(program: &CheckedWorkflow, owner: UnitState, artifact: &str, body: Value) -> StepResult {
    step(
        program,
        &snapshot(owner),
        &Incoming {
            event: Event::RevisionPublished {
                unit: "run".into(),
                artifact: artifact.into(),
                body,
                predecessor: None,
                subject: None,
                by: None,
            },
            writer: Writer::Operator {
                subject: "test".into(),
            },
            ingress_id: Some("publish".into()),
        },
    )
    .unwrap()
}

fn validation_messages(result: &StepResult) -> Vec<String> {
    result
        .snapshot
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            DecisionState::Validation { messages, .. } => Some(messages.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn approval(review: &str, revision: &RevisionState) -> Incoming {
    Incoming {
        event: Event::OperatorDecided {
            unit: revision.unit.clone(),
            review: review.into(),
            decision: "accept".into(),
            target: revision.id.clone(),
            payload: json!({}),
        },
        writer: Writer::Operator {
            subject: "test".into(),
        },
        ingress_id: Some("accept".into()),
    }
}

#[test]
fn a_plan_with_criterion_ids_repeated_across_cohorts_is_rejected_by_validation() {
    let program = development();
    for (second_id, expected) in [
        (
            "AC01",
            vec![
                "Every acceptance criterion id must be unique across the plan's cohorts."
                    .to_owned(),
            ],
        ),
        ("AC02", vec![]),
    ] {
        let input = json!({"spec":"spec", "tasks":{"tasks":[]}, "repositories":[{"key":"app"}], "repository_key":"app", "workspace":workspace()});
        let body = json!({"summary":"plan", "cohorts":[cohort("a", &["AC01"]), cohort("b", &[second_id])],
            "dependency_order":["a", "b"], "scope":{"in_scope":[], "out_of_scope":[]}, "acceptance_criteria":[], "risks":[]});
        assert_eq!(
            validation_messages(&publish(&program, unit("planning", input), "plan", body)),
            expected
        );
    }
}

#[test]
fn a_plan_with_duplicate_criterion_ids_cannot_be_approved() {
    let program = development();
    let input = json!({"spec":"spec", "tasks":{"tasks":[]}, "repositories":[{"key":"app"}], "repository_key":"app", "workspace":workspace()});
    let body = json!({"summary":"plan", "cohorts":[cohort("a", &["AC01"]), cohort("b", &["AC01"])],
        "dependency_order":["a", "b"], "scope":{"in_scope":[], "out_of_scope":[]}, "acceptance_criteria":[], "risks":[]});
    let published = publish(&program, unit("planning", input), "plan", body);
    let revision = published.snapshot.revisions.last().unwrap();

    assert!(matches!(
        step(&program, &published.snapshot, &approval("plan_review", revision)),
        Err(StepError::Rejected { reason, .. }) if reason.contains("failed validation")
    ));
}

#[test]
fn an_invalid_plan_offers_changes_but_no_approval() {
    let program = development();
    let input = json!({"spec":"spec", "tasks":{"tasks":[]}, "repositories":[{"key":"app"}], "repository_key":"app", "workspace":workspace()});
    let body = json!({"summary":"plan", "cohorts":[cohort("a", &["AC01"]), cohort("b", &["AC01"])],
        "dependency_order":["a", "b"], "scope":{"in_scope":[], "out_of_scope":[]}, "acceptance_criteria":[], "risks":[]});
    let published = publish(&program, unit("planning", input), "plan", body);
    let decisions: Vec<_> = published
        .reviews
        .iter()
        .flat_map(|review| &review.decisions)
        .map(|decision| decision.decision.0.as_str())
        .collect();

    assert_eq!(decisions, vec!["request_changes"]);
}

#[test]
fn a_brief_must_keep_its_cohorts_criterion_membership_and_order() {
    let program = development();
    for ids in [
        &["AC01", "AC02"][..],
        &["AC02", "AC01"][..],
        &["AC01", "AC03"][..],
        &["AC01"][..],
    ] {
        let input = json!({"cohort":cohort("a", &["AC01", "AC02"]), "spec":"spec", "workspace":workspace()});
        let body = json!({"cohort_id":"a", "repository_key":"app", "title":"a", "depends_on":[], "goal":"build",
            "files_in_scope":[], "decisions_made":[], "approaches_rejected":[], "acceptance_criteria":criteria(ids), "next_action":"build"});
        let expected = if ids == ["AC01", "AC02"] {
            vec![]
        } else {
            vec![
                "The brief's acceptance criteria must be its plan cohort's, in the same order."
                    .to_owned(),
            ]
        };
        assert_eq!(
            validation_messages(&publish(&program, unit("brief", input), "brief", body)),
            expected
        );
    }
}

#[test]
fn a_brief_with_changed_criterion_membership_or_order_cannot_be_approved() {
    let program = development();
    for ids in [&["AC02", "AC01"][..], &["AC01", "AC03"][..], &["AC01"][..]] {
        let input = json!({"cohort":cohort("a", &["AC01", "AC02"]), "spec":"spec", "workspace":workspace()});
        let body = json!({"cohort_id":"a", "repository_key":"app", "title":"a", "depends_on":[], "goal":"build",
            "files_in_scope":[], "decisions_made":[], "approaches_rejected":[], "acceptance_criteria":criteria(ids), "next_action":"build"});
        let published = publish(&program, unit("brief", input), "brief", body);
        let revision = published.snapshot.revisions.last().unwrap();

        assert!(
            matches!(
                step(&program, &published.snapshot, &approval("brief_review", revision)),
                Err(StepError::Rejected { reason, .. }) if reason.contains("failed validation")
            ),
            "{ids:?}"
        );
    }
}

#[test]
fn correcting_duplicate_criterion_ids_restores_approval() {
    let program = development();
    let input = json!({"spec":"spec", "tasks":{"tasks":[]}, "repositories":[{"key":"app"}], "repository_key":"app", "workspace":workspace()});
    let mut body = json!({"summary":"plan", "cohorts":[cohort("a", &["AC01"]), cohort("b", &["AC01"])],
        "dependency_order":["a", "b"], "scope":{"in_scope":[], "out_of_scope":[]}, "acceptance_criteria":[], "risks":[]});
    let published = publish(&program, unit("planning", input), "plan", body.clone());
    body["cohorts"][1]["acceptance_criteria"] = criteria(&["AC02"]);
    let corrected = step(
        &program,
        &published.snapshot,
        &Incoming {
            event: Event::RevisionPublished {
                unit: "run".into(),
                artifact: "plan".into(),
                body,
                predecessor: Some(published.snapshot.revisions.last().unwrap().id.clone()),
                subject: None,
                by: None,
            },
            writer: Writer::Operator {
                subject: "test".into(),
            },
            ingress_id: Some("correct-plan".into()),
        },
    )
    .unwrap();
    let revision = corrected.snapshot.revisions.last().unwrap();
    let accepted = step(
        &program,
        &corrected.snapshot,
        &approval("plan_review", revision),
    )
    .unwrap();

    assert!(matches!(
        accepted.snapshot.units[0].status,
        UnitStatus::Done { .. }
    ));
}

#[test]
fn an_invalid_plan_still_accepts_an_explicit_request_for_changes() {
    let program = development();
    let input = json!({"spec":"spec", "tasks":{"tasks":[]}, "repositories":[{"key":"app"}], "repository_key":"app", "workspace":workspace()});
    let body = json!({"summary":"plan", "cohorts":[cohort("a", &["AC01"]), cohort("b", &["AC01"])],
        "dependency_order":["a", "b"], "scope":{"in_scope":[], "out_of_scope":[]}, "acceptance_criteria":[], "risks":[]});
    let published = publish(&program, unit("planning", input), "plan", body);
    let revision = published.snapshot.revisions.last().unwrap();
    let mut incoming = approval("plan_review", revision);
    if let Event::OperatorDecided {
        decision, payload, ..
    } = &mut incoming.event
    {
        *decision = "request_changes".into();
        *payload = json!({"feedback":"Give the second criterion a distinct id."});
    }
    let changed = step(&program, &published.snapshot, &incoming).unwrap();

    assert!(matches!(
        changed.snapshot.decisions.last(),
        Some(DecisionState::Review {
            effect: DecisionEffect::RequestChanges { .. },
            ..
        })
    ));
}

#[test]
fn each_integrator_receives_only_its_repositorys_briefs() {
    let program = development();
    let integration = program
        .root
        .units
        .iter()
        .find(|unit| unit.key.0 == "integration")
        .unwrap();
    let brief_input = integration
        .input
        .iter()
        .find(|field| field.key == "briefs")
        .unwrap();
    let stage = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "integration")
        .unwrap();
    let CheckedWorker::Agent { inputs, .. } = stage
        .workers
        .iter()
        .find(|worker| worker.key().0 == "integrator")
        .unwrap()
    else {
        panic!("agent")
    };
    let worker_briefs = inputs.iter().find(|field| field.key == "briefs").unwrap();
    let mut root = unit("root", json!({}));
    root.kind = UnitKind::Group;
    let mut state = snapshot(root.clone());
    let briefs = json!([
        {"cohort_id":"a", "repository_key":"app", "acceptance_criteria":criteria(&["AC01"])},
        {"cohort_id":"b", "repository_key":"lib", "acceptance_criteria":criteria(&["AC02"])},
        {"cohort_id":"c", "repository_key":"app", "acceptance_criteria":criteria(&["AC03"])}]);
    for brief in briefs.as_array().unwrap() {
        let mut child = unit("brief", json!({}));
        child.id =
            UnitId::from(format!("run/briefs/{}", brief["cohort_id"].as_str().unwrap()).as_str());
        child.parent = Some(root.id.clone());
        child.declaration = "briefs".into();
        child.status = UnitStatus::Done {
            outcome: json!({"brief":brief}),
        };
        state.units.push(child);
    }
    for key in ["app", "lib"] {
        let each = json!({"key":key});
        let limits = ResourceLimits::default();
        let mut context = EvaluationContext::new(&limits);
        let received = eval_expression(
            &brief_input.value.expression,
            &root,
            &state,
            Some(&each),
            None,
            &mut context,
        )
        .unwrap()
        .unwrap();
        let integrator = unit("integration", json!({"briefs":received}));
        let actual = eval_expression(
            &worker_briefs.value.expression,
            &integrator,
            &state,
            None,
            None,
            &mut context,
        )
        .unwrap();
        let expected: Vec<_> = briefs
            .as_array()
            .unwrap()
            .iter()
            .filter(|brief| brief["repository_key"] == key)
            .cloned()
            .collect();
        assert_eq!(actual, Some(json!(expected)));
    }
}
