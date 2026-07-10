#![cfg(unix)]

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use axum::{
    body::Body,
    extract::{OriginalUri, Path, State},
    http::{Method, Request, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::db::{self, queries};
use oakridge_core::executor::delegated_session::{
    config::{Bindable, DelegatedRuntime, DelegatedSessionDefConfig},
    kbbl_client::KbblClient,
    DelegatedExecutor, DelegatedGate, DelegatedGateState, DelegatedSessionStage,
};
use oakridge_core::executor::prompt_config::SlotBinding;
use oakridge_core::http::{boot, Config};
use oakridge_core::registry::{ArtifactTypeDef, ArtifactTypeRegistry, StageTypeRegistry};
use oakridge_core::types::*;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RecordedRequest {
    method: Method,
    path: String,
    body: Option<Value>,
}

#[derive(Clone)]
struct FakeKbblState {
    requests: Arc<Mutex<VecDeque<RecordedRequest>>>,
    emit_terminal_event: Arc<AtomicBool>,
    event_poll_count: Arc<AtomicUsize>,
    /// When true, the events endpoint returns 503 (simulates kbbl being unreachable).
    return_503: Arc<AtomicBool>,
}

impl FakeKbblState {
    fn new() -> Self {
        Self {
            requests: Arc::new(Mutex::new(VecDeque::new())),
            emit_terminal_event: Arc::new(AtomicBool::new(false)),
            event_poll_count: Arc::new(AtomicUsize::new(0)),
            return_503: Arc::new(AtomicBool::new(false)),
        }
    }

    fn record(&self, method: Method, path: String, body: Option<Value>) {
        self.requests
            .lock()
            .unwrap()
            .push_back(RecordedRequest { method, path, body });
    }

    fn significant_requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method != Method::GET)
            .cloned()
            .collect()
    }

    fn event_poll_count(&self) -> usize {
        self.event_poll_count.load(Ordering::SeqCst)
    }
}

async fn fake_create_session(
    State(state): State<FakeKbblState>,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state.record(Method::POST, uri.path().to_string(), Some(body));
    (
        StatusCode::CREATED,
        Json(json!({
            "sid": "sid-123",
        })),
    )
}

async fn fake_post(
    State(state): State<FakeKbblState>,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state.record(Method::POST, uri.path().to_string(), Some(body));
    Json(json!({ "ok": true }))
}

async fn fake_read_events(
    State(state): State<FakeKbblState>,
    Path(sid): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    state.record(Method::GET, uri.to_string(), None);
    state.event_poll_count.fetch_add(1, Ordering::SeqCst);

    if state.return_503.load(Ordering::SeqCst) {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response();
    }

    let events = if state.emit_terminal_event.load(Ordering::SeqCst) {
        vec![json!({
            "id": 1,
            "type": "subprocess_exited",
            "ts": "2026-01-01T00:00:00Z",
            "payload": { "code": 0, "reason": "completed" }
        })]
    } else {
        vec![]
    };
    Json(json!({
        "session_id": sid,
        "events": events,
    }))
    .into_response()
}

async fn fake_delete_session(
    State(state): State<FakeKbblState>,
    Path(sid): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    state.record(Method::DELETE, uri.path().to_string(), None);
    Json(json!({
        "ok": true,
        "removed": true,
        "sid": sid,
    }))
}

async fn spawn_fake_kbbl() -> (String, FakeKbblState, tokio::task::JoinHandle<()>) {
    let state = FakeKbblState::new();
    let app = Router::new()
        .route("/sessions", post(fake_create_session))
        .route("/:sid/input", post(fake_post))
        .route("/:sid/yolo", post(fake_post))
        .route("/:sid/events", get(fake_read_events))
        .route("/sessions/:sid", delete(fake_delete_session))
        .with_state(state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let join = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}/"), state, join)
}

