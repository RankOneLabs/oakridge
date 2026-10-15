//! The constructs rescue R5 adds for the development workflow (part 1 §12,
//! "Recorded with rescue R5"): conjunctions and equality, list functions,
//! record literals, `enum(...)`, worker and review guards, engine reviews,
//! approvals of any artifact, and generic code operations.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::*;

pub fn prompts() -> BTreeMap<String, String> {
    [
        ("plan.md", ""),
        ("build.md", "{{brief}}"),
        ("assess.md", "{{subject}}"),
        ("review.md", ""),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect()
}

pub fn operations() -> Vec<CodeOperation> {
    let ty = |text: &str| TypeExpression::Name(text.into());
    vec![
        CodeOperation {
            key: SymbolKey::from("value.publish"),
            input_schema: TypeExpression::Record(BTreeMap::from([("value".into(), ty("$value"))])),
            output_schema: ty("$value"),
            error_codes: vec![],
        },
        CodeOperation {
            key: SymbolKey::from("items.publish"),
            input_schema: TypeExpression::Record(BTreeMap::from([(
                "items".into(),
                ty("list($value)"),
            )])),
            output_schema: ty("list($value)"),
            error_codes: vec![],
        },
        CodeOperation {
            key: SymbolKey::from("pull.observe"),
            input_schema: TypeExpression::Record(BTreeMap::from([("url".into(), ty("text"))])),
            output_schema: TypeExpression::Record(BTreeMap::from([(
                "state".into(),
                ty("enum(open, merged, closed_unmerged)"),
            )])),
            error_codes: vec![],
        },
    ]
}

/// The R5 fixture with the given JSON pointers replaced (or inserted).
fn fixture(edits: &[(&str, Value)]) -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/r5-cohort.json")).unwrap();
    for (pointer, replacement) in edits {
        if let Some(target) = value.pointer_mut(pointer) {
            *target = replacement.clone();
        } else {
            let (parent, key) = pointer.rsplit_once('/').expect(pointer);
            value
                .pointer_mut(parent)
                .expect(pointer)
                .as_object_mut()
                .expect(pointer)
                .insert(key.into(), replacement.clone());
        }
    }
    value
}

fn compile(value: &Value) -> Result<CheckedWorkflow, DomainError> {
    let source = decode_workflow(&serde_json::to_vec(value).unwrap())?;
    compile_workflow(&source, &operations(), &prompts())
}

fn rejection(edits: &[(&str, Value)]) -> String {
    compile(&fixture(edits)).unwrap_err().entity_id.to_string()
}

const DONE: &str = "/stages/cohort/done_when";

#[test]
fn the_fixture_compiles() {
    compile(&fixture(&[])).unwrap();
}

#[test]
fn stage_let_bindings_expand_in_guards_inputs_and_outcomes() {
    let value = fixture(&[
        (
            "/stages/cohort/let",
            json!({
                "brief_value": "input.brief",
                "pr_published": "published(pr)",
                "merged_pr": "published(pr_state) and latest(pr_state).state == \"merged\""
            }),
        ),
        (
            "/stages/cohort/workers/builder/inputs/brief",
            json!("brief_value"),
        ),
        (
            "/stages/cohort/workers/pr_watch/when",
            json!("pr_published"),
        ),
        (
            DONE,
            json!("approved(assessment) and pr_published and merged_pr"),
        ),
        (
            "/stages/cohort/outcome/brief_key",
            json!("brief_value.repository_key"),
        ),
    ]);
    let program = compile(&value).unwrap();
    let cohort = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "cohort")
        .unwrap();
    assert!(cohort
        .outcome
        .iter()
        .any(|field| field.key == "brief_key" && field.value.value_type == Type::Ident));
}

#[test]
fn repeated_let_bindings_stop_before_exponential_expansion() {
    let mut value = fixture(&[]);
    let mut bindings = serde_json::Map::new();
    bindings.insert("a0".into(), json!("true"));
    for index in 1..20 {
        bindings.insert(
            format!("a{index}"),
            json!(format!("a{} and a{}", index - 1, index - 1)),
        );
    }
    value["stages"]["cohort"]["let"] = Value::Object(bindings);
    value["stages"]["cohort"]["done_when"] = json!("a19");
    let error = compile(&value).unwrap_err();
    assert!(error
        .detail
        .contains("let expansion exceeds depth or node budget"));
}

#[test]
fn worker_templates_and_decision_sets_expand_typed_overrides() {
    let mut value = fixture(&[]);
    let worker = value["stages"]["cohort"]["workers"]["pr_watch"].take();
    let decisions = value["stages"]["cohort"]["reviews"]["assessment_review"]["decisions"].take();
    value["workers"] = json!({"watch": worker});
    value["decisions"] = json!({"assessment": decisions});
    value["stages"]["cohort"]["workers"]["pr_watch"] =
        json!({"template": "watch", "overrides": {"every": "2m"}});
    value["stages"]["cohort"]["reviews"]["assessment_review"]["decisions"] = json!({
        "set": "assessment", "overrides": {
            "accept": {"payload": "text"},
            "request_build_changes": {"label": "Revise build"}
        }
    });
    compile(&value).unwrap();
    value["stages"]["cohort"]["workers"]["pr_watch"]["overrides"]["unknown"] = json!("x");
    let error = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap_err();
    assert_eq!(&*error.path, "stages.cohort.workers.pr_watch");
}

