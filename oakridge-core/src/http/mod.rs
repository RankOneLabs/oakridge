pub mod rest;
pub mod sse;

use axum::http::{header, HeaderName, Method};
use axum::routing::{get, post};
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

pub use crate::config::Config;
use crate::db;
use crate::events::EventBus;
use crate::executor::delegated_lbc_run::DelegatedLbcRunStage;
use crate::executor::delegated_session::{kbbl_client::KbblClient, DelegatedSessionStage};
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

/// Register built-in stage and artifact types.
/// Reads delegated_session config from environment variables:
///   OAKRIDGE_PROMPTS_DIR – prompt template root (default: "./prompts")
///   KBBL_API_BASE_URL    – kbbl HTTP base URL (default: "http://127.0.0.1:8788/")
pub fn register_types(stage: &mut StageTypeRegistry, _artifact: &mut ArtifactTypeRegistry) {
    let prompts_dir = std::env::var("OAKRIDGE_PROMPTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("./prompts"));

    let delegated_prompts_dir = prompts_dir.clone();

    let kbbl_base_url =
        std::env::var("KBBL_API_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8788/".to_string());
    let kbbl_client = KbblClient::new(kbbl_base_url.clone())
        .unwrap_or_else(|err| panic!("invalid KBBL_API_BASE_URL {kbbl_base_url:?}: {err}"));
    let delegated = Arc::new(DelegatedSessionStage::new(
        delegated_prompts_dir,
        kbbl_client,
    ));
    let delegated_lbc_run = Arc::new(DelegatedLbcRunStage::new());

    stage.register(delegated);
    stage.register(delegated_lbc_run);
}

/// Initialize the substrate: run migrations, build registries via `register_fn`,
/// construct the Coordinator, run crash-recovery, and return the composed Router
/// with static-serving fallback plus the Coordinator Arc.
///
/// Production code passes `register_types` (registers the built-in
/// `delegated_session` and `delegated_lbc_run` stage types); tests pass closures that inject dummy
/// stage/artifact types without modifying production paths.
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

    let static_fallback =
        ServeDir::new(&cfg.pwa_dir).fallback(ServeFile::new(cfg.pwa_dir.join("index.html")));

    let app = router(state).fallback_service(static_fallback);
    let app = if cfg.cors_origins.is_empty() {
        app
    } else {
        app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(cfg.cors_origins.clone()))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([
                    header::CONTENT_TYPE,
                    HeaderName::from_static("last-event-id"),
                ]),
        )
    };
    let app = app.layer(TraceLayer::new_for_http());

    Ok((app, coordinator))
}

pub fn router(state: AppState) -> Router {
    let stage_registry = state.stage_registry.clone();

    let mut app = Router::new()
        .route(
            "/projects",
            post(rest::create_project).get(rest::list_projects),
        )
        .route("/projects/:id", get(rest::get_project))
        .route(
            "/workflow_defs",
            post(rest::create_workflow_def).get(rest::list_workflow_defs),
        )
        .route("/workflow_defs/:id", get(rest::get_workflow_def))
        .route(
            "/workflow_runs",
            post(rest::create_workflow_run).get(rest::list_workflow_runs),
        )
        .route("/workflow_runs/:id", get(rest::get_workflow_run))
        .route(
            "/workflow_runs/:id/artifacts",
            get(rest::list_run_artifacts),
        )
        .route("/stage_instances/:id", get(rest::get_stage_instance))
        .route(
            "/stage_instances/:id/resume",
            post(rest::resume_stage_instance),
        )
        .route("/artifacts/:id", get(rest::get_artifact))
        .route("/parked", get(rest::list_parked))
        .merge(sse::sse_routes());

    for st in stage_registry.all() {
        if let Some(r) = st.http_routes() {
            app = app.nest_service(&format!("/executors/{}", st.id()), r);
        }
    }

    app.with_state(state)
}
