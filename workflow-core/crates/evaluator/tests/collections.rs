//! Collection members are keyed by an expression evaluated against `each`,
//! not by extracting a record field index. These cover the general case and
//! the four rejections that survived the rework. The group here starts at
//! launch, so each rejection refuses the launch rather than stalling a run.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::compile_workflow;
use workflow_evaluator::step;
use workflow_model::*;

fn program() -> CheckedWorkflow {
    let source: Workflow = serde_json::from_value(json!({
        "workflow": "members",
        "input": {"items": "list({ meta: { key: text, after: list(text) }, text: text })"},
        "run": {
            "units": {"work": {
                "input": {"items": "input.items"},
                "group": {"units": {"item": {
                    "for_each": "input.items",
                    "key": "each.meta.key",
                    "after": "each.meta.after",
                    "stage": "item",
                    "input": {"text": "each.text"}
                }}, "outcome": {"results": "map(item, item.outcome.result)"}}
            }},
            "outcome": {"results": "work.outcome.results"}
        },
        "stages": {"item": {
            "input": {"text": "text"},
            "artifacts": {"result": {"schema": "text"}},
            "workers": {"worker": {"kind": "agent", "prompts": {"initial": "item.md"},
                                   "inputs": {"text": "input.text"}, "creates": ["result"]}},
            "done_when": "published(result)",
            "outcome": {"result": "latest(result)"}
        }}
    }))
    .unwrap();
    let prompts: BTreeMap<String, String> = [("item.md".to_owned(), "{{text}}".to_owned())]
        .into_iter()
        .collect();
    compile_workflow(&source, &[], &prompts).unwrap()
}

fn snapshot() -> StepSnapshot {
    StepSnapshot {
        run: RunState {
            id: "run".into(),
            root: UnitId::from("run"),
            status: UnitStatus::NotStarted,
            input: None,
        },
        units: vec![],
        attempts: vec![],
        revisions: vec![],
        decisions: vec![],
        retry_events: vec![],
    }
}

fn launch(items: Value) -> Result<StepResult, StepError> {
    step(
        &program(),
        &snapshot(),
        &Incoming {
            event: Event::Launched {
                input: json!({"items": items}),
            },
            writer: Writer::Engine,
            ingress_id: Some("launch".into()),
        },
    )
}

fn member(key: &str, after: Value, text: &str) -> Value {
    json!({"meta": {"key": key, "after": after}, "text": text})
}

#[test]
fn a_key_read_through_a_nested_path_materializes_every_member() {
    let result = launch(json!([
        member("a", json!([]), "A"),
        member("b", json!(["a"]), "B"),
    ]))
    .unwrap();
    let keys: Vec<_> = result
        .snapshot
        .units
        .iter()
        .filter(|unit| unit.stage.is_some())
        .map(|unit| unit.id.0.clone())
        .collect();
    assert_eq!(keys, vec!["run/work/a", "run/work/b"]);
    // The prerequisite came from the same nested path, so b waits for a.
    let b = result
        .snapshot
        .units
        .iter()
        .find(|unit| unit.id.0 == "run/work/b")
        .unwrap();
    assert_eq!(b.after, vec![UnitId::from("run/work/a")]);
    assert!(matches!(b.status, UnitStatus::Blocked { .. }));
}

#[test]
fn a_member_input_is_evaluated_against_its_own_each() {
    let result = launch(json!([member("only", json!([]), "text for only")])).unwrap();
    let unit = result
        .snapshot
        .units
        .iter()
        .find(|unit| unit.id.0 == "run/work/only")
        .unwrap();
    assert_eq!(unit.input, json!({"text": "text for only"}));
}

/// `ident` would refuse these at ingress; a `text` key reaches the member
/// guard, which applies the same ident rule, length bound included.
#[test]
fn a_key_that_is_not_an_ident_is_rejected() {
    for key in [
        "a/b".to_owned(),
        "a\u{7}b".to_owned(),
        String::new(),
        "k".repeat(101),
    ] {
        let error = launch(json!([member(&key, json!([]), "T")])).unwrap_err();
        assert!(
            matches!(&error, StepError::Rejected { reason, .. } if reason.contains("illegal or duplicate key")),
            "{key:?} produced {error:?}"
        );
    }
}

#[test]
fn a_duplicate_member_key_is_rejected() {
    let error = launch(json!([
        member("same", json!([]), "one"),
        member("same", json!([]), "two"),
    ]))
    .unwrap_err();
    assert!(
        matches!(&error, StepError::Rejected { reason, .. } if reason.contains("illegal or duplicate key")),
        "{error:?}"
    );
}

#[test]
fn a_prerequisite_naming_no_member_is_rejected() {
    let error = launch(json!([member("a", json!(["absent"]), "A")])).unwrap_err();
    assert!(
        matches!(&error, StepError::Rejected { reason, .. } if reason.contains("missing member")),
        "{error:?}"
    );
}

#[test]
fn a_cycle_among_members_is_rejected() {
    let error = launch(json!([
        member("a", json!(["b"]), "A"),
        member("b", json!(["a"]), "B"),
    ]))
    .unwrap_err();
    assert!(
        matches!(&error, StepError::Rejected { reason, .. } if reason.contains("cyclic prerequisite")),
        "{error:?}"
    );
}

#[test]
fn a_collection_over_an_empty_list_completes_at_launch() {
    let result = launch(json!([])).unwrap();
    assert_eq!(
        result.snapshot.run.status,
        UnitStatus::Done {
            outcome: json!({"results": []})
        }
    );
}
