use std::collections::HashMap;
use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{OriginalUri, State},
    http::{Method, Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::executor::delegated_session::{
    config::DelegatedSessionDefConfig, kbbl_client::KbblClient, DelegatedSessionStage,
};
use oakridge_core::registry::register_dev_flow_types;
use oakridge_core::registry::stage_type::StageType;
use oakridge_core::types::{StageInstanceId, StageOperatorRole, WorkflowDef};
use oakridge_core::{boot, Config};

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

fn load_dev_flow_v4() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v4.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v5() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v5.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v6() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v6.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v7() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v7.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v8() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v8.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v9() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v9.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn load_dev_flow_v10() -> WorkflowDef {
    let path = manifest_dir().join("examples/dev_flow_v10.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RecordedRequest {
    method: Method,
    path: String,
    body: Option<serde_json::Value>,
}

#[derive(Clone, Default)]
struct FakeKbblState {
    requests: Arc<Mutex<VecDeque<RecordedRequest>>>,
}

impl FakeKbblState {
    fn record(&self, method: Method, path: String, body: Option<serde_json::Value>) {
        self.requests
            .lock()
            .unwrap()
            .push_back(RecordedRequest { method, path, body });
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().iter().cloned().collect()
    }
}

async fn fake_create_session(
    State(state): State<FakeKbblState>,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    state.record(Method::POST, uri.path().to_owned(), Some(body));
    (
        StatusCode::OK,
        Json(json!({
            "sid": "sid-dev-flow",
            "worktreePath": null,
            "worktreeBranch": null,
            "worktreeBaseRef": null
        })),
    )
}

async fn fake_post(
    State(state): State<FakeKbblState>,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    state.record(Method::POST, uri.path().to_owned(), Some(body));
    Json(json!({"ok": true}))
}

async fn fake_events(
    State(state): State<FakeKbblState>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    state.record(Method::GET, uri.to_string(), None);
    Json(json!({
        "session_id": "sid-dev-flow",
        "events": []
    }))
}

async fn spawn_fake_kbbl() -> (String, FakeKbblState, tokio::task::JoinHandle<()>) {
    let state = FakeKbblState::default();
    let app = Router::new()
        .route("/sessions", post(fake_create_session))
        .route("/:sid/input", post(fake_post))
        .route("/:sid/yolo", post(fake_post))
        .route("/:sid/events", get(fake_events))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let join = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/"), state, join)
}

async fn request_json(
    app: Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    (status, value)
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
    assert!(
        stages.contains_key("spec_analyzer"),
        "missing spec_analyzer stage"
    );
    assert!(
        stages.contains_key("plan_writer"),
        "missing plan_writer stage"
    );
    assert!(stages.contains_key("build"), "missing build stage");
    assert!(stages.contains_key("assessor"), "missing assessor stage");

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

    // Verify the assessor has required build_result and plan inputs.
    let assessor = stages.get("assessor").unwrap();
    let build_result_input = assessor.inputs.iter().find(|i| i.name == "build_result");
    let plan_input = assessor.inputs.iter().find(|i| i.name == "plan");
    assert!(
        build_result_input.is_some(),
        "assessor must have build_result input"
    );
    assert!(
        !build_result_input.unwrap().optional,
        "build_result input must be required"
    );
    assert!(plan_input.is_some(), "assessor must have plan input");
    assert!(
        !plan_input.unwrap().optional,
        "assessor plan input must be required (PLAN slot binding needs it)"
    );

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

#[test]
fn dev_flow_v4_assesses_each_completed_cohort_in_its_build_worktree() {
    let def = load_dev_flow_v4();
    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 4);

    let assessor = def.graph.stages.get("assessor").unwrap();
    let input = assessor
        .inputs
        .iter()
        .find(|input| input.name == "build_result")
        .unwrap();
    assert_eq!(
        input.delivery,
        oakridge_core::types::InputDelivery::UnitComplete
    );

    let config: DelegatedSessionDefConfig =
        serde_json::from_value(assessor.config.clone()).unwrap();
    let fan_out = config.fan_out.unwrap();
    assert_eq!(
        fan_out.inherit_worktree_from.as_deref(),
        Some("build_result")
    );
    assert!(fan_out.worktree.is_none());
    let model = serde_json::to_value(config.model).unwrap();
    let effort = serde_json::to_value(config.effort).unwrap();
    assert_eq!(model, json!({"from": "context", "path": "/planner_model"}));
    assert_eq!(
        effort,
        json!({"from": "context", "path": "/planner_effort"})
    );
}

#[test]
fn dev_flow_v5_binds_runtime_model_and_effort_per_role() {
    let def = load_dev_flow_v5();
    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 5);

    // A model is only valid against the runtime it was chosen from, so every stage
    // must bind both from the same role rather than pinning one and binding the other.
    for (stage_key, role) in [
        ("spec_analyzer", "planner"),
        ("plan_writer", "planner"),
        ("assessor", "planner"),
        ("build", "worker"),
    ] {
        let stage = def
            .graph
            .stages
            .get(stage_key)
            .unwrap_or_else(|| panic!("stage '{stage_key}' missing from dev-flow v5"));
        let config: DelegatedSessionDefConfig =
            serde_json::from_value(stage.config.clone()).unwrap();

        for (field, value) in [
            ("runtime", serde_json::to_value(&config.runtime).unwrap()),
            ("model", serde_json::to_value(&config.model).unwrap()),
            ("effort", serde_json::to_value(&config.effort).unwrap()),
        ] {
            assert_eq!(
                value,
                json!({"from": "context", "path": format!("/{role}_{field}")}),
                "stage '{stage_key}' must bind {field} from /{role}_{field}"
            );
        }
    }
}

#[test]
fn dev_flow_v6_declares_review_gate_sequences() {
    use oakridge_core::executor::delegated_session::config::DelegatedGateKind;

    let def = load_dev_flow_v6();
    assert_eq!(def.version, 6);
    for (stage_key, output, steps, requires_items) in [
        (
            "spec_analyzer",
            "spec_analysis",
            vec![DelegatedGateKind::ArtifactApproval],
            true,
        ),
        (
            "plan_writer",
            "plan",
            vec![DelegatedGateKind::ArtifactApproval],
            false,
        ),
        (
            "build",
            "build_result",
            vec![
                DelegatedGateKind::ArtifactApproval,
                DelegatedGateKind::MergeConfirmation,
            ],
            false,
        ),
    ] {
        let stage = def.graph.stages.get(stage_key).unwrap();
        let config: DelegatedSessionDefConfig =
            serde_json::from_value(stage.config.clone()).unwrap();
        assert!(
            config.gate_output.is_none(),
            "v6 must use the explicit policy contract"
        );
        let gate = config.output_gate.unwrap();
        assert_eq!(gate.output, output);
        assert_eq!(
            gate.steps
                .iter()
                .map(|step| step.gate_type)
                .collect::<Vec<_>>(),
            steps
        );
        assert_eq!(gate.requires_zero_open_review_items, requires_items);
    }
}

#[test]
fn dev_flow_v6_build_requires_manual_cohort_admission() {
    let def = load_dev_flow_v6();
    let stage = def.graph.stages.get("build").unwrap();
    let config: DelegatedSessionDefConfig = serde_json::from_value(stage.config.clone()).unwrap();
    assert!(config.fan_out.unwrap().manual_admission);
}

#[test]
fn dev_flow_v7_requires_repository_epic_topology_for_cohort_worktrees_and_prs() {
    use oakridge_core::executor::delegated_session::config::Bindable;
    use oakridge_core::executor::prompt_config::SlotBinding;

    let def = load_dev_flow_v7();
    assert_eq!(def.version, 7);
    assert_eq!(
        def.graph.stages["spec_analyzer"].operator_role,
        Some(StageOperatorRole::Spec)
    );
    assert_eq!(
        def.graph.stages["plan_writer"].operator_role,
        Some(StageOperatorRole::Plan)
    );
    let stage = def.graph.stages.get("build").unwrap();
    assert_eq!(stage.operator_role, Some(StageOperatorRole::Build));
    assert_eq!(
        def.graph.stages["assessor"].operator_role,
        Some(StageOperatorRole::Assessment)
    );
    let config: DelegatedSessionDefConfig = serde_json::from_value(stage.config.clone()).unwrap();
    assert_eq!(config.prompt_template_path, "dev-flow/build_v2.md");
    let fan_out = config.fan_out.unwrap();
    let worktree = fan_out.worktree.unwrap();
    assert_eq!(
        worktree.base_ref,
        Some(Bindable::Bound(SlotBinding::ContextLookup {
            collection_path: "/repositories".into(),
            collection_key_path: "/key".into(),
            item_key_path: "/repository_key".into(),
            value_path: "/epic_branch".into(),
        }))
    );
    assert!(matches!(
        fan_out.item_bindings.get("EXPECTED_FINAL_BASE"),
        Some(SlotBinding::ContextLookup { value_path, .. }) if value_path == "/base_branch"
    ));
}

#[test]
fn dev_flow_v6_remains_loadable_without_git_topology_bindings() {
    let def = load_dev_flow_v6();
    let stage = def.graph.stages.get("build").unwrap();
    let config: DelegatedSessionDefConfig = serde_json::from_value(stage.config.clone()).unwrap();
    assert!(config.fan_out.unwrap().worktree.unwrap().base_ref.is_none());
}

#[test]
fn dev_flow_v8_gates_briefs_and_preserves_repository_epic_topology() {
    use oakridge_core::executor::delegated_session::config::{
        Bindable, DelegatedGateKind, RevisionTarget,
    };
    use oakridge_core::executor::prompt_config::SlotBinding;

    let def = load_dev_flow_v8();
    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 8);
    assert_eq!(
        def.graph.stages["brief_writer"].operator_role,
        Some(StageOperatorRole::Brief)
    );

    let brief_config: DelegatedSessionDefConfig =
        serde_json::from_value(def.graph.stages["brief_writer"].config.clone()).unwrap();
    let brief_fan_out = brief_config.fan_out.unwrap();
    assert_eq!(brief_fan_out.unit_id_path, "/id");
    assert_eq!(
        brief_fan_out.session_mode,
        oakridge_core::executor::delegated_session::config::FanOutSessionMode::Shared
    );
    assert!(brief_fan_out.item_bindings.is_empty());
    let gate = brief_config.output_gate.unwrap();
    assert_eq!(gate.output, "brief");
    assert_eq!(gate.steps[0].gate_type, DelegatedGateKind::ArtifactApproval);

    let build = &def.graph.stages["build"];
    let brief_input = build
        .inputs
        .iter()
        .find(|input| input.name == "brief")
        .unwrap();
    assert_eq!(brief_input.artifact_type, "dev.build_brief");
    assert_eq!(
        brief_input.delivery,
        oakridge_core::types::InputDelivery::UnitComplete
    );
    let build_config: DelegatedSessionDefConfig =
        serde_json::from_value(build.config.clone()).unwrap();
    assert_eq!(build_config.prompt_template_path, "dev-flow/build_v2.md");
    assert!(build_config.output_gate.is_none());
    let handoff = build_config.output_handoff.as_ref().unwrap();
    assert_eq!(handoff.output, "build_result");
    assert_eq!(handoff.downstream_role, StageOperatorRole::Assessment);
    assert_eq!(handoff.approved_wait.kind, "github_review");
    let fan_out = build_config.fan_out.unwrap();
    assert!(!fan_out.manual_admission);
    assert_eq!(
        fan_out.depends_on_path.as_deref(),
        Some("/artifact/depends_on")
    );
    assert_eq!(
        fan_out.item_bindings.get("COHORT_FILES"),
        Some(&SlotBinding::Item {
            path: "/artifact/files_in_scope".into(),
        })
    );
    assert!(
        std::fs::read_to_string(manifest_dir().join("prompts/dev-flow/build_v2.md"))
            .unwrap()
            .contains("{{COHORT_FILES}}")
    );
    assert_eq!(
        fan_out.worktree.unwrap().base_ref,
        Some(Bindable::Bound(SlotBinding::ContextLookup {
            collection_path: "/repositories".into(),
            collection_key_path: "/key".into(),
            item_key_path: "/artifact/repository_key".into(),
            value_path: "/epic_branch".into(),
        }))
    );

    let assessor_config: DelegatedSessionDefConfig =
        serde_json::from_value(def.graph.stages["assessor"].config.clone()).unwrap();
    let assessment_gate = assessor_config.output_gate.unwrap();
    assert_eq!(assessment_gate.output, "assessment");
    assert_eq!(assessment_gate.steps.len(), 1);
    assert_eq!(
        assessment_gate.steps[0].gate_type,
        DelegatedGateKind::ArtifactApproval
    );
    assert_eq!(
        assessment_gate.revision_target,
        RevisionTarget::UpstreamHandoff
    );
}

