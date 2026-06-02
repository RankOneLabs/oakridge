#![cfg(unix)]

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use oakridge_core::db::{self, queries};
use oakridge_core::executor::ResumePayload;
use oakridge_core::executor::session_agent::{LiveStage, SessionAgent, SpawnConfig};
use oakridge_core::http::{boot, Config};
use oakridge_core::registry::ArtifactTypeDef;
use oakridge_core::types::*;

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
            panic!(
                "stage failed with reason: {:?}",
                si.parked_reason
            );
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

// ── E2E: full lifecycle ────────────────────────────────────────────────────────

/// Full lifecycle: Pending → Running → Parked (gate) → Running (resume) → Done.
///
/// The mock-cc binary:
///   1. prints a system+init NDJSON line (so classify_cc_event records the session id)
///   2. POSTs to /executors/session_agent/:sid/hook/approval, blocking until the test
///      sends a resume (simulating a PreToolUse gate)
///   3. POSTs an artifact to /executors/session_agent/:sid/emit/out
///   4. exits 0 → stage transitions to Done
#[tokio::test(flavor = "multi_thread")]
async fn session_agent_e2e_lifecycle() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let prompts_dir = tmp.path().join("prompts");
    let workdir = tmp.path().join("work");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&prompts_dir).unwrap();
    std::fs::create_dir_all(&workdir).unwrap();

    // No-slot prompt template
    std::fs::write(prompts_dir.join("e2e_prompt.md"), "e2e test prompt").unwrap();

    // Bind listener before boot() so we know the port for SpawnConfig
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // Write the mock-cc shell script
    let mock_cc = tmp.path().join("mock-cc.sh");
    // Close stdin (fd 0) so the bash script does not block on the piped prompt.
    // Print system+init on stdout, call hook/approval (blocks until resume), emit artifact.
    let script = format!(
        r#"#!/bin/bash
set -e
exec 0</dev/null
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"mock-cc-e2e","model":"mock-model"}}'
curl -s -f -X POST \
  "http://127.0.0.1:{port}/executors/session_agent/${{OAKRIDGE_STAGE_INSTANCE}}/hook/approval" \
  -H "Content-Type: application/json" \
  -d '{{"tool_name":"Bash","tool_input":{{"command":"echo hi"}},"hook_event_name":"PreToolUse"}}' \
  -o /dev/null
curl -s -f -X POST \
  "http://127.0.0.1:{port}/executors/session_agent/${{OAKRIDGE_STAGE_INSTANCE}}/emit/out" \
  -H "Content-Type: application/json" \
  -d '{{"result":"e2e-complete"}}'
exit 0
"#,
        port = port
    );
    std::fs::write(&mock_cc, &script).unwrap();
    std::fs::set_permissions(&mock_cc, std::fs::Permissions::from_mode(0o755)).unwrap();

    let live_stages: Arc<Mutex<HashMap<StageInstanceId, LiveStage>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let db_url = format!("sqlite://{}", tmp.path().join("e2e.db").to_str().unwrap());
    let db_url2 = db_url.clone();
    let mock_cc_str = mock_cc.to_string_lossy().to_string();
    let data_dir_clone = data_dir.clone();
    let prompts_dir_clone = prompts_dir.clone();
    let workdir_str = workdir.to_string_lossy().to_string();

    let (router, coord) = boot(
        Config {
            port,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
            });
            stage.register(Arc::new(SessionAgent {
                prompts_dir: prompts_dir_clone,
                spawn_config: SpawnConfig {
                    claude_bin: mock_cc_str,
                    port,
                    oakridge_data: data_dir_clone,
                    // gate.sh path is unused: mock-cc calls hook/approval directly
                    gate_path: "/unused/gate.sh".into(),
                },
                live_stages,
            }));
        },
    )
    .await
    .unwrap();

    // Serve with ConnectInfo so hook_approval_handler can verify loopback IP
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Assertion pool (separate from boot's internal pool)
    let pool = db::init_pool(&db_url2).await.unwrap();

    // Insert workflow def with a single session_agent stage
    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("e2e-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = HashMap::new();
                m.insert(
                    "agent".into(),
                    StageNodeDef {
                        stage_type: "session_agent".into(),
                        config: json!({
                            "backend": "claude_code",
                            "prompt_template_path": "e2e_prompt.md",
                            "slot_bindings": {},
                            "workdir": {"from": "literal", "value": workdir_str},
                            "session_name": "e2e-session",
                            "model": null,
                            "pre_authorized_tools": [],
                            "yolo": false
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

    // Wait for the stage instance to be created (may still be Pending or already Running)
    let si_id = poll_for_any_stage(&pool, run.id, timeout).await;

    // Wait for Parked: mock-cc has called hook/approval and the handler parked the stage
    poll_until_status(&pool, si_id, StageStatus::Parked, timeout).await;

    // Read the approval request_id from the persisted stage row — the same surface
    // GET /stage_instances/:id serves a PWA. (Previously this peeked the executor's
    // in-memory pending_approvals map, which no client can reach.)
    let request_id: String = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
            if let Some(req_id) = si
                .parked_meta
                .as_ref()
                .and_then(|m| m.get("request_id"))
                .and_then(|v| v.as_str())
            {
                break req_id.to_string();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "parked_meta.request_id did not appear within timeout"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };

    // Simulate "PWA POSTs /stage_instances/:id/resume" with Executor payload
    coord
        .resume_parked_stage_if_active(
            run.id,
            si_id,
            ResumePayload::Executor {
                payload: json!({
                    "request_id": request_id,
                    "decision": {"approved": true}
                }),
            },
        )
        .await
        .unwrap();

    // Wait for stage to reach Done: mock-cc emits artifact then exits 0
    poll_until_done(&pool, si_id, timeout).await;

    // Assert the artifact was persisted by the emit endpoint
    let artifacts = queries::list_artifacts_for_run(&pool, &run.id, None)
        .await
        .unwrap();
    assert!(
        !artifacts.is_empty(),
        "emit endpoint must have persisted at least one artifact"
    );
    let artifact = artifacts.iter().find(|a| a.output_name.as_deref() == Some("out"));
    assert!(artifact.is_some(), "artifact on slot 'out' must be persisted");
    let artifact = artifact.unwrap();
    assert_eq!(
        artifact.body.get("result").and_then(|v| v.as_str()),
        Some("e2e-complete"),
        "artifact body must match mock-cc emit payload"
    );

    // Assert the run reached Done
    wait_run_done(&pool, run.id).await;
    let final_run = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
    assert_eq!(final_run.status, RunStatus::Done);
}

// ── Manual smoke (real CC) ─────────────────────────────────────────────────────

/// Requires real CC + auth. Run with:
///   CLAUDE_BIN=<path> OAKRIDGE_DATA=<dir> OAKRIDGE_GATE_PATH=<path> \
///     cargo test real_cc_smoke -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn real_cc_smoke() {
    eprintln!(
        "real_cc_smoke: set CLAUDE_BIN, OAKRIDGE_DATA, OAKRIDGE_GATE_PATH and run with --ignored"
    );
}
