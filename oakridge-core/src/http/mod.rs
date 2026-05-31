pub mod rest;
pub mod sse;

use std::path::PathBuf;
use std::sync::Arc;
use axum::Router;
use axum::routing::{get, post};
use sqlx::SqlitePool;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::db;
use crate::events::EventBus;
use crate::registry::{ArtifactTypeRegistry, StageTypeRegistry};
use crate::scheduler::Coordinator;

#[derive(Clone)]
pub struct AppState {
    pub pool: Arc<SqlitePool>,
    pub stage_registry: Arc<StageTypeRegistry>,
    pub artifact_registry: Arc<ArtifactTypeRegistry>,
    pub coordinator: Arc<Coordinator>,
    pub bus: Arc<EventBus>,
}

pub struct Config {
    pub port: u16,
    pub db_url: String,
    pub pwa_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("OAKRIDGE_CORE_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8790u16);
        let db_url = std::env::var("OAKRIDGE_CORE_DB")
            .map(|p| format!("sqlite://{p}"))
            .unwrap_or_else(|_| "sqlite://oakridge-core.db".to_string());
        let pwa_dir = std::env::var("OAKRIDGE_CORE_PWA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./pwa"));
        Self { port, db_url, pwa_dir }
    }
}

/// Extension point for consumer binaries to register stage and artifact types.
/// The substrate ships ZERO built-in stage/artifact types; consumer binaries register here.
pub fn register_types(
    _stage: &mut StageTypeRegistry,
    _artifact: &mut ArtifactTypeRegistry,
) {}

/// Initialize the substrate: run migrations, build registries via `register_fn`,
/// construct the Coordinator, run crash-recovery, and return the composed Router
/// with static-serving fallback plus the Coordinator Arc.
///
/// Production code passes `register_types` (no-op); tests pass closures that
/// inject dummy stage/artifact types without modifying production paths.
pub async fn boot<F>(cfg: Config, register_fn: F) -> anyhow::Result<(Router, Arc<Coordinator>)>
where
    F: FnOnce(&mut StageTypeRegistry, &mut ArtifactTypeRegistry),
{
    let pool = Arc::new(db::init_pool(&cfg.db_url).await?);

    let mut stage_reg = StageTypeRegistry::new();
    let mut artifact_reg = ArtifactTypeRegistry::new();
    register_fn(&mut stage_reg, &mut artifact_reg);

    let bus = EventBus::new();
    let stage_reg = Arc::new(stage_reg);
    let artifact_reg = Arc::new(artifact_reg);
    let coordinator = Arc::new(Coordinator::new(
        pool.clone(),
        stage_reg.clone(),
        artifact_reg.clone(),
        bus.clone(),
    ));
    coordinator.recover().await?;

    let state = AppState {
        pool,
        stage_registry: stage_reg,
        artifact_registry: artifact_reg,
        coordinator: coordinator.clone(),
        bus,
    };

    let static_fallback = ServeDir::new(&cfg.pwa_dir)
        .fallback(ServeFile::new(cfg.pwa_dir.join("index.html")));

    let app = router(state)
        .fallback_service(static_fallback)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    Ok((app, coordinator))
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/projects", post(rest::create_project).get(rest::list_projects))
        .route("/projects/:id", get(rest::get_project))
        .route("/workflow_defs", post(rest::create_workflow_def).get(rest::list_workflow_defs))
        .route("/workflow_defs/:id", get(rest::get_workflow_def))
        .route("/workflow_runs", post(rest::create_workflow_run).get(rest::list_workflow_runs))
        .route("/workflow_runs/:id", get(rest::get_workflow_run))
        .route("/workflow_runs/:id/artifacts", get(rest::list_run_artifacts))
        .route("/stage_instances/:id", get(rest::get_stage_instance))
        .route("/artifacts/:id", get(rest::get_artifact))
        .route("/verb_results", post(rest::post_verb_results))
        .route("/parked", get(rest::list_parked))
        .merge(sse::sse_routes())
        .with_state(state)
}