#[test]
fn dev_flow_v9_installs_single_session_brief_writer_as_a_new_definition() {
    let previous = load_dev_flow_v8();
    let def = load_dev_flow_v9();
    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 9);
    assert_ne!(def.id, previous.id);

    let config: DelegatedSessionDefConfig =
        serde_json::from_value(def.graph.stages["brief_writer"].config.clone()).unwrap();
    assert!(config.fan_out.is_none());
    let artifacts = config.artifacts.unwrap();
    assert_eq!(artifacts.id_path, "/id");
    assert_eq!(config.session_name, "brief-writer-{{STAGE_INSTANCE_ID}}");
}

#[test]
fn dev_flow_v10_assesses_only_the_matching_cohort_brief() {
    let previous = load_dev_flow_v9();
    let def = load_dev_flow_v10();
    assert_eq!(def.name, "dev-flow");
    assert_eq!(def.version, 10);
    assert_ne!(def.id, previous.id);

    let assessor = &def.graph.stages["assessor"];
    let config: DelegatedSessionDefConfig =
        serde_json::from_value(assessor.config.clone()).unwrap();
    assert_eq!(config.prompt_template_path, "dev-flow/assessor_v2.md");
    assert_eq!(
        serde_json::to_value(&config.slot_bindings["BRIEF"]).unwrap(),
        json!({"from": "input", "input_name": "brief", "path": null})
    );
    assert!(!config.slot_bindings.contains_key("PLAN"));
    assert!(assessor.inputs.iter().any(|input| {
        input.name == "brief"
            && input.artifact_type == "dev.build_brief"
            && input.delivery == oakridge_core::types::InputDelivery::UnitComplete
    }));
    assert!(!assessor.inputs.iter().any(|input| input.name == "plan"));
    assert!(def.graph.edges.iter().any(|edge| {
        edge.from.stage == "brief_writer"
            && edge.from.slot == "brief"
            && edge.to.stage == "assessor"
            && edge.to.slot == "brief"
    }));
    assert!(!def
        .graph
        .edges
        .iter()
        .any(|edge| { edge.from.stage == "plan_writer" && edge.to.stage == "assessor" }));

    let prompt =
        std::fs::read_to_string(manifest_dir().join("prompts/dev-flow/assessor_v2.md")).unwrap();
    assert!(prompt.contains("Assess only the cohort identified"));
    assert!(prompt.contains("Do not assess plan-level acceptance criteria or any other cohort"));
    assert!(prompt.contains("Work belonging to dependent or later cohorts is intentionally absent"));
    assert!(prompt.contains("{{BRIEF}}"));
    assert!(!prompt.contains("{{PLAN}}"));
}

