use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn source() -> Workflow {
    serde_json::from_value(json!({"workflow":"contracts","input":{},
        "run":{"units":{"document":{"stage":"document"}},"outcome":{}},
        "stages":{"document":{"input":{},"artifacts":{"analysis":{"kind":"record","schema":{"findings":"list(text)"}}},
            "workers":{"author":{"kind":"agent","prompts":{"initial":"p","revise":"p"},"inputs":{},"produces":["analysis"]}},
            "reviews":{"analysis_review":{"of":"analysis","by":"operator","prompt":"p","decisions":{
                "accept":{"effect":"approve","label":"Accept","when":{"check":"len(analysis.findings) == 0","reason":"Findings remain"}},
                "fix":{"effect":"request_changes","label":"Fix","on":"analysis","payload":{"feedback":"text","entries":"list(text)"}}}}},
            "done_when":"approved(analysis)","outcome":{}}}})).unwrap()
}
fn compile(source: &Workflow) -> Result<CheckedWorkflow, Vec<CompileError>> {
    compile_workflow_detailed(source, &[], &BTreeMap::from([("p".into(), String::new())]))
}

#[test]
fn guards_are_boolean_and_have_nonempty_reasons() {
    assert!(compile(&source()).is_ok());
    let mut source = source();
    source
        .stages
        .get_mut("document")
        .unwrap()
        .reviews
        .get_mut("analysis_review")
        .unwrap()
        .decisions
        .get_mut("accept")
        .unwrap()
        .when
        .as_mut()
        .unwrap()
        .check = "len(analysis.findings)".into();
    assert!(compile(&source)
        .unwrap_err()
        .iter()
        .any(|error| error.detail.contains("check must be boolean")));
    let guard = source
        .stages
        .get_mut("document")
        .unwrap()
        .reviews
        .get_mut("analysis_review")
        .unwrap()
        .decisions
        .get_mut("accept")
        .unwrap()
        .when
        .as_mut()
        .unwrap();
    guard.check = "true".into();
    guard.reason = " ".into();
    assert!(compile(&source)
        .unwrap_err()
        .iter()
        .any(|error| error.detail.contains("non-empty reason")));
    let missing = json!({"check":"true"});
    assert!(serde_json::from_value::<DecisionGuard>(missing)
        .unwrap_err()
        .to_string()
        .contains("reason"));
}

#[test]
fn every_historical_bundle_has_blockers_only_on_agent_workers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    // Launchable workflows compile with their committed prompts, includes expanded;
    // a bundle outside the store reads its authored prompt files.
    let store = root.join("workflow-config/definitions");
    let read_json = |path: std::path::PathBuf| -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    };
    let committed: BTreeMap<String, String> = read_json(store.join("launchable.json"))
        .as_object()
        .unwrap()
        .values()
        .flat_map(|entry| {
            let id = entry["definition_id"].as_str().unwrap();
            let definition = read_json(store.join(format!("workflows/{id}.json")));
            definition["prompts"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(path, digest)| {
                    let digest = digest.as_str().unwrap();
                    let text = std::fs::read_to_string(store.join(format!("prompts/{digest}.md")))
                        .unwrap();
                    (path.clone(), text)
                })
                .collect::<Vec<_>>()
        })
        .collect();
    for bundle in std::fs::read_dir(root.join("workflow-core/fixtures/bundles")).unwrap() {
        let source = decode_workflow(&std::fs::read(bundle.unwrap().path()).unwrap()).unwrap();
        // The bundle's referenced pinned prompts and the published operation registry are the real compile inputs.
        let prompts: BTreeMap<String, String> = source
            .stages
            .values()
            .flat_map(|stage| {
                stage
                    .workers
                    .values()
                    .flat_map(|worker| match worker {
                        Worker::Agent { prompts, .. } => prompts
                            .iter()
                            .map(|(_, path)| path.clone())
                            .collect::<Vec<_>>(),
                        _ => vec![],
                    })
                    .chain(
                        stage
                            .reviews
                            .values()
                            .filter_map(|review| review.prompt.clone()),
                    )
                    .collect::<Vec<_>>()
            })
            .map(|path| {
                let text = committed.get(&path).cloned().unwrap_or_else(|| {
                    std::fs::read_to_string(root.join("workflow-config/prompts").join(&path))
                        .unwrap_or_default()
                });
                (path, text)
            })
            .collect();
        let mut operations: Vec<CodeOperation> = serde_json::from_slice(
            &std::fs::read(root.join("workflow-config/operation-registry.json")).unwrap(),
        )
        .unwrap();
        // r5-cohort pins the original observation contract rather than today's registry name.
        operations.push(CodeOperation {
            key: SymbolKey::from("pull.observe"),
            input_schema: Type::Record(BTreeMap::from([("url".into(), Type::Text)])),
            output_schema: Type::Record(BTreeMap::from([(
                "state".into(),
                Type::parse("enum(open, merged, closed_unmerged)").unwrap(),
            )])),
            error_codes: vec![],
        });
        let program = compile_workflow_detailed(&source, &operations, &prompts).unwrap();
        for stage in &program.stages {
            for worker in &stage.workers {
                assert_eq!(
                    worker
                        .creates()
                        .contains(&SymbolKey::from(BLOCKER_ARTIFACT)),
                    matches!(worker, CheckedWorker::Agent { .. })
                );
            }
            if stage
                .workers
                .iter()
                .any(|worker| matches!(worker, CheckedWorker::Agent { .. }))
            {
                assert!(stage
                    .reviews
                    .iter()
                    .any(|review| review.key().0 == BLOCKER_REVIEW));
            }
        }
    }
}
