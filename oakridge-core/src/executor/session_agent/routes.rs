use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use uuid::Uuid;

use crate::executor::EmitArgs;
use crate::executor::session_agent::LiveStage;
use crate::types::StageInstanceId;

pub type LiveStages = Arc<Mutex<HashMap<StageInstanceId, LiveStage>>>;

#[derive(Clone)]
pub struct EmitState {
    pub live_stages: LiveStages,
}

/// Returns a Router<()> exposing POST /:sid/emit/:output_name.
/// Nested at /executors/session_agent by http/mod.rs.
pub fn emit_routes(live_stages: LiveStages) -> Router {
    Router::new()
        .route("/:sid/emit/:output_name", post(emit_handler))
        .with_state(EmitState { live_stages })
}

async fn emit_handler(
    State(state): State<EmitState>,
    Path((sid_str, output_name)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let sid_uuid = match Uuid::parse_str(&sid_str) {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("invalid stage id: {}", sid_str)})),
            )
                .into_response();
        }
    };
    let sid = StageInstanceId(sid_uuid);

    // Look up the live stage; clone config and ctx to release the lock before
    // any await. UnknownStage → 404.
    let (config, ctx) = {
        let map = state.live_stages.lock().unwrap();
        match map.get(&sid) {
            Some(ls) => (ls.config.clone(), ls.ctx.clone()),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "unknown stage"})),
                )
                    .into_response();
            }
        }
    };

    // Find matching output slot. UnknownOutputSlot → 400.
    let slot = match config.output_slots.iter().find(|s| s.name == output_name) {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("unknown output slot: {}", output_name)})),
            )
                .into_response();
        }
    };

    // Parse body as JSON. Malformed body → 400.
    let artifact_body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("invalid json body: {}", e)})),
            )
                .into_response();
        }
    };

    // ctx.emit runs artifact-type validation; malformed body → 400.
    match ctx
        .emit(EmitArgs {
            output_name,
            artifact_type: slot.artifact_type,
            body: artifact_body,
            label: None,
            parent_artifact_id: None,
        })
        .await
    {
        Ok(artifact) => (
            StatusCode::OK,
            Json(serde_json::json!({"artifact_id": artifact.id.0.to_string()})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
