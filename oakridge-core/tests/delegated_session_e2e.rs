#![cfg(unix)]

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Json;
use axum::Router;
use chrono::Utc;
use serde_json::json;
use tokio::sync::Mutex;
use uuid::Uuid;

use oakridge_core::db::{self, queries};
use oakridge_core::executor::ResumePayload;
use oakridge_core::http::{boot, Config};
use oakridge_core::registry::ArtifactTypeDef;
use oakridge_core::types::*;

/// Serializes the `set_var("OAKRIDGE_PROMPTS_DIR") → boot() → remove_var` window
/// across the two tests in this binary. The var is process-global and read once
/// inside boot() (http/mod.rs), where it is captured into the executor's
/// `prompts_dir`. Without this lock, parallel tests race: one test's
/// `remove_var` can land before the other's boot reads it, so that boot captures
/// the `./prompts` default. `build_config` then fails in `load_template` BEFORE
/// the scheduler writes the stage-instance row — surfacing as "no stage instance
/// appeared within timeout". Holding this guard across the await is safe: only
/// these two tests contend and neither re-acquires it.
static PROMPTS_ENV_LOCK: Mutex<()> = Mutex::const_new(());

// ── Poll helpers ──────────────────────────────────────────────────────────────

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
            panic!("stage failed: {:?}", si.parked_reason);
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

async fn poll_until_done(
    pool: &sqlx::SqlitePool,
    si_id: StageInstanceId,
    timeout: Duration,
) {
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
        let run = queries::get_workflow_run_by_id(pool, &run_id).await.unwrap();
        if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
            return;
        }
    }
    panic!("run did not reach terminal status within 30s");
}

// ── Mock kbbl server ──────────────────────────────────────────────────────────

/// Shared state for the mock kbbl server.
#[derive(Default)]
struct MockKbblState {
    callback_base_url: String,
    stage_instance_id: String,
    emit_path: String,
    status_path: String,
    client: Option<reqwest::Client>,
}

