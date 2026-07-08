use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::config::AuthPolicy;
use oakridge_core::db::{self, queries};
use oakridge_core::http::{boot, Config};
use oakridge_core::registry::{ArtifactTypeRegistry, StageTypeRegistry};
use oakridge_core::types::*;

fn temp_db_url() -> String {
    format!(
        "sqlite:///tmp/oakridge-stuck-sweeper-{}.db",
        Uuid::new_v4()
    )
}

fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

async fn response_json(res: axum::http::Response<Body>) -> Value {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn req(
    app: axum::Router,
    method: &str,
    uri: &str,
    body: Option<Vec<u8>>,
) -> (StatusCode, Value) {
    let b = body.unwrap_or_default();
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(b))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let json = response_json(res).await;
    (status, json)
}

// ── Sweeper integration: parked stage appears as is_stuck in /runs ─────────────

/// Seeds a Running stage instance with a stale updated_at and calls
/// sweep_stuck_stages() directly. Verifies that /runs reports is_stuck=true
/// and that POST /stage_instances/:id/retry_stuck transitions it back to Running.
#[tokio::test]
async fn stuck_sweep_and_retry_via_http() {
    let db_url = temp_db_url();

    // Boot with a 1-second stage timeout so fixed_dt() is past the cutoff.
    let cfg = Config {
        port: 0,
        bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        db_url: db_url.clone(),
        pwa_dir: PathBuf::from("/tmp"),
        cors_origins: vec![],
        auth_policy: AuthPolicy::Loopback,
        stage_timeout_secs: 1,
        stuck_sweep_interval_secs: 3600,
    };

    let (app, coordinator) = boot(cfg, |_stage: &mut StageTypeRegistry, _art: &mut ArtifactTypeRegistry| {
        // no stage types needed; we insert DB state directly
    })
    .await
    .unwrap();

    // Open a second pool for test setup — boot() owns its pool internally.
    let pool = db::init_pool(&db_url).await.unwrap();

    // Seed a workflow def, running run, and a Running stage with stale updated_at.
    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("stuck-test-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = std::collections::HashMap::new();
                m.insert(
                    "A".into(),
                    StageNodeDef {
                        stage_type: "noop".into(),
                        config: serde_json::json!({}),
                        inputs: vec![],
                        outputs: vec![],
                    },
                );
                m
            },
            edges: vec![],
        },
        created_at: fixed_dt(),
    };
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Running,
        context: serde_json::json!({}),
        version: 1,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    let si = StageInstance {
        id: StageInstanceId(Uuid::new_v4()),
        run_id: run.id,
        stage_key: "A".into(),
        stage_type: "noop".into(),
        status: StageStatus::Running,
        config: serde_json::json!({}),
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: None,
        started_at: Some(fixed_dt()),
        ended_at: None,
        created_at: fixed_dt(),
        updated_at: fixed_dt(), // stale: 2026-01-01, well past the 1s cutoff
    };
    queries::insert_stage_instance(&pool, &si).await.unwrap();

    // Trigger the sweep directly (no need to wait for the background interval).
    coordinator.sweep_stuck_stages().await.unwrap();

    // /runs must now report is_stuck=true for this run.
    let (status, runs_json) = req(app.clone(), "GET", "/runs", None).await;
    assert_eq!(status, StatusCode::OK);
    let runs = runs_json.as_array().expect("runs must be an array");
    let this_run = runs
        .iter()
        .find(|r| r["id"].as_str() == Some(&run.id.0.to_string()))
        .expect("run must appear in /runs");
    assert_eq!(
        this_run["is_stuck"].as_bool(),
        Some(true),
        "is_stuck must be true after sweep"
    );

    // POST /stage_instances/:id/retry_stuck must transition back to Running.
    let retry_uri = format!("/stage_instances/{}/retry_stuck", si.id.0);
    let (retry_status, retry_json) = req(app.clone(), "POST", &retry_uri, None).await;
    assert_eq!(retry_status, StatusCode::ACCEPTED);
    assert_eq!(
        retry_json["status"].as_str(),
        Some("running"),
        "retry response must show status=running"
    );

    // /runs must now report is_stuck=false.
    let (status2, runs_json2) = req(app, "GET", "/runs", None).await;
    assert_eq!(status2, StatusCode::OK);
    let runs2 = runs_json2.as_array().expect("runs must be an array");
    let this_run2 = runs2
        .iter()
        .find(|r| r["id"].as_str() == Some(&run.id.0.to_string()))
        .expect("run must appear in /runs after retry");
    assert_eq!(
        this_run2["is_stuck"].as_bool(),
        Some(false),
        "is_stuck must be false after retry"
    );
}

// ── retry_stuck on a non-stuck stage returns 409 ──────────────────────────────

#[tokio::test]
async fn retry_stuck_on_running_stage_returns_409() {
    let db_url = temp_db_url();
    let cfg = Config {
        port: 0,
        bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        db_url: db_url.clone(),
        pwa_dir: PathBuf::from("/tmp"),
        cors_origins: vec![],
        auth_policy: AuthPolicy::Loopback,
        stage_timeout_secs: 3600,
        stuck_sweep_interval_secs: 3600,
    };

    let (app, _coordinator) = boot(cfg, |_stage: &mut StageTypeRegistry, _art: &mut ArtifactTypeRegistry| {})
        .await
        .unwrap();

    let pool = db::init_pool(&db_url).await.unwrap();

    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("stuck-test-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = std::collections::HashMap::new();
                m.insert(
                    "A".into(),
                    StageNodeDef {
                        stage_type: "noop".into(),
                        config: serde_json::json!({}),
                        inputs: vec![],
                        outputs: vec![],
                    },
                );
                m
            },
            edges: vec![],
        },
        created_at: fixed_dt(),
    };
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Running,
        context: serde_json::json!({}),
        version: 1,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    let si = StageInstance {
        id: StageInstanceId(Uuid::new_v4()),
        run_id: run.id,
        stage_key: "A".into(),
        stage_type: "noop".into(),
        status: StageStatus::Running, // not stuck-parked
        config: serde_json::json!({}),
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: None,
        started_at: Some(fixed_dt()),
        ended_at: None,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    queries::insert_stage_instance(&pool, &si).await.unwrap();

    let retry_uri = format!("/stage_instances/{}/retry_stuck", si.id.0);
    let (status, _) = req(app, "POST", &retry_uri, None).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "retry_stuck on a non-stuck-parked stage must return 409"
    );
}
