use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::json;
use uuid::Uuid;

use oakridge_core::executor::delegated_session::{
    config::DelegatedSessionDefConfig, kbbl_client::KbblClient, DelegatedSessionStage,
};
use oakridge_core::registry::stage_type::StageType;
use oakridge_core::types::{StageInstanceId, WorkflowDef};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load_dev_flow_json() -> serde_json::Value {
    let path = manifest_dir().join("examples/dev_flow.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

// ── Workflow loading ──────────────────────────────────────────────────────────

#[test]
fn dev_flow_workflow_json_deserializes_as_workflow_def() {
    let raw = load_dev_flow_json();
    let def: WorkflowDef = serde_json::from_value(raw)
        .expect("examples/dev_flow.json must deserialize as WorkflowDef");

    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 1);

    let stages = &def.graph.stages;
    assert!(stages.contains_key("spec_analyzer"), "missing spec_analyzer stage");
    assert!(stages.contains_key("plan_writer"),   "missing plan_writer stage");
    assert!(stages.contains_key("build"),          "missing build stage");
    assert!(stages.contains_key("assessor"),       "missing assessor stage");

    // Verify each stage uses the delegated_session executor.
    for (key, stage) in stages {
        assert_eq!(
            stage.stage_type, "delegated_session",
            "stage '{key}' must use delegated_session"
        );
    }

    // Verify edges connect the workflow in the expected linear+fan-out shape.
    // spec_analyzer → plan_writer, plan_writer → build, plan_writer → assessor,
    // build → assessor.
    let edges = &def.graph.edges;
    let edge_pairs: Vec<(&str, &str)> = edges
        .iter()
        .map(|e| (e.from.stage.as_str(), e.to.stage.as_str()))
        .collect();
    assert!(
        edge_pairs.contains(&("spec_analyzer", "plan_writer")),
        "missing edge spec_analyzer → plan_writer"
    );
    assert!(
        edge_pairs.contains(&("plan_writer", "build")),
        "missing edge plan_writer → build"
    );
    assert!(
        edge_pairs.contains(&("plan_writer", "assessor")),
        "missing edge plan_writer → assessor (plan fan-out)"
    );
    assert!(
        edge_pairs.contains(&("build", "assessor")),
        "missing edge build → assessor"
    );

    // Verify the assessor has a required build_result input and an optional plan input.
    let assessor = stages.get("assessor").unwrap();
    let build_result_input = assessor.inputs.iter().find(|i| i.name == "build_result");
    let plan_input = assessor.inputs.iter().find(|i| i.name == "plan");
    assert!(build_result_input.is_some(), "assessor must have build_result input");
    assert!(!build_result_input.unwrap().optional, "build_result input must be required");
    assert!(plan_input.is_some(), "assessor must have plan input");
    assert!(!plan_input.unwrap().optional, "assessor plan input must be required (PLAN slot binding needs it)");

    // Verify pr_summary is NOT in the workflow graph (registered but not wired yet).
    for (_, stage) in stages {
        for out in &stage.outputs {
            assert_ne!(
                out.artifact_type, "dev.pr_summary",
                "dev.pr_summary should not be wired into the first workflow graph"
            );
        }
    }
}

// ── Prompt file existence + root containment ──────────────────────────────────

#[test]
fn dev_flow_all_prompt_files_exist_and_are_root_contained() {
    let raw = load_dev_flow_json();
    let def: WorkflowDef = serde_json::from_value(raw).unwrap();
    let prompts_dir = manifest_dir().join("prompts");
    let canonical_prompts = std::fs::canonicalize(&prompts_dir)
        .unwrap_or_else(|e| panic!("cannot canonicalize {}: {e}", prompts_dir.display()));

    for (stage_key, stage) in &def.graph.stages {
        let cfg: DelegatedSessionDefConfig = serde_json::from_value(stage.config.clone())
            .unwrap_or_else(|e| {
                panic!("stage '{stage_key}' config failed to parse as DelegatedSessionDefConfig: {e}")
            });

        let rel = &cfg.prompt_template_path;
        let full = prompts_dir.join(rel);

        assert!(
            full.exists(),
            "prompt '{rel}' referenced by stage '{stage_key}' does not exist at {}",
            full.display()
        );

        let canonical_full = std::fs::canonicalize(&full)
            .unwrap_or_else(|e| panic!("cannot canonicalize {}: {e}", full.display()));

        assert!(
            canonical_full.starts_with(&canonical_prompts),
            "prompt '{rel}' for stage '{stage_key}' escapes the prompts directory"
        );
    }
}

// ── pre_authorized_tools rejection ───────────────────────────────────────────

#[test]
fn dev_flow_all_stages_have_empty_pre_authorized_tools() {
    let raw = load_dev_flow_json();
    let def: WorkflowDef = serde_json::from_value(raw).unwrap();
    for (stage_key, stage) in &def.graph.stages {
        let cfg: DelegatedSessionDefConfig = serde_json::from_value(stage.config.clone())
            .unwrap_or_else(|e| panic!("stage '{stage_key}' config parse error: {e}"));
        assert!(
            cfg.pre_authorized_tools.is_empty(),
            "stage '{stage_key}' must have empty pre_authorized_tools in the workflow definition"
        );
    }
}

// ── First delegated-session smoke creation ────────────────────────────────────

#[tokio::test]
async fn dev_flow_spec_analyzer_build_config_succeeds() {
    let prompts_dir = manifest_dir().join("prompts");
    let stage = DelegatedSessionStage::new(
        prompts_dir,
        KbblClient::new("http://127.0.0.1:8080/").unwrap(),
    );

    let raw = load_dev_flow_json();
    let def: WorkflowDef = serde_json::from_value(raw).unwrap();
    let spec_analyzer_stage = def.graph.stages.get("spec_analyzer").unwrap();

    let stage_instance_id = StageInstanceId(
        Uuid::parse_str("00000000-0000-0000-0000-000000000042").unwrap(),
    );

    let run_context = json!({
        "brief_notes": "Implement a small feature: add a /hello endpoint.",
        "worktree_path": "/tmp/test-worktree",
        "oakridge_url": "http://127.0.0.1:9000/"
    });

    let config = stage
        .build_config(
            &spec_analyzer_stage.config,
            &HashMap::new(),
            &spec_analyzer_stage.outputs,
            stage_instance_id,
            &run_context,
        )
        .await
        .expect("build_config for spec_analyzer must succeed");

    let resolved: oakridge_core::executor::delegated_session::config::DelegatedSessionConfig =
        serde_json::from_value(config).expect("resolved config must deserialize");

    // Prompt was rendered with context slots.
    assert!(
        resolved.rendered_prompt.contains("Implement a small feature"),
        "BRIEF_NOTES slot must appear in rendered prompt"
    );
    assert!(
        resolved.rendered_prompt.contains("/tmp/test-worktree"),
        "WORKTREE_PATH slot must appear in rendered prompt"
    );
    assert!(
        resolved.rendered_prompt.contains("00000000-0000-0000-0000-000000000042"),
        "STAGE_INSTANCE_ID must appear in rendered prompt"
    );
    assert_eq!(
        resolved.workdir,
        std::path::PathBuf::from("/tmp/test-worktree"),
        "workdir must resolve from context /worktree_path"
    );
    assert!(
        resolved.session_name.contains("00000000-0000-0000-0000-000000000042"),
        "session_name must include STAGE_INSTANCE_ID"
    );
    assert!(
        resolved.pre_authorized_tools.is_empty(),
        "pre_authorized_tools must be empty"
    );
    assert_eq!(resolved.output_slots, spec_analyzer_stage.outputs);
}
