use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::db;
use oakridge_core::db::queries;
use oakridge_core::executor::{EmitArgs, ResumePayload, StageContext, StageHandle};
use oakridge_core::http::{boot, register_types, Config};
use oakridge_core::registry::stage_type::StageType;
use oakridge_core::registry::ArtifactTypeDef;
use oakridge_core::types::*;

// ── helpers ───────────────────────────────────────────────────────────────────

fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

fn timeout_dur() -> Duration {
    Duration::from_secs(5)
}

async fn wait_run_done(pool: &sqlx::SqlitePool, run_id: WorkflowRunId) {
    for _ in 0..250 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let run = queries::get_workflow_run_by_id(pool, &run_id)
            .await
            .unwrap();
        if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
            return;
        }
    }
    panic!("run did not reach terminal status");
}

// ── scripted stage type (same pattern as scheduler.rs internal tests) ─────────

struct DummyHandle {
    resume_tx: mpsc::Sender<ResumePayload>,
}

#[async_trait]
impl StageHandle for DummyHandle {
    async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()> {
        let _ = self.resume_tx.send(payload).await;
        Ok(())
    }
    async fn cancel(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

struct ScriptedStageType {
    type_id: String,
    ctx_tx: mpsc::Sender<(StageContext, mpsc::Receiver<ResumePayload>)>,
}

#[async_trait]
impl StageType for ScriptedStageType {
    fn id(&self) -> &str {
        &self.type_id
    }

    async fn build_config(
        &self,
        def_config: &Value,
        _inputs: &HashMap<String, oakridge_core::types::Artifact>,
        _output_slots: &[oakridge_core::types::OutputSlot],
        _stage_instance_id: oakridge_core::types::StageInstanceId,
        _run_context: &Value,
    ) -> anyhow::Result<Value> {
        Ok(def_config.clone())
    }

    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let (resume_tx, resume_rx) = mpsc::channel(8);
        let _ = self.ctx_tx.send((ctx, resume_rx)).await;
        Ok(Box::new(DummyHandle { resume_tx }))
    }
}

fn scripted(
    type_id: &str,
) -> (
    Arc<ScriptedStageType>,
    mpsc::Receiver<(StageContext, mpsc::Receiver<ResumePayload>)>,
) {
    let (tx, rx) = mpsc::channel(8);
    (
        Arc::new(ScriptedStageType {
            type_id: type_id.to_string(),
            ctx_tx: tx,
        }),
        rx,
    )
}

fn simple_def(stage_type_id: &str) -> WorkflowDef {
    WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("wf-restart-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut m = HashMap::new();
                m.insert(
                    "A".into(),
                    StageNodeDef {
                        stage_type: stage_type_id.to_string(),
                        config: json!({}),
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
        created_at: fixed_dt(),
    }
}

fn pending_run(def_id: WorkflowDefId) -> WorkflowRun {
    WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def_id,
        project_id: None,
        status: RunStatus::Pending,
        context: json!({}),
        version: 1,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    }
}

fn running_run(def_id: WorkflowDefId) -> WorkflowRun {
    WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def_id,
        project_id: None,
        status: RunStatus::Running,
        context: json!({}),
        version: 1,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    }
}

fn running_stage_instance(
    run_id: WorkflowRunId,
    stage_key: &str,
    stage_type: &str,
) -> StageInstance {
    StageInstance {
        id: StageInstanceId(Uuid::new_v4()),
        run_id,
        stage_key: stage_key.to_string(),
        stage_type: stage_type.to_string(),
        status: StageStatus::Running,
        config: json!({}),
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: None,
        started_at: Some(fixed_dt()),
        ended_at: None,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    }
}

async fn wait_run_failed(pool: &sqlx::SqlitePool, run_id: WorkflowRunId) {
    for _ in 0..250 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let run = queries::get_workflow_run_by_id(pool, &run_id)
            .await
            .unwrap();
        if matches!(run.status, RunStatus::Failed) {
            return;
        }
    }
    panic!("run did not reach Failed status");
}

// ── test: process-restart recovery via boot() ─────────────────────────────────

