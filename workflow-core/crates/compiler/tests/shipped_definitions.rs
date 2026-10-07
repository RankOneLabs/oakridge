use std::fs;
use std::path::PathBuf;
use workflow_compiler::{compile_with_catalog, decode_bundle};
use workflow_model::ProviderCatalog;
use workflow_model::SchemaId;

fn runtime_catalog() -> ProviderCatalog {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../workflow-config/provider-catalog.json");
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(path).expect("read runtime catalog")).unwrap();
    serde_json::from_value(value).expect("runtime catalog contract")
}

#[test]
fn verification_bundle_decodes_reordered_provider_records() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../workflow-config/definitions/development-verification.json");
    let bundle = decode_bundle(&fs::read(path).unwrap()).unwrap();
    workflow_compiler::check_value(
        &bundle,
        &SchemaId::from("repo_result"),
        &serde_json::json!({ "repository_path": "/tmp/repo", "head": "head", "push_remote_owner": "owner" }),
    ).expect("repository provider output decodes");
    workflow_compiler::check_value(
        &bundle,
        &SchemaId::from("pr_query"),
        &serde_json::json!({ "owner": "owner", "name": "repo", "head_branch": "head", "base_branch": "base", "head_owner": "owner" }),
    ).expect("pull request query decodes");
}

#[test]
fn every_shipped_definition_compiles() {
    let definitions =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config/definitions");
    let mut paths: Vec<_> = fs::read_dir(&definitions)
        .expect("shipped definitions directory")
        .map(|entry| entry.expect("definition entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 3, "expected all three shipped definitions");
    let catalog = runtime_catalog();
    for path in paths {
        let bytes = fs::read(&path).expect("read shipped definition");
        let bundle =
            decode_bundle(&bytes).unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
        compile_with_catalog(&bundle, &catalog)
            .unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
    }
}
