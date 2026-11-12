use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_model::{CheckedReview, CheckedWorker, CheckedWorkflow, CodeOperation};

fn development() -> Value {
    serde_json::from_slice(include_bytes!("../../../fixtures/bundles/development.json")).unwrap()
}
fn compile(value: &Value) -> CheckedWorkflow {
    let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let operations: Vec<CodeOperation> =
        serde_json::from_slice(&std::fs::read(config.join("operation-registry.json")).unwrap())
            .unwrap();
    let prompts: BTreeMap<String, String> = std::fs::read_dir(config.join("prompts/development"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                format!(
                    "development/{}",
                    path.file_name().unwrap().to_string_lossy()
                ),
                std::fs::read_to_string(&path).unwrap(),
            )
        })
        .collect();
    let source = decode_workflow(&serde_json::to_vec(value).unwrap()).unwrap();
    compile_workflow(&source, &operations, &prompts).unwrap()
}
fn bytes(program: &CheckedWorkflow) -> Vec<u8> {
    serde_json::to_vec(&serde_json::to_value(program).unwrap()).unwrap()
}

#[test]
fn artifact_kind_is_required_and_closed() {
    for kind in [None, Some("unknown")] {
        let mut source = development();
        let artifact = source["stages"]["analysis"]["artifacts"]["analysis"]
            .as_object_mut()
            .unwrap();
        match kind {
            None => {
                artifact.remove("kind");
            }
            Some(value) => {
                artifact.insert("kind".into(), json!(value));
            }
        }
        let error = decode_workflow(&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(
            error.detail.contains(if kind.is_none() {
                "missing field `kind`"
            } else {
                "unknown variant"
            }),
            "{error:?}"
        );
    }
}

#[test]
fn every_presentation_kind_has_identical_checked_bytes_and_is_dropped_from_artifacts() {
    let original = bytes(&compile(&development()));
    for kind in [
        "document",
        "record",
        "external_reference",
        "assessment",
        "status_record",
    ] {
        let mut source = development();
        source["stages"]["analysis"]["artifacts"]["analysis"]["kind"] = json!(kind);
        let program = compile(&source);
        assert_eq!(bytes(&program), original);
        for stage in &program.stages {
            for artifact in &stage.artifacts {
                assert!(serde_json::to_value(artifact)
                    .unwrap()
                    .get("kind")
                    .is_none());
            }
        }
    }
}

#[test]
fn authored_produces_and_evaluates_map_to_the_unchanged_checked_worker_names() {
    let program = compile(&development());
    let cohort = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "cohort")
        .unwrap();
    let assessor = cohort
        .workers
        .iter()
        .find(|worker| worker.key().0 == "assessor")
        .unwrap();
    assert!(
        matches!(assessor, CheckedWorker::Agent { creates, reviews: Some(of), .. }
        if creates[0].0 == "assessment" && of.0 == "build_result")
    );
    assert!(cohort.workers.iter().any(|worker| matches!(worker,
        CheckedWorker::Code { creates, .. } if creates[0].0 == "pr_state")));
}

#[test]
fn legacy_worker_fields_are_refused_directly_in_shared_workers_and_in_overrides() {
    for (current, legacy) in [("produces", "creates"), ("evaluates", "reviews")] {
        for position in ["direct", "shared", "override"] {
            let mut source = development();
            let mut worker = source["stages"]["cohort"]["workers"]["assessor"].take();
            let value = worker.as_object_mut().unwrap().remove(current).unwrap();
            if position == "override" {
                // The shared template is valid; only the override uses the old name.
                worker[current] = value.clone();
                source["workers"]["assessor_template"] = worker;
                source["stages"]["cohort"]["workers"]["assessor"] =
                    json!({"template": "assessor_template", "overrides": {legacy: value}});
            } else {
                worker[legacy] = value;
                if position == "shared" {
                    source["workers"]["assessor_template"] = worker;
                    source["stages"]["cohort"]["workers"]["assessor"] =
                        json!({"template": "assessor_template"});
                } else {
                    source["stages"]["cohort"]["workers"]["assessor"] = worker;
                }
            }
            assert!(
                decode_workflow(&serde_json::to_vec(&source).unwrap()).is_err(),
                "{legacy} at {position}"
            );
        }
    }
}