async fn mock_sessions_handler(
    State(state): State<Arc<Mutex<MockKbblState>>>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut s = state.lock().await;
    if let Some(cb) = body.get("callback") {
        s.callback_base_url = cb
            .get("base_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        s.stage_instance_id = cb
            .get("stage_instance_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        s.emit_path = cb
            .get("emit_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        s.status_path = cb
            .get("status_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
    }
    let client = s.client.clone().unwrap_or_default();
    let base_url = s.callback_base_url.clone();
    let stage_id = s.stage_instance_id.clone();

    // Simulate a tool-approval request: POST to oakridge's /stages/:id/approvals.
    // Retry until 2xx so the callback tolerates the window between execute()
    // returning the kbbl sid and the StageContext being inserted into live_delegated.
    tokio::spawn(async move {
        let url = format!("{}/stages/{}/approvals", base_url, stage_id);
        for _ in 0..50u32 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            match client
                .post(&url)
                .json(&json!({
                    "request_id": "test-req-001",
                    "tool_label": "Bash",
                    "sid": "mock-kbbl-0001",
                }))
                .timeout(Duration::from_secs(5))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => break,
                _ => {}
            }
        }
    });

    (StatusCode::CREATED, Json(json!({"sid": "mock-kbbl-0001"})))
}

async fn mock_approval_handler(
    State(state): State<Arc<Mutex<MockKbblState>>>,
    Path(_sid): Path<String>,
    Json(_body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let s = state.lock().await;
    let client = s.client.clone().unwrap_or_default();
    let base_url = s.callback_base_url.clone();
    let emit_path = s.emit_path.clone();
    let status_path = s.status_path.clone();
    let stage_id = s.stage_instance_id.clone();
    drop(s);

    // After receiving the approval decision, emit artifact then report done.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let artifact_url = format!("{}{}", base_url, emit_path);
        let _ = client
            .post(&artifact_url)
            .json(&json!({
                "output_name": "out",
                "body": {"result": "e2e-delegated-complete"},
            }))
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        let status_url = format!("{}{}", base_url, status_path);
        let _ = client
            .post(&status_url)
            .json(&json!({
                "status": "done",
                "sid": "mock-kbbl-0001",
                "stage_instance_id": stage_id,
            }))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    });

    (StatusCode::OK, Json(json!({"ok": true})))
}

// ── E2E: full lifecycle ────────────────────────────────────────────────────────

/// Full lifecycle via delegated_session:
///   Pending → Running → Parked (approval notification) → Running (resume) → Done
///
/// The mock-kbbl server:
///   1. Accepts POST /sessions → returns {sid: "mock-kbbl-0001"}
///   2. Immediately POSTs a tool-approval notification to oakridge (/stages/:id/approvals)
///      → stage transitions to Parked
///   3. After the test resumes (POST /stage_instances/:id/resume), oakridge forwards
///      the decision to mock-kbbl's /:sid/approval endpoint
///   4. mock-kbbl emits an artifact then reports "done" → stage transitions to Done
#[tokio::test(flavor = "multi_thread")]
async fn delegated_session_e2e_lifecycle() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();
    std::fs::write(prompts_dir.join("e2e_prompt.md"), "delegated e2e test prompt").unwrap();

    // Bind the oakridge listener first so we know its port.
    let oakridge_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oakridge_port = oakridge_listener.local_addr().unwrap().port();

    // Bind the mock kbbl listener.
    let mock_kbbl_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_kbbl_port = mock_kbbl_listener.local_addr().unwrap().port();

    let oakridge_base = format!("http://127.0.0.1:{}", oakridge_port);
    let mock_kbbl_base = format!("http://127.0.0.1:{}", mock_kbbl_port);

    // ── Boot oakridge ──────────────────────────────────────────────────────────

    let db_url = format!(
        "sqlite://{}",
        tmp.path().join("e2e.db").to_str().unwrap()
    );
    let db_url2 = db_url.clone();

    let prompts_dir_clone = prompts_dir.clone();
    // Hold across set_var → boot → remove_var so this boot captures THIS test's
    // prompts dir; see PROMPTS_ENV_LOCK.
    let _env_guard = PROMPTS_ENV_LOCK.lock().await;
    std::env::set_var("OAKRIDGE_PROMPTS_DIR", prompts_dir_clone.to_str().unwrap());

    let (router, coord) = boot(
        Config {
            port: oakridge_port,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
        },
        |_stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
            });
            // DelegatedSession is always registered inside boot(); no explicit call needed.
        },
    )
    .await
    .unwrap();
    // Remove immediately after boot() reads it — avoids leaking a tempdir path
    // into parallel tests that call boot(register_types).
    std::env::remove_var("OAKRIDGE_PROMPTS_DIR");
    drop(_env_guard);

    tokio::spawn(async move {
        axum::serve(
            oakridge_listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // ── Start mock kbbl server ─────────────────────────────────────────────────

    let mock_state = Arc::new(Mutex::new(MockKbblState {
        client: Some(reqwest::Client::new()),
        ..Default::default()
    }));

    let mock_router = Router::new()
        .route("/sessions", post(mock_sessions_handler))
        .route("/:sid/approval", post(mock_approval_handler))
        .with_state(mock_state);

    tokio::spawn(async move {
        axum::serve(mock_kbbl_listener, mock_router).await.unwrap();
    });

    // ── Create WorkflowDef with delegated_session stage ────────────────────────

    let pool = db::init_pool(&db_url2).await.unwrap();
    let workdir_str = workdir.to_string_lossy().to_string();

    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("e2e-delegated-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = HashMap::new();
                m.insert(
                    "agent".into(),
                    StageNodeDef {
                        stage_type: "delegated_session".into(),
                        config: json!({
                            "backend": "claude-code",
                            "prompt_template_path": "e2e_prompt.md",
                            "slot_bindings": {},
                            "workdir": {"from": "literal", "value": workdir_str},
                            "model": null,
                            "pre_authorized_tools": [],
                            "yolo": false,
                            "execution_service_url": mock_kbbl_base,
                            "callback_base_url": oakridge_base,
                        }),
                        inputs: vec![],
                        outputs: vec![OutputSlot {
                            name: "out".into(),
                            artifact_type: "any".into(),
                        }],
                    },
                );
                m
            },
            edges: vec![],
        },
        created_at: Utc::now(),
    };
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Pending,
        context: json!({}),
        version: 1,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    queries::insert_workflow_run(&pool, &run).await.unwrap();
    coord.start_run(run.id).await.unwrap();

    let timeout = Duration::from_secs(30);

    // ── DoD 1+2 setup: wait for stage, then for Parked (approval notification) ─

    let si_id = poll_for_any_stage(&pool, run.id, timeout).await;

    // Stage parks as mock-kbbl fires the approval notification.
    poll_until_status(&pool, si_id, StageStatus::Parked, timeout).await;

    // Verify parked_meta contains request_id.
    let si = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();
    let request_id: String = si
        .parked_meta
        .as_ref()
        .and_then(|m| m.get("request_id"))
        .and_then(|v| v.as_str())
        .expect("parked_meta.request_id must be set")
        .to_string();

    // ── DoD 3: tool approval parks and resolves ────────────────────────────────

    // Resume with Executor payload — oakridge forwards decision to mock-kbbl.
    coord
        .resume_parked_stage_if_active(
            run.id,
            si_id,
            ResumePayload::Executor {
                payload: json!({
                    "request_id": request_id,
                    "decision": {"approved": true},
                }),
            },
        )
        .await
        .unwrap();

    // mock-kbbl receives the forwarded decision and then emits artifact + done.

    // ── DoD 1: artifact arrives via /stage_instances/:id/artifacts callback ────
    // ── DoD 2: stage reaches Done via /stage_instances/:id/status callback ─────

    poll_until_done(&pool, si_id, timeout).await;

    let artifacts = queries::list_artifacts_for_run(&pool, &run.id, None)
        .await
        .unwrap();
    assert!(
        !artifacts.is_empty(),
        "artifacts callback must have persisted at least one artifact"
    );
    let artifact = artifacts.iter().find(|a| a.output_name.as_deref() == Some("out"));
    assert!(artifact.is_some(), "artifact on slot 'out' must be persisted");
    let artifact = artifact.unwrap();
    assert_eq!(
        artifact.body.get("result").and_then(|v| v.as_str()),
        Some("e2e-delegated-complete"),
        "artifact body must match mock-kbbl emit payload"
    );

    wait_run_done(&pool, run.id).await;
    let final_run = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
    assert_eq!(final_run.status, RunStatus::Done);
}

