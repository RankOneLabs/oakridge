use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{
    compile_workflow_detailed, compile_workflow_with_limits_and_resolved_detailed, decode_workflow,
};
use workflow_model::{ResourceLimits, Type};

fn source() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap()
}

fn prompts() -> BTreeMap<String, String> {
    [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{topic}} {{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}} {{critique}}"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect()
}

fn stage(input: Value, outcome: Value) -> Value {
    json!({
        "input": input,
        "artifacts": {},
        "workers": {},
        "done_when": "true",
        "outcome": outcome,
    })
}

#[test]
fn outcome_dependencies_resolve_before_dependent_inference() {
    let mut value = source();
    value["stages"]["a"] = stage(json!("{}"), json!({"x": "1"}));
    value["stages"]["b"] = stage(json!("outcome_of(a)"), json!({"y": "input.x"}));
    value["stages"]["c"] = stage(json!("outcome_of(b)"), json!({"z": "input.y"}));
    value["schemas"]["future"] = "outcome_of(c)".into();
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let (_, resolved) = compile_workflow_with_limits_and_resolved_detailed(
        &source,
        &[],
        &prompts(),
        &ResourceLimits::default(),
    )
    .unwrap();
    assert_eq!(
        resolved.schemas["future"],
        Type::Record {
            fields: BTreeMap::from([("z".into(), Type::Integer)])
        }
    );
}

#[test]
fn recursive_alias_is_rejected_before_comparison_inference() {
    let mut value = source();
    value["schemas"]["loop"] = "optional(loop)".into();
    value["stages"]["a"] = stage(json!({"value": "loop"}), json!({"ok": "input.value == 0"}));
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(&source, &[], &prompts()).unwrap_err();
    assert!(
        errors.iter().any(
            |error| error.path.0 == "schemas.loop" && error.detail.contains("recursive schema")
        ),
        "{errors:?}"
    );
}

#[test]
fn outcome_cycles_report_the_dependent_input() {
    let mut value = source();
    value["stages"]["a"] = stage(json!("outcome_of(b)"), json!({"x": "1"}));
    value["stages"]["b"] = stage(json!("outcome_of(a)"), json!({"y": "1"}));
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(&source, &[], &prompts()).unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.path.0.starts_with("stages.")
                && error.path.0.ends_with(".input")
                && error.detail.contains("recursive outcome_of")),
        "{errors:?}"
    );
}

#[test]
fn outcome_inference_failure_reports_its_field() {
    let mut value = source();
    value["stages"]["a"] = stage(
        json!("{}"),
        json!({
            "x": "input.missing",
            "y": "input.absent",
        }),
    );
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(&source, &[], &prompts()).unwrap_err();
    for field in ["x", "y"] {
        assert!(
            errors
                .iter()
                .any(|error| error.path.0 == format!("stages.a.outcome.{field}")
                    && error.detail.contains("absent")),
            "{errors:?}"
        );
    }
}
