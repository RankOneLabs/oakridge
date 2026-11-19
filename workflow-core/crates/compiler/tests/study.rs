use serde_json::Value;
use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::{CheckedWorker, CheckedWorkflow, CodeOperation, SymbolKey};

fn study_definition() -> (Value, CheckedWorkflow) {
    let config = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let read = |path: std::path::PathBuf| std::fs::read_to_string(path).expect("readable");
    let store = config.join("definitions");
    let launchable: Value = serde_json::from_str(&read(store.join("launchable.json"))).unwrap();
    let id = launchable["study"]["definition_id"].as_str().unwrap();
    let definition: Value =
        serde_json::from_str(&read(store.join(format!("workflows/{id}.json")))).unwrap();
    let registry = definition["operation_registry_id"].as_str().unwrap();
    let operations: Vec<CodeOperation> =
        serde_json::from_str(&read(store.join(format!("operations/{registry}.json")))).unwrap();
    let prompts: BTreeMap<String, String> = definition["prompts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, digest)| {
            let digest = digest.as_str().unwrap();
            (
                name.clone(),
                read(store.join(format!("prompts/{digest}.md"))),
            )
        })
        .collect();
    let source = decode_workflow(&serde_json::to_vec(&definition["source"]).unwrap()).unwrap();
    let checked = compile_workflow(&source, &operations, &prompts).expect("study compiles");
    (definition, checked)
}

#[test]
fn study_definition_compiles() {
    study_definition();
}

#[test]
fn slice_artifacts_share_one_stage() {
    let (_, checked) = study_definition();
    let design = checked
        .stages
        .iter()
        .find(|stage| stage.key.0 == "design")
        .unwrap();
    for name in ["plan", "slice_build", "spend_request", "slice_report"] {
        assert!(
            design
                .artifacts
                .iter()
                .any(|artifact| artifact.key.0 == name),
            "{name} is missing from design"
        );
    }

    let builders: Vec<_> = design
        .workers
        .iter()
        .filter_map(|worker| match worker {
            CheckedWorker::Agent { key, creates, .. } if key.0 == "slice_builder" => Some(creates),
            _ => None,
        })
        .collect();
    let [creates] = builders.as_slice() else {
        panic!("expected exactly one slice_builder agent");
    };
    for name in ["slice_build", "spend_request", "slice_report"] {
        assert!(
            creates.contains(&SymbolKey::from(name)),
            "slice_builder does not create {name}"
        );
    }
}

#[test]
fn study_stages_run_in_order() {
    let (definition, _) = study_definition();
    // The store canonicalizes object keys and records authored order separately.
    assert_eq!(
        definition["stage_names"],
        serde_json::json!(["prepare", "design", "expand", "freeze", "integration"])
    );
}