#[test]
fn lookup_is_optional_and_default_handles_the_missing_case() {
    let check = "/stages/plan/artifacts/plan/validate/0/check";
    let value = fixture(&[
        (check, json!("every(plan.cohorts, default(lookup(plan.cohorts, id, item.id), item).id == item.id)")),
        ("/stages/plan/outcome/matched", json!("lookup(latest(plan).cohorts, id, \"a\")")),
    ]);
    let program = compile(&value).unwrap();
    let plan = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "plan")
        .unwrap();
    assert!(matches!(
        plan.outcome
            .iter()
            .find(|field| field.key == "matched")
            .unwrap()
            .value
            .value_type,
        Type::Optional { .. }
    ));
    let bad = fixture(&[(
        check,
        json!("every(plan.cohorts, lookup(plan.cohorts, id, item.id).id == item.id)"),
    )]);
    let source = decode_workflow(&serde_json::to_vec(&bad).unwrap()).unwrap();
    let error = workflow_compiler::compile_workflow_detailed(&source, &operations(), &prompts())
        .unwrap_err();
    assert_eq!(
        error[0].path.0,
        "stages.plan.artifacts.plan.validate.0.check"
    );
    assert_eq!(error[0].check, CheckKind::ExpressionType);
}

#[test]
fn an_and_lets_its_left_guard_type_its_right_operand() {
    let program = compile(&fixture(&[(
        DONE,
        json!("published(pr) and latest(pr).branch == \"main\""),
    )]))
    .unwrap();
    let cohort = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "cohort")
        .unwrap();
    assert_eq!(
        cohort.done_when.value_type,
        TypeExpression::Name("boolean".into())
    );
}

#[test]
fn a_guard_on_the_right_of_an_and_does_not_type_its_left() {
    assert_eq!(
        rejection(&[(
            DONE,
            json!("latest(pr).branch == \"main\" and published(pr)")
        )]),
        "check 9"
    );
}

#[test]
fn an_or_guards_only_what_both_sides_prove() {
    assert_eq!(
        rejection(&[
            (DONE, json!("published(pr) or approved(assessment)")),
            ("/stages/cohort/outcome/pr", json!("latest(pr).pr_url")),
        ]),
        "check 9"
    );
}

#[test]
fn equality_requires_comparable_operands() {
    assert_eq!(
        rejection(&[(DONE, json!("input.admission == \"yes\""))]),
        "check 9"
    );
}

#[test]
fn a_text_literal_compared_with_an_enum_must_be_a_variant() {
    let check = |literal: &str| {
        rejection(&[(
            DONE,
            json!(format!(
                "published(assessment) and latest(assessment).verdict == \"{literal}\""
            )),
        )])
    };
    assert_eq!(check("maybe"), "check 9");
    compile(&fixture(&[(
        DONE,
        json!("published(assessment) and latest(assessment).verdict == \"pass\""),
    )]))
    .unwrap();
}

#[test]
fn a_malformed_enum_is_rejected() {
    for schema in ["enum()", "enum(pass, pass)", "enum(a b)"] {
        assert_eq!(
            rejection(&[(
                "/stages/cohort/artifacts/assessment/schema/verdict",
                json!(schema)
            )]),
            "check 11",
            "{schema}"
        );
    }
}

#[test]
fn item_is_bound_only_inside_a_list_function() {
    assert_eq!(
        rejection(&[("/stages/cohort/outcome/stray", json!("item.title"))]),
        "check 1"
    );
}

#[test]
fn list_functions_type_their_results() {
    let program = compile(&fixture(&[])).unwrap();
    let plan = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "plan")
        .unwrap();
    assert_eq!(
        plan.outcome[0].value.value_type,
        TypeExpression::Name("list(ident)".into())
    );
}

#[test]
fn list_function_arguments_are_checked() {
    let check = "/stages/plan/artifacts/plan/validate/0/check";
    for (source, class) in [
        ("every(plan.cohorts, item.id)", "check 9"),
        ("contains(plan.cohorts, 3)", "check 9"),
        ("valid_graph(plan.cohorts, id, repository_key)", "check 9"),
        (
            "lookup(plan.cohorts, missing, \"a\").id == \"a\"",
            "check 1",
        ),
        ("every(input.repositories, true)", "check 9"),
        ("every(plan.cohorts)", "check 1"),
    ] {
        assert_eq!(rejection(&[(check, json!(source))]), class, "{source}");
    }
}

