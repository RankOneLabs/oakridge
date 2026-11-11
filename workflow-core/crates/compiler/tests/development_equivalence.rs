//! Execution golden captured before schema normalization from base commit
//! 1c7d80177f6fbc316d645f7c5ee7b25732a5d9b5. Never regenerate from normalized source.
use std::{collections::BTreeMap, path::Path, process::Command};
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::CodeOperation;

#[test]
fn development_checked_program_is_byte_identical_to_base_1c7d8017() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let parsed = Command::new("bun")
        .current_dir(&root)
        .env_remove("BUN_INSPECT")
        .args(["-e", "import YAML from 'yaml'; process.stdout.write(JSON.stringify(YAML.parse(await Bun.file('workflow-config/development.yaml').text())));"])
        .output()
        .expect("bun parses the authored development YAML");
    assert!(
        parsed.status.success(),
        "{}",
        String::from_utf8_lossy(&parsed.stderr)
    );
    let source = decode_workflow(&parsed.stdout).unwrap();
    let config = root.join("workflow-config");
    let operations: Vec<CodeOperation> =
        serde_json::from_slice(&std::fs::read(config.join("operation-registry.json")).unwrap())
            .unwrap();
    let prompts: BTreeMap<String, String> = std::fs::read_dir(config.join("prompts/development"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            (
                format!("development/{name}"),
                std::fs::read_to_string(&path).unwrap(),
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