async fn poll_for_any_stage(
    pool: &sqlx::SqlitePool,
    run_id: WorkflowRunId,
    timeout: Duration,
) -> StageInstanceId {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let instances = queries::list_stage_instances_for_run(pool, &run_id)
            .await
            .unwrap();
        if let Some(si) = instances.first() {
            return si.id;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no stage instance appeared within timeout"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn poll_until_status(
    pool: &sqlx::SqlitePool,
    si_id: StageInstanceId,
    expected: StageStatus,
    timeout: Duration,
) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let si = queries::get_stage_instance_by_id(pool, &si_id)
            .await
            .unwrap();
        if si.status == expected {
            return;
        }
        if si.status == StageStatus::Failed {
            panic!("stage failed with reason: {:?}", si.parked_reason);
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "stage did not reach {:?} within timeout, current: {:?}",
            expected,
            si.status
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn poll_until_done(pool: &sqlx::SqlitePool, si_id: StageInstanceId, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let si = queries::get_stage_instance_by_id(pool, &si_id)
            .await
            .unwrap();
        match si.status {
            StageStatus::Done => return,
            StageStatus::Failed => panic!("stage failed: {:?}", si.parked_reason),
            _ => {}
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "stage did not reach Done within timeout, current: {:?}",
            si.status
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_run_done(pool: &sqlx::SqlitePool, run_id: WorkflowRunId) {
    for _ in 0..600 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let run = queries::get_workflow_run_by_id(pool, &run_id)
            .await
            .unwrap();
        if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
            return;
        }
    }
    panic!("run did not reach terminal status within 30s");
}

fn delegated_workflow_def(
    prompts_dir: &PathBuf,
    workdir: &PathBuf,
) -> (WorkflowDef, serde_json::Value) {
    let mut stages = HashMap::new();
    let mut slot_bindings = HashMap::new();
    slot_bindings.insert(
        "TASK".to_string(),
        SlotBinding::Literal {
            value: "cut over delegated session data".into(),
        },
    );

    let def_config = DelegatedSessionDefConfig {
        runtime: DelegatedRuntime::ClaudeCode,
        prompt_template_path: prompts_dir
            .join("delegated_prompt.md")
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        slot_bindings,
        workdir: SlotBinding::Literal {
            value: format!("{}/{{{{STAGE_INSTANCE_ID}}}}", workdir.display()),
        },
        session_name: "delegated-{{STAGE_INSTANCE_ID}}".into(),
        model: Some(Bindable::Literal("claude-sonnet-4-6".into())),
        effort: None,
        worktree: None,
        pre_authorized_tools: vec![],
        yolo: true,
        fan_out: None,
    };

    stages.insert(
        "delegate".into(),
        StageNodeDef {
            stage_type: "delegated_session".into(),
            config: serde_json::to_value(def_config).unwrap(),
            inputs: vec![],
            outputs: vec![OutputSlot {
                name: "out".into(),
                artifact_type: "text".into(),
            }],
        },
    );

    let graph = WorkflowGraph {
        stages,
        edges: vec![],
    };
    let payload_graph = graph.clone();

    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("delegated-e2e-{}", Uuid::new_v4()),
        version: 1,
        graph,
        created_at: Utc::now(),
    };

    let config = json!({
        "name": def.name.clone(),
        "version": def.version,
        "graph": payload_graph,
    });

    (def, config)
}

async fn create_workflow_def(app: &Router, payload: Value) -> WorkflowDef {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/workflow_defs")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn create_workflow_run(app: &Router, workflow_def_id: WorkflowDefId) -> WorkflowRun {
    let payload = json!({
        "workflow_def_id": workflow_def_id,
        "project_id": null,
        "context": {}
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/workflow_runs")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn resume_stage(
    app: &Router,
    stage_instance_id: StageInstanceId,
    payload: Value,
) -> StageInstance {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/stage_instances/{}/resume", stage_instance_id.0))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn emit_artifact(app: &Router, stage_instance_id: StageInstanceId, body: Value) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/executors/delegated_session/{}/units/0/emit/out",
                    stage_instance_id.0
                ))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn delegated_session_e2e_gate_driven_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();

    std::fs::write(
        prompts_dir.join("delegated_prompt.md"),
        "Task: {{TASK}}\nStage: {{STAGE_INSTANCE_ID}}",
    )
    .unwrap();

    let (kbbl_base_url, fake_kbbl, kbbl_join) = spawn_fake_kbbl().await;
    let db_url = format!("sqlite://{}", tmp.path().join("e2e.db").to_str().unwrap());
    let db_url2 = db_url.clone();
    let prompts_dir_for_boot = prompts_dir.clone();
    let kbbl_base_url_for_boot = kbbl_base_url.clone();

    let (app, _coord) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage_types: &mut StageTypeRegistry, artifact_types: &mut ArtifactTypeRegistry| {
            artifact_types.register(ArtifactTypeDef {
                id: "text".into(),
                validate: |_| Ok(()),
                component_id: "text-viewer".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });

            stage_types.register(Arc::new(DelegatedSessionStage::new(
                prompts_dir_for_boot.clone(),
                KbblClient::new(kbbl_base_url_for_boot.clone()).unwrap(),
            )));
        },
    )
    .await
    .unwrap();

    let pool = db::init_pool(&db_url2).await.unwrap();
    let (_, workflow_payload) = delegated_workflow_def(&prompts_dir, &workdir);
    let def = create_workflow_def(&app, workflow_payload).await;
    let run = create_workflow_run(&app, def.id).await;

    let timeout = Duration::from_secs(30);
    let si_id = poll_for_any_stage(&pool, run.id, timeout).await;
    poll_until_status(&pool, si_id, StageStatus::Running, timeout).await;

    let stage_instance = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();
    // external_ref is now a JSON-serialized DelegatedExternalRef (sid + worktree fields)
    let ext_ref =
        oakridge_core::executor::delegated_session::kbbl_client::DelegatedExternalRef::parse(
            stage_instance.external_ref.as_deref().unwrap(),
        );
    assert_eq!(ext_ref.sid, "sid-123");

    let workdir_request = format!("{}/{}", workdir.display(), si_id.0);
    let prompt_text = format!("Task: cut over delegated session data\nStage: {}", si_id.0);

    let create_artifact = emit_artifact(
        &app,
        si_id,
        json!({
            "result": "draft"
        }),
    )
    .await;
    let artifact_id =
        ArtifactId(Uuid::parse_str(create_artifact["artifact_id"].as_str().unwrap()).unwrap());

    poll_until_status(&pool, si_id, StageStatus::Parked, timeout).await;

    let parked = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();
    assert_eq!(parked.status, StageStatus::Parked);
    assert_eq!(parked.parked_reason.as_deref(), Some("waiting_gate"));
    let gate_state: DelegatedGateState =
        serde_json::from_value(parked.parked_meta.clone().unwrap()).unwrap();
    assert_eq!(gate_state.executor, DelegatedExecutor::DelegatedSession);
    assert_eq!(gate_state.gate, DelegatedGate::ArtifactApproval);
    assert_eq!(gate_state.artifact_id, artifact_id);
    assert_eq!(gate_state.revision_count, 1);

    let baseline_event_polls = fake_kbbl.event_poll_count();
    fake_kbbl.emit_terminal_event.store(true, Ordering::SeqCst);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if fake_kbbl.event_poll_count() > baseline_event_polls {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "delegated session observer did not poll kbbl events again within timeout"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let parked_after_terminal = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();
    assert_eq!(
        parked_after_terminal.status,
        StageStatus::Parked,
        "kbbl subprocess_exited code 0 must not complete the delegated stage"
    );

    let approved = resume_stage(
        &app,
        si_id,
        json!({
            "kind": "gate_decision",
            "decision": {
                "outcome": "pass",
                "comment": null,
                "feedback": null
            },
            "against_artifact_id": artifact_id,
        }),
    )
    .await;
    assert_eq!(approved.status, StageStatus::Parked);
    let approved_meta: DelegatedGateState =
        serde_json::from_value(approved.parked_meta.clone().unwrap()).unwrap();
    assert_eq!(approved_meta.gate, DelegatedGate::MergeConfirmation);

    let done = resume_stage(
        &app,
        si_id,
        json!({
            "kind": "gate_decision",
            "decision": {
                "outcome": "pass",
                "comment": null,
                "feedback": null
            },
            "against_artifact_id": artifact_id,
        }),
    )
    .await;
    assert_eq!(done.status, StageStatus::Done);
    assert!(done.parked_meta.is_none());

    poll_until_done(&pool, si_id, timeout).await;
    wait_run_done(&pool, run.id).await;

    let artifacts = queries::list_artifacts_for_run(&pool, &run.id, None)
        .await
        .unwrap();
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.output_name.as_deref() == Some("out"))
        .expect("artifact on slot out must be persisted");
    assert_eq!(
        artifact.body,
        json!({"result": "draft"}),
        "delegated emit must persist the artifact body"
    );

    let significant_requests = fake_kbbl.significant_requests();
    assert_eq!(
        significant_requests,
        vec![
            RecordedRequest {
                method: Method::POST,
                path: "/sessions".into(),
                body: Some(json!({
                    "workdir": workdir_request,
                    "name": format!("delegated-{}", si_id.0),
                    "artifact_id": si_id.0.to_string(),
                    "runtime": "claude-code",
                    "model": "claude-sonnet-4-6",
                })),
            },
            RecordedRequest {
                method: Method::POST,
                path: "/sid-123/yolo".into(),
                body: Some(json!({ "enabled": true })),
            },
            RecordedRequest {
                method: Method::POST,
                path: "/sid-123/input".into(),
                body: Some(json!({ "text": prompt_text })),
            },
            RecordedRequest {
                method: Method::DELETE,
                path: "/sessions/sid-123".into(),
                body: None,
            },
        ]
    );

    let final_run = queries::get_workflow_run_by_id(&pool, &run.id)
        .await
        .unwrap();
    assert_eq!(final_run.status, RunStatus::Done);

    kbbl_join.abort();
}

