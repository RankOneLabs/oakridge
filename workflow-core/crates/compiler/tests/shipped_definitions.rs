use std::fs;
use std::path::PathBuf;
use workflow_compiler::{compile, decode_bundle};

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
    assert!(!paths.is_empty(), "no shipped definitions found");
    for path in paths {
        let bytes = fs::read(&path).expect("read shipped definition");
        let bundle =
            decode_bundle(&bytes).unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
        compile(&bundle, &bundle.operations)
            .unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
    }
}
