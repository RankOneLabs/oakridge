use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::*;

fn prompts() -> BTreeMap<String, String> {
    [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{topic}} {{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}} {{critique}}"),
        ("fan-out/item.md", "{{text}}"),
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
