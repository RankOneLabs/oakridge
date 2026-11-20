use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{
    compile_workflow_detailed, compile_workflow_with_limits_and_projection_detailed,
    decode_workflow_value_detailed, CheckKind, CompileError,
};
use workflow_model::{
    AdjudicationRole, AuthoredReviewDefinition, CheckedWorkflow, ResourceLimits, Review, Workflow,
};

const REVIEW_PATH: &str = "stages.document.reviews.assessment_review";

fn adjudicating_source() -> Value {
    json!({
        "workflow": "adjudication", "input": {},
        "run": {"units": {"a": {"stage": "document"}}, "outcome": {}},
        "stages": {
            "document": {
                "input": {},
                "artifacts": {
                    "draft": {"kind": "record", "schema": {"findings": "list(text)", "text": "text"}},
                    "assessment": {"kind": "assessment", "schema": "text"}
                },
                "workers": {
                    "writer": {"kind": "agent", "inputs": {}, "prompts": {"initial": "p", "revise": "p"}, "produces": ["draft"]},
                    "assessor": {"kind": "agent", "inputs": {}, "prompts": {"review": "p", "revise": "p"}, "produces": ["assessment"], "evaluates": "draft"}
                },
                "reviews": {
                    "assessment_review": {
                        "of": "assessment", "by": "operator", "prompt": "p",
                        "decisions": {
                            "accept": {"effect": "approve", "label": "Accept", "adjudication": "accept", "payload": {"entries": "list(text)"}},
                            "request_build_changes": {
                                "effect": "request_changes", "label": "Build", "on": "draft", "adjudication": "feedback",
                                "payload": {"entries": "list(text)", "builder_feedback": "text"}, "feedback_field": "builder_feedback"
                            },
                            "request_assessment_changes": {"effect": "request_changes", "label": "Assess"}
                        }
                    }
                },
                "done_when": "approved(draft)", "outcome": {}
            }
        }
    })
}

fn review_value(value: &mut Value) -> &mut Value {
    &mut value["stages"]["document"]["reviews"]["assessment_review"]
}

fn expanded_review(workflow: &Workflow) -> &Review {
    &workflow.stages["document"].reviews["assessment_review"]
}

fn prompts() -> BTreeMap<String, String> {
    BTreeMap::from([("p".into(), String::new())])
}

fn compile(value: Value) -> Result<CheckedWorkflow, Vec<CompileError>> {
    let workflow = decode_workflow_value_detailed(value)?;
    compile_workflow_detailed(&workflow, &[], &prompts())
}

fn assert_review_error(value: Value, path: &str, detail: &str) {
    let errors = compile(value).unwrap_err();
    assert!(
        errors.iter().any(|error| {
            error.check == CheckKind::Review && error.path.0 == path && error.detail == detail
        }),
        "missing {path}: {detail} in {errors:?}"
    );
}

fn plain_review(value: &mut Value) {
    for decision in review_value(value)["decisions"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        decision.as_object_mut().unwrap().remove("adjudication");
    }
}

#[test]
fn inline_accept_role_decodes_and_serializes_in_snake_case() {
    let workflow = decode_workflow_value_detailed(adjudicating_source()).unwrap();
    let decision = &expanded_review(&workflow).decisions["accept"];
    assert_eq!(decision.adjudication, Some(AdjudicationRole::Accept));
    assert_eq!(
        serde_json::to_value(decision).unwrap()["adjudication"],
        "accept"
    );
}

#[test]
fn decision_set_override_expands_feedback_role() {
    let mut value = adjudicating_source();
    let mut decisions = review_value(&mut value)["decisions"].take();
    decisions["request_build_changes"]
        .as_object_mut()
        .unwrap()
        .remove("adjudication");
    value["decisions"] = json!({"assessment": decisions});
    review_value(&mut value)["decisions"] = json!({
        "set": "assessment",
        "overrides": {"request_build_changes": {"adjudication": "feedback"}}
    });
    let workflow = decode_workflow_value_detailed(value).unwrap();
    let decision = &expanded_review(&workflow).decisions["request_build_changes"];
    assert_eq!(decision.adjudication, Some(AdjudicationRole::Feedback));
    assert_eq!(
        serde_json::to_value(decision).unwrap()["adjudication"],
        "feedback"
    );
}

