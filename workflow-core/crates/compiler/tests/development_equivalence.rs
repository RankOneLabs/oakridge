//! Execution golden captured before schema normalization from base commit
//! 1c7d80177f6fbc316d645f7c5ee7b25732a5d9b5. Never regenerate from normalized source.
use std::{collections::BTreeMap, path::Path};
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::CodeOperation;

#[test]
fn development_checked_program_is_byte_identical_to_base_1c7d8017() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let config = root.join("workflow-config");
    // Pin every input to the historical definition; the live development
    // workflow evolves independently of this schema-normalization golden.
    let store = config.join("definitions");
    let definition: serde_json::Value = serde_json::from_slice(
        &std::fs::read(store.join(
            "workflows/478dfc8194eb060c438c916adbe9b80b9b5010ad2d339b629448ddbde376fc34.json",
        ))
        .unwrap(),
    )
    .unwrap();
    let source = decode_workflow(&serde_json::to_vec(&definition["source"]).unwrap()).unwrap();
    let registry = definition["operation_registry_id"].as_str().unwrap();
    let operations: Vec<CodeOperation> = serde_json::from_slice(
        &std::fs::read(store.join(format!("operations/{registry}.json"))).unwrap(),
    )
    .unwrap();
    let prompts: BTreeMap<String, String> = definition["prompts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, digest)| {
            let digest = digest.as_str().unwrap();
            (
                name.clone(),
                std::fs::read_to_string(store.join(format!("prompts/{digest}.md"))).unwrap(),
            )
        })
        .collect();
    let program = compile_workflow(&source, &operations, &prompts).unwrap();
    // Value's maps sort keys; this program has only integral JSON numbers.
    let canonical = serde_json::to_vec(&serde_json::to_value(program).unwrap()).unwrap();
    assert_eq!(
        canonical,
        std::fs::read(root.join("workflow-core/fixtures/development-checked-1c7d8017.json"))
            .unwrap()
    );
}
