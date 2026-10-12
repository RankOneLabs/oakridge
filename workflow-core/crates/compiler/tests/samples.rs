use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::*;

fn prompts() -> BTreeMap<String, String> {
    [
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
    .map(|(key, value)| (key.into(), value.into()))
    .collect()
}

fn operations() -> Vec<CodeOperation> {
    vec![CodeOperation {
        key: SymbolKey::from("repository.prepare"),
        version: 1,
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
            ]
            .into(),
        ),
        error_codes: vec![],
    }]
}

#[test]
fn both_samples_compile_from_yaml_json() {
    for content in [
        include_bytes!("../../../fixtures/bundles/review-loop.json").as_slice(),
        include_bytes!("../../../fixtures/bundles/fan-out.json").as_slice(),
    ] {
        let source = decode_workflow(content).unwrap();
        let checked = compile_workflow(&source, &operations(), &prompts()).unwrap();
        assert_eq!(checked.stages.len(), source.stages.len());
    }
}

#[test]
fn collection_dependencies_must_be_lists_of_keys() {
    let mut source =
        decode_workflow(include_bytes!("../../../fixtures/bundles/fan-out.json")).unwrap();
    let item = source
        .run
        .units
        .get_mut("work")
        .unwrap()
        .group
        .as_mut()
        .unwrap()
        .units
        .get_mut("item")
        .unwrap();
    item.after = UnitDependencies::Each("each.text".into());
    let error = compile_workflow(&source, &operations(), &prompts()).unwrap_err();
    assert_eq!(&*error.entity_id, "check 2");
    assert!(error.detail.contains("collection after"));
}

#[test]
fn host_depth_limit_rejects_workflow_before_compilation() {
    let source =
        decode_workflow(include_bytes!("../../../fixtures/bundles/review-loop.json")).unwrap();
    let limits = ResourceLimits {
        max_depth: 2,
        ..ResourceLimits::default()
    };
    let error = workflow_compiler::compile_workflow_with_limits(
        &source,
        &operations(),
        &prompts(),
        &limits,
    )
    .unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::ResourceLimit);
    assert_eq!(&*error.detail, "max_depth exceeded");
}
