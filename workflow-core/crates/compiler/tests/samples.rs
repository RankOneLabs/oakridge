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
                (
                    "base_branch".into(),
                    TypeExpression::Name("text".into()),
                ),
                (
                    "integration_branch".into(),
                    TypeExpression::Name("text".into()),
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
fn authored_development_fixture_matches_the_editor_source_model() {
    let _: AuthoredWorkflow =
        serde_json::from_slice(include_bytes!("../../../fixtures/bundles/development.json"))
            .unwrap();
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

/// The development workflow (rescue spec R5) compiles as derived from
/// `workflow-config/development.yaml`, with the prompts it names and the
/// operation registry the run layer exports.
#[test]
fn the_development_workflow_compiles_against_its_prompts_and_the_registry() {
    let config = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let read = |path: std::path::PathBuf| std::fs::read_to_string(&path).expect("readable");
    let operations: Vec<CodeOperation> =
        serde_json::from_str(&read(config.join("operation-registry.json"))).unwrap();
    let prompts: BTreeMap<String, String> = std::fs::read_dir(config.join("prompts/development"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (format!("development/{name}"), read(path))
        })
        .collect();
    let source =
        decode_workflow(include_str!("../../../fixtures/bundles/development.json").as_bytes())
            .unwrap();
    let program = compile_workflow(&source, &operations, &prompts).unwrap();
    let stages: Vec<_> = program
        .stages
        .iter()
        .map(|stage| stage.key.0.as_str())
        .collect();
    assert_eq!(
        stages,
        [
            "analysis",
            "brief",
            "cohort",
            "integration",
            "planning",
            "prepare"
        ]
    );
}
