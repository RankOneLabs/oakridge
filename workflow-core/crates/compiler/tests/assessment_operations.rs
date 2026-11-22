use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{
    assessment_embeddings, compile_workflow_detailed, decode_workflow_value_detailed, CompileError,
};
use workflow_model::{DecisionOperation, PathSegment, SymbolKey, Workflow};

fn source() -> Value {
    json!({
        "workflow": "assessment_operations", "input": {},
        "schemas": {"observation": {"fix": "optional(feedback_proposal)"}},
        "run": {"units": {"work": {"stage": "work"}}, "outcome": {}},
        "stages": {"work": {
            "input": {}, "outcome": {}, "done_when": "approved(assessment)",
            "artifacts": {
                "draft": {"kind": "record", "schema": "text"},
                "assessment": {"kind": "assessment", "schema": {
                    "findings": "list(observation)", "work": {"proposed": "feedback_proposal"},
                    "checks": "list(assignment_verification)"
                }}
            },
            "workers": {
                "builder": {"kind":"agent","inputs":{},"prompts": {"initial": "p", "revise": "p"}, "produces": ["draft"]},
                "assessor": {"kind":"agent","inputs":{},"prompts": {"review": "p", "revise": "p"}, "evaluates": "draft", "produces": ["assessment"]}
            },
            "reviews": {"review": {"of": "assessment", "by": "operator", "prompt": "p", "decisions": {
                "approve": {"label": "Approve", "effect": "approve", "operation": "approve_assessment"},
                "send": {"label": "Send", "effect": "request_changes", "operation": "dispatch_feedback", "on": "draft"},
                "correct": {"label": "Correct", "effect": "request_changes", "operation": "direct_correction", "on": "draft"}
            }}}
        }}
    })
}

fn compile(raw: Value) -> Result<Workflow, Vec<CompileError>> {
    let source = decode_workflow_value_detailed(raw)?;
    compile_workflow_detailed(&source, &[], &BTreeMap::from([("p".into(), String::new())]))?;
    Ok(source)
}

const STAGE: &str = "/stages/work";
const REVIEW: &str = "/stages/work/reviews/review";
const DECISIONS: &str = "/stages/work/reviews/review/decisions";

#[test]
fn arbitrary_nested_names_emit_proposal_paths() {
    let workflow = compile(source()).unwrap();
    let stage = &assessment_embeddings(&workflow)[&SymbolKey::from("work")];
    let embeddings = &stage[&SymbolKey::from("assessment")];
    use PathSegment::{Each, Field};
    assert_eq!(
        embeddings.proposals,
        [
            vec![Field("findings".into()), Each, Field("fix".into())],
            vec![Field("work".into()), Field("proposed".into())],
        ]
    );
    assert_eq!(
        embeddings.verifications,
        [vec![Field("checks".into()), Each]]
    );
}

#[test]
fn operations_enforce_declared_effect_and_target() {
    for (decision, field, replacement, detail) in [
        (
            "approve",
            "effect",
            "request_changes",
            "requires effect approve",
        ),
        (
            "send",
            "effect",
            "approve",
            "requires effect request_changes",
        ),
        (
            "correct",
            "effect",
            "approve",
            "requires effect request_changes",
        ),
        ("send", "on", "unknown", "requires on"),
        ("correct", "on", "unknown", "requires on"),
    ] {
        let mut value = source();
        value.pointer_mut(DECISIONS).unwrap()[decision][field] = json!(replacement);
        let path = format!("stages.work.reviews.review.decisions.{decision}.operation");
        assert!(compile(value)
            .unwrap_err()
            .iter()
            .any(|e| e.path.0 == path && e.detail.contains(detail)));
    }
    let mut value = source();
    value.pointer_mut(REVIEW).unwrap()["of"] = json!("draft");
    assert!(compile(value).unwrap_err().iter().any(|error| error
        .detail
        .contains("requires an operator review of an assessment")));
}

#[test]
fn authored_legacy_fields_and_assessment_payload_are_rejected() {
    // These concatenations keep repository-wide searches for retired constructs
    // focused on implementations while still exercising the literal wire spellings.
    let retired = concat!("adjud", "ication");
    for (field, value) in [
        (retired, "accept"),
        ("feedback_field", "x"),
        ("payload", retired),
    ] {
        let mut raw = source();
        raw.pointer_mut(DECISIONS).unwrap()["approve"][field] = json!(value);
        let errors = compile(raw).unwrap_err();
        assert!(
            errors.iter().any(|error| error
                .path
                .0
                .contains("stages.work.reviews.review.decisions.approve")
                && error.detail.contains(field)),
            "{errors:?}"
        );
    }
}

