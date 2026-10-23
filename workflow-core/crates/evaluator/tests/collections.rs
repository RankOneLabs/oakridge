//! Collection members are keyed by an expression evaluated against `each`,
//! not by extracting a record field index. These cover the general case and
//! the four rejections that survived the rework. The group here starts at
//! launch, so each rejection refuses the launch rather than stalling a run.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::compile_workflow;
use workflow_evaluator::{eval_expression, step, EvaluationContext};
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

fn deferred_program(run: Value, input: Value) -> CheckedWorkflow {
    let source: Workflow = serde_json::from_value(json!({
        "workflow": "deferred",
        "input": input,
        "run": run,
        "stages": {
            "producer": {
                "input": {},
                "artifacts": {"items": {"schema": "list({key: ident, text: text})"}},
                "workers": {"writer": {"kind": "agent", "prompts": {"initial": "item.md"},
                    "inputs": {}, "creates": ["items"]}},
                "done_when": "published(items)",
                "outcome": {"items": "latest(items)"}
            },
            "item": {"input": {"text": "text"}, "artifacts": {}, "workers": {},
                "done_when": "true", "outcome": {"result": "input.text"}},
            "summary": {"input": {"results": "list(text)"}, "artifacts": {}, "workers": {},
                "done_when": "true", "outcome": {"result": "input.results"}}
        }
    }))
    .unwrap();
    compile_workflow(
        &source,
        &[],
        &BTreeMap::from([("item.md".to_owned(), "".to_owned())]),
    )
    .unwrap()
}

#[test]
fn an_unmaterialized_collection_cannot_look_empty_to_its_dependents() {
    let program = deferred_program(
        json!({"units": {
            "producer": {"stage": "producer", "input": {}},
            "delayed": {"for_each": "producer.outcome.items", "key": "each.key",
                "stage": "item", "input": {"text": "each.text"}},
            "derived": {"for_each": "map(delayed, delayed.outcome.result)", "key": "each",
                "stage": "item", "input": {"text": "each"}},
            "summary": {"stage": "summary",
                "input": {"results": "map(derived, derived.outcome.result)"}},
            "tail": {"stage": "summary",
                "input": {"results": "summary.outcome.result"}}
        }, "outcome": {"results": "tail.outcome.result"}}),
        json!({}),
    );
    let result = step(
        &program,
        &snapshot(),
        &Incoming {
            event: Event::Launched { input: json!({}) },
            writer: Writer::Engine,
            ingress_id: Some("launch".into()),
        },
    )
    .unwrap();
    let ids: Vec<_> = result
        .snapshot
        .units
        .iter()
        .map(|unit| unit.id.0.as_str())
        .collect();
    assert_eq!(ids, ["run", "run/producer"]);
}

#[test]
fn per_member_after_retains_an_inferred_collection_prerequisite() {
    let program = deferred_program(
        json!({"units": {
            "producer": {"stage": "producer", "input": {}},
            "delayed": {"for_each": "producer.outcome.items", "key": "each.key",
                "stage": "item", "input": {"text": "each.text"}},
            "work": {"for_each": "input.members", "key": "each.key",
                "after": "each.after", "stage": "summary",
                "input": {"results": "map(delayed, delayed.outcome.result)"}}
        }, "outcome": {"results": "map(work, work.outcome.result)"}}),
        json!({"members": "list({key: ident, after: list(ident)})"}),
    );
    let result = step(
        &program,
        &snapshot(),
        &Incoming {
            event: Event::Launched {
                input: json!({"members": [{"key": "a", "after": []}]}),
            },
            writer: Writer::Engine,
            ingress_id: Some("launch".into()),
        },
    )
    .unwrap();
    assert!(result
        .snapshot
        .units
        .iter()
        .all(|unit| unit.declaration.0 != "work"));
}

#[test]
fn default_uses_the_fallback_when_lookup_has_no_unique_match() {
    let result = launch(json!([])).unwrap();
    let root = result
        .snapshot
        .units
        .iter()
        .find(|unit| unit.id.0 == "run")
        .unwrap();
    let literal = |value: Value| Expression::Literal {
        schema: SchemaId::from("text"),
        value,
    };
    let expression = Expression::Default {
        value: Box::new(Expression::Lookup {
            source: Box::new(literal(json!([{"key": "a"}]))),
            key_field: "key".into(),
            key: Box::new(literal(json!("missing"))),
        }),
        fallback: Box::new(literal(json!({"key": "fallback"}))),
    };
    let limits = ResourceLimits::default();
    let mut context = EvaluationContext::new(&limits);
    assert_eq!(
        eval_expression(
            &expression,
            root,
            &result.snapshot,
            None,
            None,
            &mut context
        )
        .unwrap(),
        Some(json!({"key": "fallback"}))
    );
}

#[test]
fn sibling_collections_with_the_same_member_keys_have_distinct_unit_ids() {
    let source: Workflow = serde_json::from_value(json!({
        "workflow": "siblings",
        "input": {"items": "list({key: ident, text: text})"},
        "run": {"units": {
            "first": {"for_each": "input.items", "key": "each.key", "stage": "item",
                "input": {"text": "each.text"}},
            "second": {"for_each": "input.items", "key": "each.key", "stage": "item",
                "input": {"text": "each.text"}}
        }, "outcome": {"first": "map(first, first.outcome.result)",
                       "second": "map(second, second.outcome.result)"}},
        "stages": {"item": {"input": {"text": "text"},
            "artifacts": {"result": {"schema": "text"}},
            "workers": {"worker": {"kind": "agent", "prompts": {"initial": "item.md"},
                "inputs": {"text": "input.text"}, "creates": ["result"]}},
            "done_when": "published(result)", "outcome": {"result": "latest(result)"}}}
    }))
    .unwrap();
    let prompts = BTreeMap::from([("item.md".to_owned(), "{{text}}".to_owned())]);
    let program = compile_workflow(&source, &[], &prompts).unwrap();
    let result = step(
        &program,
        &snapshot(),
        &Incoming {
            event: Event::Launched {
                input: json!({"items": [{"key": "a", "text": "A"}]}),
            },
            writer: Writer::Engine,
            ingress_id: Some("launch".into()),
        },
    )
    .unwrap();
    let ids: Vec<_> = result
        .snapshot
        .units
        .iter()
        .filter(|unit| unit.kind.stage().is_some())
        .map(|unit| unit.id.0.as_str())
        .collect();
    assert_eq!(ids, ["run/first/a", "run/second/a"]);
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
        .filter(|unit| unit.kind.stage().is_some())
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
    assert!(matches!(b.status, UnitStatus::NotStarted));
    assert!(result.blocked.iter().any(|blocked| blocked.unit == b.id));
}

#[test]
fn a_large_fan_out_schedules_workers_within_the_default_evaluation_budget() {
    let members: Vec<_> = (0..1_500)
        .map(|index| member(&format!("item-{index:04}"), json!([]), "text"))
        .collect();
    let result = launch(Value::Array(members)).unwrap();
    assert_eq!(result.wanted.len(), 1_500);
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
    assert_eq!(unit.input, Some(json!({"text": "text for only"})));
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
        result
            .snapshot
            .units
            .iter()
            .find(|unit| unit.id == result.snapshot.run.root)
            .unwrap()
            .status,
        UnitStatus::Done {
            outcome: json!({"results": []})
        }
    );
}
