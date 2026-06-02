use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::executor::EmitArgs;
use crate::executor::session_agent::{LiveStage, PermissionDecision};
use crate::types::{StageInstanceId, StageStatus};

pub type LiveStages = Arc<Mutex<HashMap<StageInstanceId, LiveStage>>>;

#[derive(Clone)]
pub struct EmitState {
    pub live_stages: LiveStages,
}

/// Returns a Router<()> exposing POST /:sid/emit/:output_name and POST /:sid/hook/approval.
/// Nested at /executors/session_agent by http/mod.rs.
pub fn emit_routes(live_stages: LiveStages) -> Router {
    Router::new()
        .route("/:sid/emit/:output_name", post(emit_handler))
        .route("/:sid/hook/approval", post(hook_approval_handler))
        .with_state(EmitState { live_stages })
}

async fn emit_handler(
    State(state): State<EmitState>,
    Path((sid_str, output_name)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // A non-UUID sid can never identify a known stage; 404 treats all "stage
    // not present" cases uniformly, matching the UnknownStage contract.
    let sid_uuid = match Uuid::parse_str(&sid_str) {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "unknown stage"})),
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

// ── PreToolUse hook approval ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct HookInput {
    tool_name: String,
    tool_input: serde_json::Value,
    hook_event_name: String,
}

// Cleans up a pending approval entry when dropped without being marked done.
// Fires on handler cancellation (client disconnect / future dropped by hyper).
struct ParkGuard {
    sid: StageInstanceId,
    request_id: String,
    live_stages: LiveStages,
    done: bool,
}

impl Drop for ParkGuard {
    fn drop(&mut self) {
        if !self.done {
            // unwrap_or_else: if the Mutex is poisoned, recover the inner value rather
            // than panicking — a panic inside Drop during unwinding aborts the process.
            let mut map = self.live_stages.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ls) = map.get_mut(&self.sid) {
                ls.pending_approvals.remove(&self.request_id);
            }
        }
    }
}

async fn hook_approval_handler(
    connect_info: Option<ConnectInfo<SocketAddr>>,
    State(state): State<EmitState>,
    Path(sid_str): Path<String>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // (1) Server ready check — ConnectInfo requires into_make_service_with_connect_info.
    let info = match connect_info {
        Some(i) => i,
        None => return (StatusCode::SERVICE_UNAVAILABLE, "server not ready").into_response(),
    };

    // (2) Loopback check BEFORE JSON parse.
    let ip = info.0.ip();
    if !ip.is_loopback() {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    // (3) Parse JSON.
    let hook: HookInput = match serde_json::from_slice(&body) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid json"})),
            )
                .into_response();
        }
    };

    // (4) hook_event_name guard.
    if hook.hook_event_name != "PreToolUse" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("unexpected hook_event_name: {}", hook.hook_event_name)
            })),
        )
            .into_response();
    }

    // (5) Parse sid UUID — non-UUID can never be a known stage.
    let sid_uuid = match Uuid::parse_str(&sid_str) {
        Ok(u) => u,
        Err(_) => {
            return deny_response("oakridge: no live stage for this session id");
        }
    };
    let sid = StageInstanceId(sid_uuid);

    // (6) Resolve live stage with 2s deadline / 50ms poll.
    // Tolerates the race where gate's first PreToolUse POST arrives before
    // execute() has inserted the LiveStage into the map (init/PreToolUse pipe race).
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(2);
    let live = loop {
        let found = {
            let map = state.live_stages.lock().unwrap();
            map.get(&sid).map(|ls| (ls.config.clone(), ls.ctx.clone()))
        };
        if found.is_some() {
            break found;
        }
        if tokio::time::Instant::now() >= deadline {
            break None;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    };

    let (config, ctx) = match live {
        Some(pair) => pair,
        None => return deny_response("oakridge: no live stage for this session id"),
    };

    // (7) Auto-approve fast path FIRST.
    if config.yolo {
        return allow_response("auto-approved (yolo mode)");
    }
    if config.pre_authorized_tools.contains(&hook.tool_name) {
        return allow_response(&format!("auto-approved (always allow {})", hook.tool_name));
    }

    // (8) Park: register oneshot, set status Parked, await decision.
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<PermissionDecision>();

    {
        let mut map = state.live_stages.lock().unwrap();
        match map.get_mut(&sid) {
            Some(ls) => {
                ls.pending_approvals.insert(request_id.clone(), tx);
            }
            None => {
                // Stage disappeared between poll and now.
                return deny_response("oakridge: no live stage for this session id");
            }
        }
    }

    let input_preview = {
        let s = serde_json::to_string(&hook.tool_input).unwrap_or_default();
        if s.len() > 200 { format!("{}…", &s[..200]) } else { s }
    };
    let park_reason = format!("permission: {} on {}", hook.tool_name, input_preview);
    if ctx
        .set_status(StageStatus::Parked, Some(park_reason))
        .await
        .is_err()
    {
        let mut map = state.live_stages.lock().unwrap();
        if let Some(ls) = map.get_mut(&sid) {
            ls.pending_approvals.remove(&request_id);
        }
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "internal error"})),
        )
            .into_response();
    }

    // ParkGuard cleans up pending_approvals if the handler future is dropped
    // (client disconnect detected by hyper cancelling the in-flight handler).
    let mut guard = ParkGuard {
        sid,
        request_id,
        live_stages: state.live_stages.clone(),
        done: false,
    };

    match rx.await {
        Ok(decision) => {
            guard.done = true;
            if ctx.set_status(StageStatus::Running, None).await.is_err() {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "internal error"})),
                )
                    .into_response();
            }
            let (perm_decision, reason) = if decision.approved {
                ("allow", "operator approved")
            } else {
                ("deny", "operator denied")
            };
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": perm_decision,
                        "permissionDecisionReason": reason
                    }
                })),
            )
                .into_response()
        }
        Err(_) => {
            // Sender dropped (stage cancelled) = gate aborted.
            guard.done = true;
            (
                StatusCode::REQUEST_TIMEOUT,
                Json(serde_json::json!({"error": "gate aborted"})),
            )
                .into_response()
        }
    }
}

fn allow_response(reason: &str) -> axum::response::Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": reason
            }
        })),
    )
        .into_response()
}

fn deny_response(reason: &str) -> axum::response::Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason
            }
        })),
    )
        .into_response()
}
