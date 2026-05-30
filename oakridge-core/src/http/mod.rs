pub mod rest;
pub mod sse;

use std::sync::Arc;
use axum::Router;
use axum::routing::{get, post};
use sqlx::SqlitePool;

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