/// A recovered delegated_session stage with an external_ref must be parked as
/// `waiting_for_kbbl` when kbbl is unreachable at boot, then reattach and
/// return to Running once kbbl becomes available.
#[tokio::test(flavor = "multi_thread")]
async fn waiting_for_kbbl_parks_and_reattaches() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();
    std::fs::write(
        prompts_dir.join("delegated_prompt.md"),
        "Task: {{TASK}}\nStage: {{STAGE_INSTANCE_ID}}",
    )
    .unwrap();

    let (kbbl_base_url, fake_kbbl, kbbl_join) = spawn_fake_kbbl().await;
    // Start with kbbl "unreachable" (events endpoint returns 503).
    fake_kbbl.return_503.store(true, Ordering::SeqCst);

    let db_url = format!("sqlite://{}", tmp.path().join("wfk.db").to_str().unwrap());
    let pool = db::init_pool(&db_url).await.unwrap();

    // Seed a workflow def and a Running run with a stage instance that already
    // has external_ref set (simulating a crash-recovery scenario).
    let (def, _) = delegated_workflow_def(&prompts_dir, &workdir);
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(uuid::Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Running,
        context: serde_json::json!({}),
        version: 1,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    let si_id = StageInstanceId(uuid::Uuid::new_v4());
    let config_val: serde_json::Value = {
        use oakridge_core::executor::delegated_session::config::{
            DelegatedRuntime, DelegatedSessionConfig,
        };
        use oakridge_core::executor::prompt_config::SlotBinding;
        let cfg = DelegatedSessionConfig {
            runtime: DelegatedRuntime::ClaudeCode,
            rendered_prompt: "Task: test\nStage: placeholder".into(),
            workdir: workdir.clone(),
            session_name: format!("delegated-{}", si_id.0),
            model: Some("claude-sonnet-4-6".into()),
            effort: None,
            worktree: None,
            pre_authorized_tools: vec![],
            yolo: false,
            output_slots: vec![OutputSlot {
                name: "out".into(),
                artifact_type: "text".into(),
            }],
            fan_out: None,
        };
        serde_json::to_value(cfg).unwrap()
    };
    let si = StageInstance {
        id: si_id,
        run_id: run.id,
        stage_key: "delegate".into(),
        stage_type: "delegated_session".into(),
        status: StageStatus::Running,
        config: config_val,
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: Some("sid-123".into()),
        started_at: Some(chrono::Utc::now()),
        ended_at: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    queries::insert_stage_instance(&pool, &si).await.unwrap();

    let db_url2 = db_url.clone();
    let prompts_dir2 = prompts_dir.clone();
    let kbbl_url2 = kbbl_base_url.clone();

    let (_app, _coord) = boot(
        Config {
            port: 0,
            bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            db_url: db_url2,
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage_types, artifact_types| {
            artifact_types.register(ArtifactTypeDef {
                id: "text".into(),
                validate: |_| Ok(()),
                component_id: "text-viewer".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage_types.register(Arc::new(DelegatedSessionStage::new(
                prompts_dir2,
                KbblClient::new(kbbl_url2).unwrap(),
            )));
        },
    )
    .await
    .unwrap();

    let timeout = Duration::from_secs(15);

    // Stage must be parked as waiting_for_kbbl while kbbl is unavailable.
    // Poll until both parked_reason AND parked_meta are written — they are
    // two separate DB calls and reading between them would see parked_meta=None.
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let s = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        if s.parked_reason.as_deref() == Some("waiting_for_kbbl") && s.parked_meta.is_some() {
            let meta = s.parked_meta.unwrap();
            assert_eq!(
                meta.get("kind").and_then(|v| v.as_str()),
                Some("waiting_for_kbbl"),
                "parked_meta.kind must be waiting_for_kbbl"
            );
            break;
        }
        assert!(
            s.status != StageStatus::Failed,
            "stage must not fail while waiting for kbbl: {:?}",
            s.terminal_meta
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "stage did not reach waiting_for_kbbl within timeout, current: {:?}",
            s.parked_reason
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Make kbbl available. The retry task must reattach and set stage to Running.
    fake_kbbl.return_503.store(false, Ordering::SeqCst);

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let s = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        if s.status == StageStatus::Running {
            assert!(
                s.parked_reason.is_none(),
                "parked_reason must be cleared after reattachment"
            );
            break;
        }
        // Waiting for kbbl parked is still acceptable while the retry is in flight.
        assert!(
            s.status != StageStatus::Failed,
            "stage must not fail after kbbl becomes available: {:?}",
            s.terminal_meta
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "stage did not return to Running within timeout after kbbl became available"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    kbbl_join.abort();
}

/// A Running delegated_session stage must be parked as `session_ended_without_emit`
/// when kbbl exits cleanly (code 0) before any artifact has been emitted.
#[tokio::test(flavor = "multi_thread")]
async fn session_ended_without_emit_parks_running_stage() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();
    std::fs::write(
        prompts_dir.join("delegated_prompt.md"),
        "Task: {{TASK}}\nStage: {{STAGE_INSTANCE_ID}}",
    )
    .unwrap();

    let (kbbl_base_url, fake_kbbl, kbbl_join) = spawn_fake_kbbl().await;
    let db_url = format!("sqlite://{}", tmp.path().join("sewoe.db").to_str().unwrap());
    let db_url2 = db_url.clone();
    let prompts_dir2 = prompts_dir.clone();
    let kbbl_url2 = kbbl_base_url.clone();

    let (app, _coord) = boot(
        Config {
            port: 0,
            bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage_types, artifact_types| {
            artifact_types.register(ArtifactTypeDef {
                id: "text".into(),
                validate: |_| Ok(()),
                component_id: "text-viewer".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage_types.register(Arc::new(DelegatedSessionStage::new(
                prompts_dir2,
                KbblClient::new(kbbl_url2).unwrap(),
            )));
        },
    )
    .await
    .unwrap();

    let pool = db::init_pool(&db_url2).await.unwrap();
    let (_, workflow_payload) = delegated_workflow_def(&prompts_dir, &workdir);
    let def = create_workflow_def(&app, workflow_payload).await;
    let run = create_workflow_run(&app, def.id).await;

    let timeout = Duration::from_secs(10);
    let si_id = poll_for_any_stage(&pool, run.id, timeout).await;
    poll_until_status(&pool, si_id, StageStatus::Running, timeout).await;

    // Emit clean code-0 exit from kbbl before the stage has emitted any artifact.
    fake_kbbl.emit_terminal_event.store(true, Ordering::SeqCst);

    // Stage must become Parked with parked_reason = "session_ended_without_emit".
    // Poll until both parked_reason AND parked_meta are written — they are
    // two separate DB calls and reading between them would see parked_meta=None.
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let s = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        if s.status == StageStatus::Parked
            && s.parked_reason.as_deref() == Some("session_ended_without_emit")
            && s.parked_meta.is_some()
        {
            let meta = s.parked_meta.unwrap();
            assert_eq!(
                meta.get("kind").and_then(|v| v.as_str()),
                Some("session_ended_without_emit"),
                "parked_meta.kind must be session_ended_without_emit"
            );
            break;
        }
        assert!(
            s.status != StageStatus::Failed,
            "stage must not fail on clean code-0 exit: {:?}",
            s.terminal_meta
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "stage did not reach session_ended_without_emit within timeout, current: {:?} {:?}",
            s.status,
            s.parked_reason,
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    kbbl_join.abort();
}