#[test]
fn omitted_role_and_assessment_stay_absent_in_serialized_source() {
    let workflow = decode_workflow_value_detailed(adjudicating_source()).unwrap();
    let review = expanded_review(&workflow);
    assert_eq!(review.assessment, None);
    assert_eq!(
        review.decisions["request_assessment_changes"].adjudication,
        None
    );
    let serialized = serde_json::to_value(review).unwrap();
    assert!(serialized.get("assessment").is_none());
    assert!(serialized["decisions"]["request_assessment_changes"]
        .get("adjudication")
        .is_none());
}

#[test]
fn unknown_role_is_a_schema_error() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["accept"]["adjudication"] = json!("builder");
    let errors = decode_workflow_value_detailed(value).unwrap_err();
    assert!(errors.iter().any(|error| error.check == CheckKind::Schema));
}

#[test]
fn concrete_assessment_decodes_in_authored_and_expanded_source() {
    let mut value = adjudicating_source();
    let review = review_value(&mut value);
    review["assessment"] = json!("slice_assessment");
    let authored: AuthoredReviewDefinition = serde_json::from_value(review.clone()).unwrap();
    assert_eq!(authored.assessment.unwrap().0, "slice_assessment");
    let workflow = decode_workflow_value_detailed(value).unwrap();
    assert_eq!(
        expanded_review(&workflow).assessment.as_ref().unwrap().0,
        "slice_assessment"
    );
}

#[test]
fn review_template_override_expands_assessment() {
    let mut value = adjudicating_source();
    let mut template = review_value(&mut value).take();
    template["assessment"] = json!("template_assessment");
    value["reviews"] = json!({"t": template});
    *review_value(&mut value) = json!({"template": "t", "overrides": {"assessment": "x"}});
    let workflow = decode_workflow_value_detailed(value).unwrap();
    assert_eq!(
        expanded_review(&workflow).assessment.as_ref().unwrap().0,
        "x"
    );
}

#[test]
fn projection_fills_implied_assessment_for_adjudicating_review() {
    let workflow = decode_workflow_value_detailed(adjudicating_source()).unwrap();
    let (_, projected) = compile_workflow_with_limits_and_projection_detailed(
        &workflow,
        &[],
        &prompts(),
        &ResourceLimits::default(),
    )
    .unwrap();
    assert_eq!(
        expanded_review(&projected).assessment.as_ref().unwrap().0,
        "assessment"
    );
}

#[test]
fn projection_leaves_assessment_absent_for_plain_review() {
    let mut value = adjudicating_source();
    plain_review(&mut value);
    let workflow = decode_workflow_value_detailed(value).unwrap();
    let (_, projected) = compile_workflow_with_limits_and_projection_detailed(
        &workflow,
        &[],
        &prompts(),
        &ResourceLimits::default(),
    )
    .unwrap();
    assert_eq!(expanded_review(&projected).assessment, None);
}

#[test]
fn adjudicating_review_accepts_plain_request_changes() {
    compile(adjudicating_source()).unwrap();
}

#[test]
fn plain_review_accepts_approve_and_request_changes() {
    let mut value = adjudicating_source();
    plain_review(&mut value);
    compile(value).unwrap();
}

#[test]
fn accept_role_requires_approve_effect() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["accept"]["effect"] = json!("request_changes");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.accept.adjudication"),
        "adjudication accept requires effect approve",
    );
}

#[test]
fn feedback_role_requires_request_changes_effect() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["request_build_changes"]["effect"] = json!("approve");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.request_build_changes.adjudication"),
        "adjudication feedback requires effect request_changes",
    );
}

#[test]
fn approve_requires_accept_role_on_adjudicating_review() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["plain_approve"] =
        json!({"effect": "approve", "label": "Plain approve"});
    assert_review_error(value, &format!("{REVIEW_PATH}.decisions.plain_approve.adjudication"),
        "approve decision plain_approve on adjudicating review assessment_review must be adjudication accept");
}