#[test]
fn v2_planning_prompts_define_topology_and_discrepancy_preconditions() {
    let prompts = manifest_dir().join("prompts/dev-flow");
    let analyzer = std::fs::read_to_string(prompts.join("spec_analyzer_v2.md")).unwrap();
    assert!(analyzer.contains("requested changes as requirements, not discrepancies"));
    assert!(analyzer.contains("incompatible with the current"));

    let planner = std::fs::read_to_string(prompts.join("plan_writer_v2.md")).unwrap();
    assert!(planner.contains("created from the latest remote tip"));
    assert!(planner.contains("Repository topology is a run-creation invariant"));
    assert!(planner.contains("Do not create,"));
    assert!(planner.contains("rebase, reset, or otherwise repair"));
    assert!(planner.contains("before-to-after difference is the work"));
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
                panic!(
                    "stage '{stage_key}' config failed to parse as DelegatedSessionDefConfig: {e}"
                )
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
        assert!(
            !cfg.yolo,
            "stage '{stage_key}' must keep yolo disabled so kbbl PWA owns per-tool approvals"
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

    let stage_instance_id =
        StageInstanceId(Uuid::parse_str("00000000-0000-0000-0000-000000000042").unwrap());

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
        resolved
            .rendered_prompt
            .contains("Implement a small feature"),
        "BRIEF_NOTES slot must appear in rendered prompt"
    );
    assert!(
        resolved.rendered_prompt.contains("/tmp/test-worktree"),
        "WORKTREE_PATH slot must appear in rendered prompt"
    );
    assert!(
        resolved
            .rendered_prompt
            .contains("00000000-0000-0000-0000-000000000042"),
        "STAGE_INSTANCE_ID must appear in rendered prompt"
    );
    assert_eq!(
        resolved.workdir,
        std::path::PathBuf::from("/tmp/test-worktree"),
        "workdir must resolve from context /worktree_path"
    );
    assert!(
        resolved
            .session_name
            .contains("00000000-0000-0000-0000-000000000042"),
        "session_name must include STAGE_INSTANCE_ID"
    );
    assert!(
        resolved.pre_authorized_tools.is_empty(),
        "pre_authorized_tools must be empty"
    );
    assert!(
        !resolved.yolo,
        "dev-flow spec_analyzer must not enable yolo by default"
    );
    assert_eq!(resolved.output_slots, spec_analyzer_stage.outputs);
}