/// Calls boot() twice against the same SQLite file. The first boot drives a
/// stage to Parked; the second boot's recover() re-activates it and a
/// GateDecision drives the run to Done.
#[tokio::test]
async fn boot_twice_restart_recovery() {
    let db_path = format!("/tmp/oakridge_restart_{}.db", Uuid::new_v4());
    let db_url = format!("sqlite://{db_path}");
    let pwa_dir = PathBuf::from("/tmp");

    // Separate pool for DB setup / assertions (pool B inside boot() is separate).
    let pool = db::init_pool(&db_url).await.unwrap();

    // Insert only the workflow def before the first boot. The run is inserted
    // AFTER boot so that recover() (which picks up pending+running runs) does
    // not see it and create a competing RunTask.
    let def = simple_def("st_park");
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    // ── first "process" ──────────────────────────────────────────────────────
    let (scripted1, mut rx1) = scripted("st_park");
    let (_router1, coord1) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage.register(scripted1);
        },
    )
    .await
    .unwrap();

    // Insert the run and start it only after recover() has already run inside boot().
    let run = pending_run(def.id);
    queries::insert_workflow_run(&pool, &run).await.unwrap();
    coord1.start_run(run.id).await.unwrap();

    let (ctx1, _resume_rx1) = tokio::time::timeout(timeout_dur(), rx1.recv())
        .await
        .unwrap()
        .unwrap();
    let si_id = ctx1.stage_instance_id;

    ctx1.set_status(StageStatus::Running, None).await.unwrap();
    let artifact = ctx1
        .emit(EmitArgs {
            output_name: "out".into(),
            artifact_type: "any".into(),
            body: json!({"v": 1}),
            label: None,
            parent_artifact_id: None,
        })
        .await
        .unwrap();
    let artifact_id = artifact.id;
    ctx1.set_status(StageStatus::Parked, Some("waiting_gate".into()))
        .await
        .unwrap();

    // DB is updated synchronously by set_status; no polling needed.
    // Drop ctx1 so its events_tx is released before the second boot.
    drop(ctx1);
    drop(_resume_rx1);

    // ── second "process" (recover() runs inside boot()) ───────────────────────
    // The first coordinator's RunTask is intentionally NOT stopped before the
    // second boot. The parked RunTask is blocked waiting for a GateDecision
    // that will never arrive on its channel — it does not re-execute the stage,
    // write anything new to the DB, or share channels with the second
    // coordinator. The two coordinators each own independent runs maps and
    // event channels; only the SQLite file is shared. The first RunTask leaks
    // until the tokio test runtime drops all tasks at test exit, which is
    // harmless. Exposing a clean-shutdown path on Coordinator is out of scope
    // for this brief; a true two-process test (separate runtimes) would also
    // work but adds complexity with no additional coverage of the recovery path.
    let (scripted2, mut rx2) = scripted("st_park");
    let (_router2, coord2) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage.register(scripted2);
        },
    )
    .await
    .unwrap();

    // recover() re-executed the parked stage; receive the new context.
    let (ctx2, mut resume_rx2) = tokio::time::timeout(timeout_dur(), rx2.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        ctx2.stage_instance_id, si_id,
        "recover must reuse the existing stage instance id"
    );

    // Deliver gate decision via the second coordinator.
    coord2
        .deliver_decision(
            run.id,
            si_id,
            ResumePayload::GateDecision {
                decision: GateDecision {
                    outcome: GateOutcome::Pass,
                    comment: None,
                    feedback: None,
                },
                against_artifact_id: artifact_id,
            },
        )
        .await
        .unwrap();

    let resume = tokio::time::timeout(timeout_dur(), resume_rx2.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(resume, ResumePayload::GateDecision { .. }));

    ctx2.set_status(StageStatus::Done, None).await.unwrap();

    wait_run_done(&pool, run.id).await;
    let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
        .await
        .unwrap();
    assert_eq!(run_final.status, RunStatus::Done);
}

// ── test: recovery fails stage with unregistered stage_type ──────────────────