#[test]
fn renamed_template_overrides_compile_and_code_workers_cannot_evaluate() {
    let mut source = development();
    let worker = source["stages"]["cohort"]["workers"]["assessor"].take();
    source["workers"]["assessor_template"] = worker;
    source["stages"]["cohort"]["workers"]["assessor"] = json!({"template": "assessor_template", "overrides": {
        "produces": ["assessment"], "evaluates": "build_result"
    }});
    assert_eq!(bytes(&compile(&source)), bytes(&compile(&development())));
    source["workers"]["pr_watch"]["evaluates"] = json!("pr");
    assert!(decode_workflow(&serde_json::to_vec(&source).unwrap()).is_err());
}

#[test]
fn the_shared_accept_or_request_set_defaults_to_each_reviews_own_artifact() {
    let program = compile(&development());
    let analysis = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "analysis")
        .unwrap();
    for (key, expected) in [("spec_review", "spec"), ("tasks_review", "tasks")] {
        let review = analysis
            .reviews
            .iter()
            .find(|review| review.key().0 == key)
            .unwrap();
        assert_eq!(review.of().0, expected);
        let CheckedReview::Operator { decisions, .. } = review else {
            panic!("operator review")
        };
        assert!(decisions.values().all(|decision| decision.on.is_none()));
    }
}

#[test]
fn explicit_default_targets_after_decision_set_and_review_overrides_have_identical_bytes() {
    for by in ["operator", "engine"] {
        for override_kind in ["decision_set", "review_template"] {
            let mut implicit = development();
            let mut decision = json!({"effect": "request_changes", "label": "Revise"});
            if by == "engine" {
                decision["feedback"] = json!("Revise the specification.");
            }
            let mut review = json!({"of": "spec", "by": by, "when": "published(spec)", "decisions": {"revise": decision.clone()}});
            if by == "operator" {
                review["prompt"] = json!("development/spec-review.md");
                review["inputs"] =
                    implicit["stages"]["analysis"]["reviews"]["spec_review"]["inputs"].clone();
            }
            implicit["stages"]["analysis"]["reviews"]["normalization"] = review.clone();
            let mut explicit = implicit.clone();
            if override_kind == "decision_set" {
                explicit["decisions"]["normalize"] = json!({"revise": decision});
                explicit["stages"]["analysis"]["reviews"]["normalization"]["decisions"] =
                    json!({"set": "normalize", "overrides": {"revise": {"on": "spec"}}});
            } else {
                explicit["reviews"]["normalize"] = review;
                explicit["stages"]["analysis"]["reviews"]["normalization"] = json!({"template": "normalize", "overrides": {"decisions": {"revise": {"on": "spec"}}}});
            }
            let program = compile(&explicit);
            assert_eq!(
                bytes(&program),
                bytes(&compile(&implicit)),
                "{by} {override_kind}"
            );
            let review = program
                .stages
                .iter()
                .find(|stage| stage.key.0 == "analysis")
                .unwrap()
                .reviews
                .iter()
                .find(|review| review.key().0 == "normalization")
                .unwrap();
            match review {
                CheckedReview::Operator { decisions, .. } => {
                    assert!(decisions["revise"].on.is_none())
                }
                CheckedReview::Engine { decision, .. } => assert!(decision.on.is_none()),
            }
        }
    }
}

#[test]
fn assessment_decisions_keep_distinct_build_and_assessment_targets() {
    let program = compile(&development());
    let cohort = program
        .stages
        .iter()
        .find(|stage| stage.key.0 == "cohort")
        .unwrap();
    let review = cohort
        .reviews
        .iter()
        .find(|review| review.key().0 == "assessment_review")
        .unwrap();
    let CheckedReview::Operator { of, decisions, .. } = review else {
        panic!("operator review")
    };
    let targets: Vec<_> = ["request_build_changes", "request_assessment_changes"]
        .map(|key| decisions[key].on.as_ref().unwrap_or(of).0.as_str())
        .into();
    assert_eq!(targets, ["build_result", "assessment"]);
}

#[test]
fn code_workers_refuse_legacy_creates_and_locate_forbidden_evaluates() {
    let mut source = development();
    let worker = source["stages"]["prepare"]["workers"]["git"]
        .as_object_mut()
        .unwrap();
    let produced = worker.remove("produces").unwrap();
    worker.insert("creates".into(), produced);
    assert!(decode_workflow(&serde_json::to_vec(&source).unwrap()).is_err());

    let mut source = development();
    source["stages"]["prepare"]["workers"]["git"]["evaluates"] = json!("workspace");
    let error = decode_workflow(&serde_json::to_vec(&source).unwrap()).unwrap_err();
    assert_eq!(&*error.path, "stages.prepare.workers.git.evaluates");
    assert!(error.detail.contains("cannot set evaluates"));
}
