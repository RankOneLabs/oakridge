use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use uuid::Uuid;

use crate::db::queries;
use crate::executor::EmitArgs;
use crate::types::{StageInstanceId, StageStatus};

use super::{
    revision_count_from_meta, DelegatedGate, DelegatedGateState, KbblClient, LiveSessions,
};

#[derive(Clone)]
struct RouteState {
    _kbbl_client: Arc<KbblClient>,
    live_sessions: LiveSessions,
}

pub(crate) fn emit_routes(kbbl_client: Arc<KbblClient>, live_sessions: LiveSessions) -> Router {
    Router::new()
        .route(
            "/:stage_instance_id/units/:unit_id/emit/:output_name",
            post(emit_handler),
        )
        .with_state(RouteState {
            _kbbl_client: kbbl_client,
            live_sessions,
        })
}

async fn emit_handler(
    State(state): State<RouteState>,
    Path((stage_instance_id_str, unit_id, output_name)): Path<(String, String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    let stage_instance_id = match Uuid::parse_str(&stage_instance_id_str) {
        Ok(uuid) => StageInstanceId(uuid),
        Err(_) => return not_found(),
    };

    let live_session = {
        let live_sessions = state.live_sessions.lock().unwrap();
        match live_sessions.get(&(stage_instance_id, unit_id.clone())) {
            Some(session) => session.clone(),
            None => return not_found(),
        }
    };

    let summary = live_session.ctx.stage_instance_summary();
    let current_gate = summary
        .parked_meta
        .as_ref()
        .and_then(|meta| serde_json::from_value::<DelegatedGateState>(meta.clone()).ok());
    if matches!(
        current_gate.as_ref().map(|gate_state| &gate_state.gate),
        Some(DelegatedGate::MergeConfirmation)
    ) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "stage is awaiting merge confirmation"
            })),
        )
            .into_response();
    }

    let slot = match live_session
        .config
        .output_slots
        .iter()
        .find(|slot| slot.name == output_name)
    {
        Some(slot) => slot.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("unknown output slot: {}", output_name)
                })),
            )
                .into_response();
        }
    };

    let body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("invalid json body: {}", err)
                })),
            )
                .into_response();
        }
    };

    let artifact = match live_session
        .ctx
        .emit(EmitArgs {
            output_name: output_name.clone(),
            artifact_type: slot.artifact_type,
            body,
            label: None,
            parent_artifact_id: None,
        })
        .await
    {
        Ok(artifact) => artifact,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": err.to_string()
                })),
            )
                .into_response();
        }
    };

    // Write artifact_id to the unit row (best-effort; unit CRUD errors don't fail the emit).
    if let Err(err) = queries::set_session_unit_artifact_id(
        live_session.ctx.pool(),
        &stage_instance_id,
        &unit_id,
        artifact.id,
    )
    .await
    {
        tracing::warn!(
            stage_instance_id = %stage_instance_id.0,
            unit_id = %unit_id,
            error = %err,
            "set_session_unit_artifact_id failed; unit row may lack artifact_id"
        );
    }

    // Determine whether this output slot is the designated gate output.
    // If gate_output is configured, only that slot parks the unit; other slots
    // store artifacts without changing stage status (auxiliary outputs).
    let designated_gate_output = live_session
        .config
        .gate_output
        .as_deref()
        .or_else(|| {
            live_session
                .config
                .output_slots
                .first()
                .map(|s| s.name.as_str())
        })
        .unwrap_or("")
        .to_owned();

    let is_gate_output = output_name == designated_gate_output;

    if !is_gate_output {
        // Auxiliary output: artifact stored, no gate transition.
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "artifact_id": artifact.id.0.to_string() })),
        )
            .into_response();
    }

    // For merge_confirmation gate slots, look up the pr_summary artifact
    // emitted earlier by this stage instance to surface the PR link.
    let pr_url = queries::get_latest_artifact_by_stage_and_output(
        live_session.ctx.pool(),
        &stage_instance_id,
        "pr_summary",
    )
    .await
    .ok()
    .flatten()
    .and_then(|a| a.body.get("pr_url")?.as_str().map(|s| s.to_owned()));

    let revision_count = revision_count_from_meta(summary.parked_meta.as_ref());
    let gate_state = DelegatedGateState::artifact_approval(
        live_session.sid.clone(),
        artifact.id,
        revision_count,
        live_session.worktree_path.clone(),
        live_session.worktree_branch.clone(),
        live_session.worktree_base_ref.clone(),
        pr_url,
    );

    let gate_state_value = match serde_json::to_value(&gate_state) {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };

    // Write gate_state to the unit row (best-effort).
    if let Err(err) = queries::set_session_unit_gate_state(
        live_session.ctx.pool(),
        &stage_instance_id,
        &unit_id,
        Some(gate_state_value.clone()),
    )
    .await
    {
        tracing::warn!(
            stage_instance_id = %stage_instance_id.0,
            unit_id = %unit_id,
            error = %err,
            "set_session_unit_gate_state failed; unit row may lack gate_state"
        );
    }

    if live_session
        .ctx
        .set_parked_meta(Some(gate_state_value))
        .await
        .is_err()
    {
        return internal_error();
    }

    if live_session
        .ctx
        .set_status(StageStatus::Parked, Some("waiting_gate".into()))
        .await
        .is_err()
    {
        let _ = live_session.ctx.set_parked_meta(None).await;
        return internal_error();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "artifact_id": artifact.id.0.to_string() })),
    )
        .into_response()
}

fn not_found() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "unknown stage"})),
    )
        .into_response()
}

fn internal_error() -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": "internal error"})),
    )
        .into_response()
}