/// A Running stage instance whose `stage_type` is not registered in the stage
/// registry must be failed during recover() with a structured terminal_meta
/// containing `kind: "recovery_unregistered_stage_type"`. The run must reach
/// Failed, and no non-terminal stage may remain after recovery.
#[tokio::test]
async fn recovery_unregistered_stage_type_fails_with_structured_meta() {
    let db_path = format!("/tmp/oakridge_recovery_ust_{}.db", Uuid::new_v4());
    let db_url = format!("sqlite://{db_path}");
    let pwa_dir = std::path::PathBuf::from("/tmp");

    let pool = db::init_pool(&db_url).await.unwrap();

    // Def has stage "A" with type "ghost_stage_type" — will NOT be registered.
    let def = simple_def("ghost_stage_type");
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = running_run(def.id);
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    let si = running_stage_instance(run.id, "A", "ghost_stage_type");
    let si_id = si.id;
    queries::insert_stage_instance(&pool, &si).await.unwrap();

    // Boot with an unrelated registered type — "ghost_stage_type" is absent.
    let (scripted_other, _rx) = scripted("other_type");
    let (_router, _coord) = boot(
        Config {
            port: 0,
            bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage.register(scripted_other);
        },
    )
    .await
    .unwrap();

    wait_run_failed(&pool, run.id).await;

    let stage = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();

    assert_eq!(
        stage.status,
        StageStatus::Failed,
        "stage with unregistered stage_type must be Failed after recovery"
    );

    let meta = stage.terminal_meta.expect("terminal_meta must be set");
    assert_eq!(
        meta.get("kind").and_then(|v| v.as_str()),
        Some("recovery_unregistered_stage_type"),
        "terminal_meta.kind must be recovery_unregistered_stage_type, got: {meta}"
    );

    let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
        .await
        .unwrap();
    assert_eq!(run_final.status, RunStatus::Failed, "run must be Failed");

    // No non-terminal stage may remain.
    let all_stages = queries::list_stage_instances_for_run(&pool, &run.id)
        .await
        .unwrap();
    for s in &all_stages {
        assert!(
            matches!(s.status, StageStatus::Done | StageStatus::Failed),
            "non-terminal stage {} found after recovery: {:?}",
            s.stage_key,
            s.status
        );
    }
}

// ── test: recovery fails stage with missing stage key ─────────────────────────

/// A Running stage instance whose `stage_key` does not appear in the workflow
/// graph must be failed during recover() with terminal_meta containing
/// `kind: "recovery_missing_stage_key"`. The run must reach Failed, and no
/// non-terminal stage may remain after recovery.
#[tokio::test]
async fn recovery_missing_stage_key_fails_with_structured_meta() {
    let db_path = format!("/tmp/oakridge_recovery_msk_{}.db", Uuid::new_v4());
    let db_url = format!("sqlite://{db_path}");
    let pwa_dir = std::path::PathBuf::from("/tmp");

    let pool = db::init_pool(&db_url).await.unwrap();

    // Def has stage "A" with type "st_known" AND a required input that cannot
    // be satisfied — this prevents prime_source_stages from activating "A"
    // after GHOST_KEY is failed, so the run reaches Failed via quiescence.
    let def = {
        let mut d = simple_def("st_known");
        let node = d.graph.stages.get_mut("A").unwrap();
        node.inputs.push(InputSlot {
            name: "dep".into(),
            artifact_type: "any".into(),
            optional: false,
        });
        d
    };
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    let run = running_run(def.id);
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    let si = running_stage_instance(run.id, "GHOST_KEY", "st_known");
    let si_id = si.id;
    queries::insert_stage_instance(&pool, &si).await.unwrap();

    let (scripted_known, _rx) = scripted("st_known");
    let (_router, _coord) = boot(
        Config {
            port: 0,
            bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage.register(scripted_known);
        },
    )
    .await
    .unwrap();

    wait_run_failed(&pool, run.id).await;

    let stage = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();

    assert_eq!(
        stage.status,
        StageStatus::Failed,
        "stage with missing stage_key must be Failed after recovery"
    );

    let meta = stage.terminal_meta.expect("terminal_meta must be set");
    assert_eq!(
        meta.get("kind").and_then(|v| v.as_str()),
        Some("recovery_missing_stage_key"),
        "terminal_meta.kind must be recovery_missing_stage_key, got: {meta}"
    );

    let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
        .await
        .unwrap();
    assert_eq!(run_final.status, RunStatus::Failed, "run must be Failed");

    // No non-terminal stage may remain.
    let all_stages = queries::list_stage_instances_for_run(&pool, &run.id)
        .await
        .unwrap();
    for s in &all_stages {
        assert!(
            matches!(s.status, StageStatus::Done | StageStatus::Failed),
            "non-terminal stage {} found after recovery: {:?}",
            s.stage_key,
            s.status
        );
    }
}

// ── test: Failed(cancelled) stages are not rehydrated during recovery ─────────

