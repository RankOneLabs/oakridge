use std::collections::HashMap;
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
        let run = queries::get_workflow_run_by_id(pool, &run_id).await.unwrap();
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
    (Arc::new(ScriptedStageType { type_id: type_id.to_string(), ctx_tx: tx }), rx)
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
        Config { port: 0, db_url: db_url.clone(), pwa_dir: pwa_dir.clone() },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
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

    let (ctx1, _resume_rx1) =
        tokio::time::timeout(timeout_dur(), rx1.recv()).await.unwrap().unwrap();
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
    ctx1.set_status(StageStatus::Parked, Some("waiting_gate".into())).await.unwrap();

    // DB is updated synchronously by set_status; no polling needed.
    // Drop ctx1 so its events_tx is released before the second boot.
    drop(ctx1);
    drop(_resume_rx1);

    // ── second "process" (recover() runs inside boot()) ───────────────────────
    let (scripted2, mut rx2) = scripted("st_park");
    let (_router2, coord2) = boot(
        Config { port: 0, db_url: db_url.clone(), pwa_dir: pwa_dir.clone() },
        move |stage, art| {
            art.register(ArtifactTypeDef {
                id: "any".into(),
                validate: |_| Ok(()),
                component_id: "v".into(),
            });
            stage.register(scripted2);
        },
    )
    .await
    .unwrap();

    // recover() re-executed the parked stage; receive the new context.
    let (ctx2, mut resume_rx2) =
        tokio::time::timeout(timeout_dur(), rx2.recv()).await.unwrap().unwrap();
    assert_eq!(ctx2.stage_instance_id, si_id, "recover must reuse the existing stage instance id");

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
    let run_final = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
    assert_eq!(run_final.status, RunStatus::Done);
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

    let (router, _coord) =
        boot(Config { port: 0, db_url, pwa_dir: pwa_dir.clone() }, register_types)
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
        .oneshot(Request::builder().uri("/assets/app.js").body(Body::empty()).unwrap())
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