#[test]
fn accept_role_requires_payload() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["accept"]
        .as_object_mut()
        .unwrap()
        .remove("payload");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.accept.payload"),
        "adjudication decision accept requires a payload",
    );
}

#[test]
fn feedback_role_requires_payload() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["request_build_changes"]
        .as_object_mut()
        .unwrap()
        .remove("payload");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.request_build_changes.payload"),
        "adjudication decision request_build_changes requires a payload",
    );
}

#[test]
fn feedback_role_requires_feedback_field() {
    let mut value = adjudicating_source();
    review_value(&mut value)["decisions"]["request_build_changes"]
        .as_object_mut()
        .unwrap()
        .remove("feedback_field");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.request_build_changes.feedback_field"),
        "feedback decision request_build_changes requires feedback_field",
    );
}

#[test]
fn adjudicating_review_rejects_a_second_feedback_decision() {
    let mut value = adjudicating_source();
    let decisions = &mut review_value(&mut value)["decisions"];
    decisions["request_more_changes"] = decisions["request_build_changes"].clone();
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.request_more_changes.adjudication"),
        "review assessment_review has more than one feedback decision",
    );
}

#[test]
fn engine_review_rejects_adjudication() {
    let mut value = adjudicating_source();
    *review_value(&mut value) = json!({
        "of": "assessment", "by": "engine", "when": "true",
        "decisions": {"fix": {"effect": "request_changes", "label": "Fix", "feedback": "Try again", "adjudication": "feedback"}}
    });
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.decisions.fix.adjudication"),
        "engine review assessment_review cannot declare adjudication",
    );
}

#[test]
fn explicit_assessment_equal_to_review_target_compiles() {
    let mut value = adjudicating_source();
    review_value(&mut value)["assessment"] = json!("assessment");
    compile(value).unwrap();
}

#[test]
fn assessment_binding_requires_assessment_artifact_kind() {
    let mut value = adjudicating_source();
    review_value(&mut value)["assessment"] = json!("draft");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.assessment"),
        "assessment draft is not a kind: assessment artifact",
    );
}

#[test]
fn assessment_binding_must_match_reviewed_assessment() {
    let mut value = adjudicating_source();
    value["stages"]["document"]["artifacts"]["another"] =
        json!({"kind": "assessment", "schema": "text"});
    review_value(&mut value)["assessment"] = json!("another");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.assessment"),
        "assessment another differs from reviewed assessment assessment",
    );
}

#[test]
fn assessment_binding_cannot_use_another_stages_artifact() {
    let mut value = adjudicating_source();
    value["stages"]["other"] = json!({
        "input": {},
        "artifacts": {"other_assessment": {"kind": "assessment", "schema": "text"}},
        "workers": {"assessor": {"kind": "agent", "inputs": {}, "prompts": {"initial": "p", "revise": "p"}, "produces": ["other_assessment"]}},
        "done_when": "false", "outcome": {}
    });
    review_value(&mut value)["assessment"] = json!("other_assessment");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.assessment"),
        "assessment other_assessment is not an artifact of stage document",
    );
}

fn with_draft_review() -> Value {
    let mut value = adjudicating_source();
    let review = review_value(&mut value).clone();
    let reviews = &mut value["stages"]["document"]["reviews"];
    reviews["draft_review"] = review;
    reviews["draft_review"]["of"] = json!("draft");
    value
}

#[test]
fn adjudicating_review_of_draft_requires_an_explicit_assessment() {
    assert_review_error(
        with_draft_review(),
        "stages.document.reviews.draft_review",
        "adjudicating review draft_review must declare assessment",
    );
}

#[test]
fn adjudicating_review_of_draft_accepts_an_explicit_assessment() {
    let mut value = with_draft_review();
    value["stages"]["document"]["reviews"]["draft_review"]["assessment"] = json!("assessment");
    compile(value).unwrap();
}

#[test]
fn plain_review_cannot_declare_assessment() {
    let mut value = adjudicating_source();
    plain_review(&mut value);
    review_value(&mut value)["assessment"] = json!("assessment");
    assert_review_error(
        value,
        &format!("{REVIEW_PATH}.assessment"),
        "assessment is only allowed on an adjudicating review",
    );
}