// ── E2E: POST /sessions failure rolls the stage to Failed ───────────────────────

/// A mock kbbl whose POST /sessions always rejects.
async fn mock_sessions_fail_handler() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "simulated execution-service failure"})),
    )
}

/// Regression for the execute() reorder: the stage is moved to Running and
/// registered in the live map BEFORE the POST. When the POST is rejected, the
/// rollback drops the ctx from the live map and returns Err; the Coordinator then
/// marks the stage Failed. The stage must end Failed — never stranded in Running.
#[tokio::test(flavor = "multi_thread")]
async fn delegated_session_post_failure_rolls_to_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();
    std::fs::write(prompts_dir.join("e2e_prompt.md"), "delegated failure test prompt").unwrap();

    let oakridge_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oakridge_port = oakridge_listener.local_addr().unwrap().port();
    let mock_kbbl_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_kbbl_port = mock_kbbl_listener.local_addr().unwrap().port();
    let oakridge_base = format!("http://127.0.0.1:{}", oakridge_port);
    let mock_kbbl_base = format!("http://127.0.0.1:{}", mock_kbbl_port);

    let db_url = format!("sqlite://{}", tmp.path().join("fail.db").to_str().unwrap());
    let db_url2 = db_url.clone();

    // Hold across set_var → boot → remove_var so this boot captures THIS test's
    // prompts dir; see PROMPTS_ENV_LOCK.
    let _env_guard = PROMPTS_ENV_LOCK.lock().await;
    std::env::set_var("OAKRIDGE_PROMPTS_DIR", prompts_dir.to_str().unwrap());
    let (router, coord) = boot(
        Config {
            port: oakridge_port,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
        },
        |_stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
            });
        },
    )
    .await
    .unwrap();
    std::env::remove_var("OAKRIDGE_PROMPTS_DIR");
    drop(_env_guard);

    tokio::spawn(async move {
        axum::serve(
            oakridge_listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let mock_router = Router::new().route("/sessions", post(mock_sessions_fail_handler));
    tokio::spawn(async move {
        axum::serve(mock_kbbl_listener, mock_router).await.unwrap();
    });

    let pool = db::init_pool(&db_url2).await.unwrap();
    let workdir_str = workdir.to_string_lossy().to_string();

    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("e2e-delegated-fail-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = HashMap::new();
                m.insert(
                    "agent".into(),
                    StageNodeDef {
                        stage_type: "delegated_session".into(),
                        config: json!({
                            "backend": "claude-code",
                            "prompt_template_path": "e2e_prompt.md",
                            "slot_bindings": {},
                            "workdir": {"from": "literal", "value": workdir_str},
                            "model": null,
                            "pre_authorized_tools": [],
                            "yolo": false,
                            "execution_service_url": mock_kbbl_base,
                            "callback_base_url": oakridge_base,
                        }),
                        inputs: vec![],
                        outputs: vec![OutputSlot {
                            name: "out".into(),
                            artifact_type: "any".into(),
                        }],
                    },
                );
                m
            },
            edges: vec![],
        },
        created_at: Utc::now(),
    };
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Pending,
        context: json!({}),
        version: 1,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    queries::insert_workflow_run(&pool, &run).await.unwrap();
    coord.start_run(run.id).await.unwrap();

    let timeout = Duration::from_secs(30);
    let si_id = poll_for_any_stage(&pool, run.id, timeout).await;

    // POST /sessions 500 → rollback → Coordinator marks Failed. Never stuck Running.
    poll_until_status(&pool, si_id, StageStatus::Failed, timeout).await;

    let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
    assert_eq!(si.status, StageStatus::Failed);
}
