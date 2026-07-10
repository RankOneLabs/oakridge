pub mod rest;
pub mod sse;

use axum::body::Body;
use axum::http::{header, HeaderName, Method, Request, Response, StatusCode};
use axum::middleware::{self, Next};
use axum::routing::{get, patch, post};
use axum::Router;
use serde_json::json;
use sqlx::SqlitePool;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

pub use crate::config::{AuthPolicy, Config};
use crate::db;
use crate::events::EventBus;
use crate::seed;
use crate::executor::delegated_lbc_run::DelegatedLbcRunStage;
use crate::executor::delegated_session::{kbbl_client::KbblClient, DelegatedSessionStage};
use crate::registry::{register_dev_flow_types, ArtifactTypeRegistry, StageTypeRegistry};
use crate::scheduler::Coordinator;

// ---- control auth middleware -----------------------------------------------

/// Constant-time byte-slice equality to avoid timing oracles on the token.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn unauthorized() -> Response<Body> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("content-type", "application/json")
        .header("www-authenticate", r#"Bearer realm="oakridge-core""#)
        .body(Body::from(json!({"error": "unauthorized"}).to_string()))
        .unwrap()
}

fn forbidden() -> Response<Body> {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header("content-type", "application/json")
        .header("www-authenticate", r#"Bearer realm="oakridge-core""#)
        .body(Body::from(json!({"error": "forbidden"}).to_string()))
        .unwrap()
}

async fn control_auth_middleware(req: Request<Body>, next: Next) -> Response<Body> {
    // The middleware is installed only in token mode. If the token extension is
    // missing, the app is miswired; fail closed instead of passing writes.
    let token: Option<Arc<String>> = req.extensions().get::<Arc<String>>().cloned();
    let token = match token {
        Some(t) => t,
        None => return forbidden(),
    };

    // Safe methods pass through without auth.
    if matches!(
        req.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    ) {
        return next.run(req).await;
    }

    let auth = req.headers().get(header::AUTHORIZATION);
    match auth {
        None => unauthorized(),
        Some(val) => {
            let raw = match val.to_str() {
                Ok(s) => s,
                Err(_) => return unauthorized(),
            };
            if raw.len() < 8 || !raw[..7].eq_ignore_ascii_case("bearer ") {
                return unauthorized();
            }
            let presented = &raw[7..];
            if constant_time_eq(presented.as_bytes(), token.as_bytes()) {
                next.run(req).await
            } else {
                forbidden()
            }
        }
    }
}

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
pub fn register_types(stage: &mut StageTypeRegistry, artifact: &mut ArtifactTypeRegistry) {
    register_dev_flow_types(artifact);
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
    if matches!(cfg.auth_policy, AuthPolicy::InsecureNonLoopback) {
        tracing::warn!(
            "oakridge-core: running without authentication on a non-loopback bind \
             (ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1). Set OAKRIDGE_CONTROL_TOKEN to protect control routes."
        );
    }

    let pool = Arc::new(db::init_pool(&cfg.db_url).await?);
    seed::seed_builtin_workflow_defs(&pool).await?;

    let mut stage_reg = StageTypeRegistry::new();
    let mut artifact_reg = ArtifactTypeRegistry::new();
    register_fn(&mut stage_reg, &mut artifact_reg);

    let bus = EventBus::new();
    let stage_reg = Arc::new(stage_reg);
    let artifact_reg = Arc::new(artifact_reg);
    let coordinator = Arc::new(
        Coordinator::new(
            pool.clone(),
            stage_reg.clone(),
            artifact_reg.clone(),
            bus.clone(),
        )
        .with_liveness_config(
            std::time::Duration::from_secs(cfg.stage_timeout_secs),
            std::time::Duration::from_secs(cfg.stuck_sweep_interval_secs),
        ),
    );
    coordinator.recover().await?;
    let _sweeper = coordinator.spawn_stuck_sweeper();

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

    // In token mode, inject the token as a request extension and apply the
    // control auth middleware. In loopback or insecure mode the middleware
    // is not added, keeping local development frictionless.
    let app = if let AuthPolicy::Token(ref token) = cfg.auth_policy {
        let token_arc = Arc::new(token.clone());
        app.layer(middleware::from_fn(control_auth_middleware))
            .layer(axum::Extension(token_arc))
    } else {
        app
    };

    let app = if cfg.cors_origins.is_empty() {
        app
    } else {
        app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(cfg.cors_origins.clone()))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
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
        .route("/workflow_runs/:id/cancel", post(rest::cancel_workflow_run))
        .route(
            "/workflow_runs/:id/artifacts",
            get(rest::list_run_artifacts),
        )
        .route("/stage_instances/:id", get(rest::get_stage_instance))
        .route(
            "/stage_instances/:id/resume",
            post(rest::resume_stage_instance),
        )
        .route(
            "/stage_instances/:id/retry_stuck",
            post(rest::retry_stuck_stage_instance),
        )
        .route("/artifacts/:id", get(rest::get_artifact))
        .route("/artifact_types", get(rest::get_artifact_types))
        .route(
            "/artifact_details/:id",
            get(rest::get_operator_artifact_detail),
        )
        .route("/parked", get(rest::list_parked))
        .route("/runs", get(rest::list_operator_runs))
        .route("/runs/:id", get(rest::get_operator_run))
        .route("/runs/:id/gates", get(rest::list_operator_run_gates))
        .route("/gates", get(rest::list_operator_gates))
        .route("/gates/:id/resume", post(rest::resume_operator_gate))
        // ── Collab endpoints ──────────────────────────────────────────────────
        .route(
            "/artifacts/:id/threads",
            post(rest::post_thread).get(rest::list_threads),
        )
        .route("/threads/:id/messages", post(rest::post_message))
        .route("/threads/:id/ping", post(rest::post_ping))
        .route("/threads/:id", patch(rest::patch_thread))
        .route("/artifacts/:id/edits", post(rest::post_atom_edit))
        .route(
            "/artifacts/:id/review_items",
            post(rest::post_review_item).get(rest::list_review_items),
        )
        .route("/review_items/:id", patch(rest::patch_review_item_status))
        .merge(sse::sse_routes());

    for st in stage_registry.all() {
        if let Some(r) = st.http_routes() {
            app = app.nest_service(&format!("/executors/{}", st.id()), r);
        }
    }

    app.with_state(state)
}