#[test]
fn operation_from_decision_set_override_expands() {
    let mut raw = source();
    let decisions = raw.pointer(DECISIONS).unwrap().clone();
    raw["decisions"] = json!({"ops": decisions});
    raw["decisions"]["ops"]["approve"]
        .as_object_mut()
        .unwrap()
        .remove("operation");
    *raw.pointer_mut(DECISIONS).unwrap() =
        json!({"set":"ops","overrides":{"approve":{"operation":"approve_assessment"}}});
    let workflow = compile(raw).unwrap();
    assert_eq!(
        workflow.stages["work"].reviews["review"].decisions["approve"].operation,
        DecisionOperation::ApproveAssessment
    );
}

#[test]
fn proposal_coverage_follows_type_instead_of_field_name() {
    let mut raw = source();
    raw.pointer_mut(DECISIONS)
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("send");
    assert!(compile(raw.clone())
        .unwrap_err()
        .iter()
        .any(|e| e.detail.contains("embeds feedback_proposal but no review")));
    let schema = &mut raw.pointer_mut(STAGE).unwrap()["artifacts"]["assessment"]["schema"];
    *schema = json!({(concat!("next_", "actions")): "list(text)"});
    assert!(compile(raw).is_ok());
}

#[test]
fn verification_requires_a_proposal_embedding() {
    let mut raw = source();
    raw.pointer_mut(STAGE).unwrap()["artifacts"]["assessment"]["schema"] =
        json!("list(assignment_verification)");
    assert!(compile(raw).unwrap_err().iter().any(|e| e
        .detail
        .contains("assignment_verification requires feedback_proposal")));
}

#[test]
fn authored_schemas_cannot_shadow_builtin_assessment_types() {
    let mut raw = source();
    raw["schemas"]["feedback_proposal"] = json!("text");
    assert!(compile(raw)
        .unwrap_err()
        .iter()
        .any(|e| e.detail == "schema feedback_proposal shadows a core type"));
}

#[test]
fn display_declarations_validate_and_project() {
    let mut raw = source();
    raw["input"] = json!({"caption":"text","targets":"list(ident)"});
    raw["label"] = json!({"title":"input.caption","repositories":"input.targets"});
    raw["stages"]["work"]["artifacts"]["draft"]["kind"] = json!("external_reference");
    raw["stages"]["work"]["artifacts"]["draft"]["view"] = json!("custom_viewer");
    raw["stages"]["work"]["workers"]["builder"]["label"] = json!("Author");
    let workflow = compile(raw.clone()).unwrap();
    assert_eq!(workflow.stages["work"].reviews["review"].wait, workflow_model::ReviewWait::Operator);
    raw["stages"]["work"]["reviews"]["release"] = json!({
        "by":"operator","of":"draft","wait":"external","confirms":"merge","prompt":"p",
        "decisions":{"land":{"effect":"approve","label":"Land"}}
    });
    let workflow = compile(raw.clone()).unwrap();
    let stage = &workflow.stages["work"];
    assert_eq!(stage.artifacts["draft"].view.as_deref(), Some("custom_viewer"));
    assert_eq!(stage.reviews["release"].wait, workflow_model::ReviewWait::External);
    assert_eq!(stage.reviews["release"].confirms, Some(workflow_model::ReviewConfirms::Merge));
    assert!(matches!(&stage.workers["builder"], workflow_model::Worker::Agent {
        label: Some(label), .. } if label == "Author"));

    raw["label"]["title"] = json!("input.targets");
    raw["stages"]["work"]["reviews"]["release"]["by"] = json!("engine");
    let errors = compile(raw).unwrap_err();
    assert!(errors.iter().any(|error| error.path.0 == "label.title"));
    assert!(errors.iter().any(|error| error.path.0.ends_with("release.confirms")));
    assert!(errors.iter().any(|error| error.path.0.ends_with("release.wait")));
}


#[test]
fn external_reference_projects_the_declared_link_field() {
    let mut raw = source();
    raw["stages"]["work"]["artifacts"]["draft"] = json!({
        "kind":"external_reference","schema":{"remote_link":"text"},"link_field":"remote_link"
    });
    let workflow = compile(raw.clone()).unwrap();
    assert_eq!(workflow.stages["work"].artifacts["draft"].link_field.as_ref().map(|key| key.0.as_str()), Some("remote_link"));

    raw["stages"]["work"]["artifacts"]["draft"]["schema"]["remote_link"] = json!("integer");
    let errors = compile(raw).unwrap_err();
    assert!(errors.iter().any(|error| error.path.0.ends_with("draft.link_field")));
}