#[test]
fn a_worker_guard_must_be_boolean() {
    assert_eq!(
        rejection(&[(
            "/stages/cohort/workers/builder/when",
            json!("input.brief.title")
        )]),
        "check 9"
    );
}

#[test]
fn a_worker_reading_an_unguarded_latest_field_is_rejected() {
    assert_eq!(
        rejection(&[("/stages/cohort/workers/pr_watch/when", Value::Null)]),
        "check 9"
    );
}

#[test]
fn an_approval_may_be_of_a_reviewer_or_code_worker_artifact_but_a_request_may_not() {
    // The fixture approves the assessor's assessment and the code-published brief.
    compile(&fixture(&[])).unwrap();
    assert_eq!(
        rejection(&[(
            "/stages/cohort/reviews/admission/decisions/reject",
            json!({ "effect": "request_changes", "label": "Reject" }),
        )]),
        "check 8"
    );
}

#[test]
fn a_request_for_changes_on_another_artifact_needs_its_creator_to_revise() {
    assert_eq!(
        rejection(&[(
            "/stages/cohort/workers/builder/prompts",
            json!({ "initial": "build.md" })
        )]),
        "check 7"
    );
}

#[test]
fn an_engine_review_needs_a_guard_and_one_fixed_request_for_changes() {
    let review = "/stages/cohort/reviews/pr_closed";
    let engine = |extra: Value| {
        let mut base = json!({
            "of": "build", "by": "engine", "when": "published(pr)",
            "decisions": { "replace": { "effect": "request_changes", "label": "Replace", "feedback": "Open a new PR." } }
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    };
    for (variant, reason) in [
        (engine(json!({ "when": null })), "check 8"),
        (engine(json!({ "prompt": "review.md" })), "check 8"),
        (
            engine(json!({ "decisions": {
                "a": { "effect": "request_changes", "label": "A", "feedback": "x" },
                "b": { "effect": "request_changes", "label": "B", "feedback": "y" } } })),
            "check 8",
        ),
        (
            engine(
                json!({ "decisions": { "a": { "effect": "approve", "label": "A", "feedback": "x" } } }),
            ),
            "check 8",
        ),
        (
            engine(json!({ "decisions": { "a": { "effect": "request_changes", "label": "A" } } })),
            "check 8",
        ),
    ] {
        assert_eq!(rejection(&[(review, variant.clone())]), reason, "{variant}");
    }
}

#[test]
fn an_operator_review_cannot_carry_fixed_feedback() {
    assert_eq!(
        rejection(&[(
            "/stages/cohort/reviews/assessment_review/decisions/accept/feedback",
            json!("fixed"),
        )]),
        "check 8"
    );
}

#[test]
fn a_generic_operation_binds_its_type_variable_once() {
    // value.publish's output must be the type its input was bound to.
    assert_eq!(
        rejection(&[("/stages/cohort/artifacts/brief/schema", json!("pr_body"))]),
        "check 12"
    );
}

#[test]
fn record_literals_build_typed_records() {
    assert_eq!(
        rejection(&[(
            "/run/units/plan/input/repositories",
            json!("{key: input.brief.title}")
        )]),
        "check 6"
    );
    assert_eq!(
        rejection(&[(
            "/run/units/plan/input/repositories",
            json!("{key: 1, key: 2}")
        )]),
        "check 11"
    );
}

#[test]
fn parentheses_group_a_disjunction_inside_a_conjunction() {
    compile(&fixture(&[(
        DONE,
        json!("approved(assessment) and (input.admission or not input.admission)"),
    )]))
    .unwrap();
    assert_eq!(
        rejection(&[(DONE, json!("approved(assessment) and (input.admission or"))]),
        "check 1"
    );
}

#[test]
fn an_alias_inside_a_list_is_the_type_it_names() {
    // The unit passes list({id: ident}); the stage declares list(cohort_ref).
    compile(&fixture(&[
        ("/input/cohorts", json!("list({id: ident})")),
        ("/schemas/cohort_ref", json!({ "id": "ident" })),
        ("/stages/plan/input/cohorts", json!("list(cohort_ref)")),
        ("/run/units/plan/input/cohorts", json!("input.cohorts")),
    ]))
    .unwrap();
}

#[test]
fn a_type_variable_inside_a_constructor_binds_to_its_item_type() {
    let with_items = |schema: &str| {
        fixture(&[
            (
                "/stages/cohort/artifacts/dependencies",
                json!({ "schema": schema }),
            ),
            (
                "/stages/cohort/workers/list_dependencies",
                json!({ "kind": "code", "operation": "items.publish",
                        "inputs": { "items": "input.brief.depends_on" }, "creates": ["dependencies"] }),
            ),
        ])
    };
    compile(&with_items("list(ident)")).unwrap();
    assert_eq!(
        compile(&with_items("list(text)"))
            .unwrap_err()
            .entity_id
            .to_string(),
        "check 12"
    );
}
