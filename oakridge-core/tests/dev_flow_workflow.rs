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
use oakridge_core::types::{StageInstanceId, WorkflowDef};
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
    let create_def = json!({
        "name": raw["name"],
        "version": raw["version"],
        "graph": raw["graph"]
    });
    let (status, def) = request_json(app.clone(), "POST", "/workflow_defs", create_def).await;
    assert_eq!(status, StatusCode::CREATED, "workflow def body: {def}");
    let workflow_def_id = def["id"].clone();

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