/// Seeds a stage_instance in Failed status with `terminal_meta.kind = "cancelled"`.
/// After boot(), recover() must treat it as terminal and not re-execute it.
#[tokio::test]
async fn cancelled_stage_is_not_rehydrated_by_recovery() {
    let db_path = format!("/tmp/oakridge_recovery_cancel_{}.db", Uuid::new_v4());
    let db_url = format!("sqlite://{db_path}");
    let pwa_dir = PathBuf::from("/tmp");

    let pool = db::init_pool(&db_url).await.unwrap();

    let def = simple_def("scripted_cancel");
    queries::insert_workflow_def(&pool, &def).await.unwrap();

    // Insert the run in Running state so that recover() (which queries
    // list_active_runs — pending + running) actually picks it up. A Failed run
    // is ignored by recover() and would make the test vacuously true.
    let run = running_run(def.id);
    queries::insert_workflow_run(&pool, &run).await.unwrap();

    // Insert a stage instance that is already Failed with cancellation terminal_meta.
    // recover() must treat it as terminal and not re-execute it.
    let cancelled_stage = StageInstance {
        id: StageInstanceId(Uuid::new_v4()),
        run_id: run.id,
        stage_key: "A".to_string(),
        stage_type: "scripted_cancel".to_string(),
        status: StageStatus::Failed,
        config: json!({}),
        parked_reason: None,
        parked_meta: None,
        terminal_meta: Some(json!({"kind": "cancelled", "reason": "run cancelled by operator"})),
        external_ref: None,
        started_at: Some(fixed_dt()),
        ended_at: Some(fixed_dt()),
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    let si_id = cancelled_stage.id;
    queries::insert_stage_instance(&pool, &cancelled_stage)
        .await
        .unwrap();

    // Boot — recover() runs inside boot(). The scripted_cancel stage type IS
    // registered, so if recover() wrongly re-executes it the channel will fire.
    let (scripted_stage, mut ctx_rx) = scripted("scripted_cancel");
    let (_router, _coord) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
                capabilities: Default::default(),
                anchor_schema: None,
            review_items_extractor: None,
            });
            stage.register(scripted_stage);
        },
    )
    .await
    .unwrap();

    // The run is Running, so recover() picks it up. Stage "A" is already
    // Failed — recover() must treat it as terminal and not re-execute it.
    // The run then quiesces to Failed (all stages terminal, no source stage
    // can be primed). Wait for quiescence before asserting.
    wait_run_failed(&pool, run.id).await;

    // No stage execution should have been triggered.
    assert!(
        ctx_rx.try_recv().is_err(),
        "Failed(cancelled) stage must not be re-executed by recovery"
    );

    // Stage must still be Failed with the original cancellation terminal_meta.
    let stage = queries::get_stage_instance_by_id(&pool, &si_id)
        .await
        .unwrap();
    assert_eq!(stage.status, StageStatus::Failed);
    let meta = stage
        .terminal_meta
        .expect("terminal_meta must be preserved");
    assert_eq!(meta["kind"], json!("cancelled"));
}

// ── test: static serving via boot() ──────────────────────────────────────────

/// Verifies that boot() wires ServeDir correctly: GET / returns index.html and
/// GET /assets/app.js returns the asset file.
#[tokio::test]
async fn static_serving() {
    let pwa_dir = PathBuf::from(format!("/tmp/oakridge_pwa_{}", Uuid::new_v4()));
    std::fs::create_dir_all(pwa_dir.join("assets")).unwrap();
    std::fs::write(pwa_dir.join("index.html"), b"<html>spa-shell</html>").unwrap();
    std::fs::write(pwa_dir.join("assets/app.js"), b"console.log('ok')").unwrap();

    let db_url = format!("sqlite:///tmp/oakridge_static_{}.db", Uuid::new_v4());

    let (router, _coord) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url,
            pwa_dir: pwa_dir.clone(),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 60,
        },
        register_types,
    )
    .await
    .unwrap();

    // GET / → index.html
    let resp = router
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(
        body.windows(9).any(|w| w == b"spa-shell"),
        "GET / must return index.html content"
    );

    // GET /assets/app.js → the asset
    let resp2 = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/assets/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let body2 = resp2.into_body().collect().await.unwrap().to_bytes();
    assert!(
        body2.windows(7).any(|w| w == b"console"),
        "GET /assets/app.js must return the asset content"
    );

    let _ = std::fs::remove_dir_all(&pwa_dir);
}
