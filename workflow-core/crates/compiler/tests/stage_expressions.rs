//! Stage expressions are parsed into a typed shape before they are checked.
//! Each test here pins a case the previous source-text scan got wrong.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::*;

fn prompts() -> BTreeMap<String, String> {
    [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{topic}} {{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}} {{critique}}"),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect()
}

/// The review-loop sample with the given JSON pointers replaced.
fn review_loop(edits: &[(&str, Value)]) -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
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
    compile_workflow(&source, &[], &prompts())
}

fn stage_input_type(program: &CheckedWorkflow, worker: &str, input: &str) -> TypeExpression {
    program.stages[0]
        .workers
        .iter()
        .find(|candidate| candidate.key().0 == worker)
        .expect("worker")
        .inputs()
        .iter()
        .find(|candidate| candidate.key == input)
        .expect("input")
        .value
        .value_type
        .clone()
}

#[test]
fn an_unguarded_latest_types_as_optional_in_the_syntax_the_evaluator_parses() {
    let program = compile(&review_loop(&[])).unwrap();
    // The writer reads latest(critique) with nothing proving a revision exists.
    assert_eq!(
        stage_input_type(&program, "writer", "critique"),
        TypeExpression::Name("optional({notes: list(text)})".into())
    );
}

#[test]
fn a_publication_guard_proves_nothing_about_a_sibling_artifact() {
    // done_when is approved(draft); critique carries no such guard.
    let error = compile(&review_loop(&[(
        "/stages/document/outcome/draft",
        json!("latest(critique).notes"),
    )]))
    .unwrap_err();
    assert_eq!(&*error.entity_id, "check 9", "{error:?}");
}

#[test]
fn a_guarded_latest_still_resolves_its_fields() {
    let program = compile(&review_loop(&[(
        "/stages/document/outcome/draft",
        json!("latest(draft).title"),
    )]))
    .unwrap();
    assert_eq!(
        program.stages[0].outcome[0].value.value_type,
        TypeExpression::Name("text".into())
    );
}

#[test]
fn a_unit_outcome_field_named_input_is_read_rather_than_rejected() {
    // ".input" appears in the source text without naming another unit's input.
    let program = compile(&review_loop(&[
        ("/stages/document/outcome/input_note", json!("input.topic")),
        ("/run/outcome/draft", json!("document.outcome.input_note")),
    ]))
    .unwrap();
    assert_eq!(
        program.root.outcome[0].value.value_type,
        TypeExpression::Name("text".into())
    );
}

#[test]
fn reading_another_units_interior_is_still_rejected() {
    for source in [
        "document.input.topic",
        "document.state",
        "document.artifact",
    ] {
        let error = compile(&review_loop(&[("/run/outcome/draft", json!(source))])).unwrap_err();
        assert_eq!(&*error.entity_id, "check 4", "{source}: {error:?}");
    }
}

#[test]
fn calls_and_comparisons_tolerate_their_own_whitespace() {
    let program = compile(&review_loop(&[
        ("/stages/document/done_when", json!("approved( draft )")),
        ("/stages/document/outcome/draft", json!("latest( draft )")),
        (
            "/stages/document/artifacts/draft/validate/0/check",
            json!("len(draft.body)>0"),
        ),
    ]))
    .unwrap();
    let draft = program.stages[0]
        .artifacts
        .iter()
        .find(|artifact| artifact.key.0 == "draft")
        .expect("draft validation");
    assert_eq!(
        draft.validations[0].expression.value_type,
        TypeExpression::Name("boolean".into())
    );
}

#[test]
fn a_comparison_inside_a_call_does_not_split_the_outer_expression() {
    let error = compile(&review_loop(&[(
        "/stages/document/artifacts/draft/validate/0/check",
        json!("len(draft.title > draft.body) > 0"),
    )]))
    .unwrap_err();
    // The inner comparison is checked as a comparison, not as a length argument.
    assert_eq!(&*error.entity_id, "check 9", "{error:?}");
}

#[test]
fn not_accepts_parenthesized_operand() {
    let program = compile(&review_loop(&[(
        "/stages/document/artifacts/draft/validate/0/check",
        json!("not(published(draft))"),
    )]))
    .unwrap();
    let draft = program.stages[0]
        .artifacts
        .iter()
        .find(|artifact| artifact.key.0 == "draft")
        .unwrap();
    assert_eq!(draft.validations[0].expression.value_type, Type::Boolean);
}

#[test]
fn nested_call_inside_comparison_is_typed() {
    let program = compile(&review_loop(&[(
        "/stages/document/artifacts/draft/validate/0/check",
        json!("len(input.topic) > len(\"a\")"),
    )]))
    .unwrap();
    let draft = program.stages[0]
        .artifacts
        .iter()
        .find(|artifact| artifact.key.0 == "draft")
        .unwrap();
    assert_eq!(draft.validations[0].expression.value_type, Type::Boolean);
}

#[test]
fn unterminated_string_reports_its_span() {
    use workflow_compiler::compile_workflow_detailed;
    let value = review_loop(&[(
        "/stages/document/artifacts/draft/validate/0/check",
        json!("\"unterminated"),
    )]);
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(&source, &[], &prompts()).unwrap_err();
    assert_eq!(
        errors[0].path.0,
        "stages.document.artifacts.draft.validate.0.check"
    );
    assert_eq!(errors[0].span, SourceSpan { start: 0, end: 13 });
}