#[tokio::test]
async fn dev_flow_smoke_run_starts_first_delegated_session() {
    let (kbbl_base_url, fake_kbbl, fake_join) = spawn_fake_kbbl().await;
    let db_path = std::env::temp_dir().join(format!("oakridge_dev_flow_{}.db", Uuid::new_v4()));
    let cfg = Config {
        port: 0,
        bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
        db_url: format!("sqlite:{}", db_path.display()),
        pwa_dir: std::env::temp_dir(),
        cors_origins: vec![],
        auth_policy: oakridge_core::config::AuthPolicy::Loopback,
        stage_timeout_secs: 3600,
        stuck_sweep_interval_secs: 60,
    };
    let prompts_dir = manifest_dir().join("prompts");
    let (app, _coord) = boot(cfg, |stage_types, artifact_types| {
        register_dev_flow_types(artifact_types);
        stage_types.register(Arc::new(DelegatedSessionStage::new(
            prompts_dir.clone(),
            KbblClient::new(kbbl_base_url.clone()).unwrap(),
        )));
    })
    .await
    .unwrap();

    let raw = load_dev_flow_json();
    // boot() seeds the built-in dev-flow def, so it already exists — use its fixed id.
    let workflow_def_id = raw["id"].clone();

    let create_run = json!({
        "workflow_def_id": workflow_def_id,
        "project_id": null,
        "context": {
            "brief_notes": "Smoke test the packaged dev-flow workflow.",
            "worktree_path": "/tmp/dev-flow-smoke",
            "oakridge_url": "http://127.0.0.1:8790/"
        }
    });
    let (status, run) = request_json(app, "POST", "/workflow_runs", create_run).await;
    assert_eq!(status, StatusCode::CREATED, "workflow run body: {run}");

    for _ in 0..50 {
        let requests = fake_kbbl.requests();
        if requests
            .iter()
            .any(|request| request.method == Method::POST && request.path == "/sessions")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let requests = fake_kbbl.requests();
    let create_session = requests
        .iter()
        .find(|request| request.method == Method::POST && request.path == "/sessions")
        .expect("dev-flow run must create the first delegated kbbl session");
    let body = create_session.body.as_ref().unwrap();
    assert_eq!(body["runtime"], json!("claude-code"));
    assert_eq!(body["workdir"], json!("/tmp/dev-flow-smoke"));
    assert!(
        body["name"].as_str().unwrap().starts_with("spec-analyzer-"),
        "unexpected session name: {}",
        body["name"]
    );
    assert!(
        !requests
            .iter()
            .any(|request| request.method == Method::POST && request.path.ends_with("/yolo")),
        "dev-flow smoke should not enable yolo: {requests:?}"
    );

    fake_join.abort();
}
