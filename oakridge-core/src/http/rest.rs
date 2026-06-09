use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

use crate::db::queries;
use crate::executor::{EmitArgs, ResumePayload};
use crate::scheduler::DecisionError;
use crate::types::{
    Artifact, ArtifactId, OutputSlot, Project, ProjectId, RunStatus, StageInstance,
    StageInstanceId, StageStatus, WorkflowDef, WorkflowDefId, WorkflowGraph, WorkflowRun,
    WorkflowRunId,
};

use super::AppState;

// ── Error type ────────────────────────────────────────────────────────────────

pub enum AppError {
    Domain(crate::Error),
    Conflict(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::Domain(e) => {
                let (status, msg) = map_domain_error(&e);
                (status, Json(json!({"error": msg}))).into_response()
            }
            AppError::Conflict(msg) => {
                (StatusCode::CONFLICT, Json(json!({"error": msg}))).into_response()
            }
            AppError::Internal(msg) => {
                tracing::error!(error = %msg, "unhandled internal error mapped to 500");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "internal server error"})),
                )
                    .into_response()
            }
        }
    }
}

fn map_domain_error(e: &crate::Error) -> (StatusCode, String) {
    match e {
        crate::Error::NotFound { .. } => (StatusCode::NOT_FOUND, e.to_string()),
        crate::Error::RegistryMiss(_) => (StatusCode::NOT_FOUND, e.to_string()),
        crate::Error::Validation(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        crate::Error::Db(sqlx::Error::Database(dbe))
            if dbe.kind() == sqlx::error::ErrorKind::UniqueViolation =>
        {
            (StatusCode::CONFLICT, e.to_string())
        }
        _ => {
            tracing::error!(error = %e, "internal domain error mapped to 500");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal server error".to_string(),
            )
        }
    }
}

impl From<crate::Error> for AppError {
    fn from(e: crate::Error) -> Self {
        AppError::Domain(e)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        match e.downcast::<crate::Error>() {
            Ok(ce) => AppError::Domain(ce),
            Err(e) => AppError::Internal(e.to_string()),
        }
    }
}

// ── Request DTOs ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateProject {
    pub name: String,
    pub repo_dir: String,
}

#[derive(Deserialize)]
pub struct CreateWorkflowDef {
    pub name: String,
    pub version: i32,
    pub graph: WorkflowGraph,
}

#[derive(Deserialize)]
pub struct CreateWorkflowRun {
    pub workflow_def_id: WorkflowDefId,
    pub project_id: Option<ProjectId>,
    pub context: Option<Value>,
}

// ── Response DTOs ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RunDetail {
    #[serde(flatten)]
    pub run: WorkflowRun,
    pub stage_instances: Vec<StageInstance>,
}

// ── Query param structs ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ListRunsQuery {
    pub status: Option<RunStatus>,
    pub def_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct ListArtifactsQuery {
    pub artifact_type: Option<String>,
}

// ── Project handlers ──────────────────────────────────────────────────────────

pub async fn create_project(
    State(state): State<AppState>,
    Json(body): Json<CreateProject>,
) -> Result<(StatusCode, Json<Project>), AppError> {
    let project = Project {
        id: ProjectId(Uuid::new_v4()),
        name: body.name,
        repo_dir: PathBuf::from(body.repo_dir),
        created_at: Utc::now(),
    };
    queries::insert_project(&state.pool, &project).await?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<Project>>, AppError> {
    let projects = queries::list_projects(&state.pool).await?;
    Ok(Json(projects))
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Project>, AppError> {
    let project = queries::get_project_by_id(&state.pool, &ProjectId(id)).await?;
    Ok(Json(project))
}

// ── WorkflowDef handlers ──────────────────────────────────────────────────────

pub async fn create_workflow_def(
    State(state): State<AppState>,
    Json(body): Json<CreateWorkflowDef>,
) -> Result<(StatusCode, Json<WorkflowDef>), AppError> {
    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: body.name,
        version: body.version,
        graph: body.graph,
        created_at: Utc::now(),
    };
    queries::insert_workflow_def(&state.pool, &def).await?;
    Ok((StatusCode::CREATED, Json(def)))
}

pub async fn list_workflow_defs(
    State(state): State<AppState>,
) -> Result<Json<Vec<WorkflowDef>>, AppError> {
    let defs = queries::list_workflow_defs(&state.pool).await?;
    Ok(Json(defs))
}

pub async fn get_workflow_def(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkflowDef>, AppError> {
    let def = queries::get_workflow_def_by_id(&state.pool, &WorkflowDefId(id)).await?;
    Ok(Json(def))
}

// ── WorkflowRun handlers ──────────────────────────────────────────────────────

pub async fn create_workflow_run(
    State(state): State<AppState>,
    Json(body): Json<CreateWorkflowRun>,
) -> Result<(StatusCode, Json<WorkflowRun>), AppError> {
    let caller_context = body.context.unwrap_or_else(|| Value::Object(Default::default()));

    let merged_context = if let Some(project_id) = body.project_id {
        let project = queries::get_project_by_id(&state.pool, &project_id).await?;
        // repo_dir came in as a String via CreateProject and round-trips through PathBuf,
        // so to_str() is always Some here.
        let repo_dir_str = project.repo_dir.to_string_lossy().into_owned();

        // Build injected base: {project:{id,name,repo_dir}, workdir:repo_dir}
        let mut merged = serde_json::Map::new();
        merged.insert(
            "project".into(),
            json!({
                "id": project.id,
                "name": project.name,
                "repo_dir": repo_dir_str,
            }),
        );
        merged.insert("workdir".into(), Value::String(repo_dir_str));

        // Shallow-merge caller context over injected so caller keys win on conflict.
        // Reject a non-object context instead of silently dropping it.
        let Value::Object(caller_obj) = caller_context else {
            return Err(crate::Error::Validation(
                "context must be a JSON object when project_id is set".into(),
            )
            .into());
        };
        for (k, v) in caller_obj {
            merged.insert(k, v);
        }

        Value::Object(merged)
    } else {
        caller_context
    };

    let now = Utc::now();
    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: body.workflow_def_id,
        project_id: body.project_id,
        status: RunStatus::Pending,
        context: merged_context,
        version: 1,
        created_at: now,
        updated_at: now,
    };

    queries::insert_workflow_run(&state.pool, &run).await?;
    if let Err(start_err) = state.coordinator.start_run(run.id).await {
        match queries::mark_workflow_run_failed_if_pending(&state.pool, &run.id).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(run_id = %run.id.0, "skipped workflow_run rollback because status was no longer pending");
            }
            Err(cleanup_err) => {
                tracing::error!(run_id = %run.id.0, error = %cleanup_err, "failed to rollback workflow_run after start failure");
            }
        }
        return Err(start_err.into());
    }

    Ok((StatusCode::CREATED, Json(run)))
}

pub async fn list_workflow_runs(
    State(state): State<AppState>,
    Query(params): Query<ListRunsQuery>,
) -> Result<Json<Vec<WorkflowRun>>, AppError> {
    let def_id = params.def_id.map(WorkflowDefId);
    let project_id = params.project_id.map(ProjectId);
    let runs = queries::list_workflow_runs(
        &state.pool,
        params.status,
        def_id.as_ref(),
        project_id.as_ref(),
    )
    .await?;
    Ok(Json(runs))
}

pub async fn get_workflow_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RunDetail>, AppError> {
    let run_id = WorkflowRunId(id);
    let run = queries::get_workflow_run_by_id(&state.pool, &run_id).await?;
    let stage_instances = queries::list_stage_instances_for_run(&state.pool, &run_id).await?;
    Ok(Json(RunDetail { run, stage_instances }))
}

pub async fn list_run_artifacts(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(params): Query<ListArtifactsQuery>,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let run_id = WorkflowRunId(id);
    let artifacts = queries::list_artifacts_for_run(
        &state.pool,
        &run_id,
        params.artifact_type.as_deref(),
    )
    .await?;
    Ok(Json(artifacts))
}

// ── StageInstance handlers ────────────────────────────────────────────────────

pub async fn get_stage_instance(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<StageInstance>, AppError> {
    let si = queries::get_stage_instance_by_id(&state.pool, &StageInstanceId(id)).await?;
    Ok(Json(si))
}

// ── Artifact handlers ─────────────────────────────────────────────────────────

/// Returns the artifact's revision chain root-first (oldest ancestor → requested artifact).
/// `get_artifact_chain` walks parent pointers leaf-first; we reverse for root-first order.
pub async fn get_artifact(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let mut chain = queries::get_artifact_chain(&state.pool, &ArtifactId(id)).await?;
    chain.reverse();
    Ok(Json(chain))
}

// ── Stage instance resume handler ─────────────────────────────────────────────

pub async fn resume_stage_instance(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<ResumePayload>,
) -> Result<(StatusCode, Json<StageInstance>), AppError> {
    let si_id = StageInstanceId(id);
    let si = queries::get_stage_instance_by_id(&state.pool, &si_id).await?;

    state
        .coordinator
        .resume_parked_stage_if_active(si.run_id, si_id, payload)
        .await
        .map_err(|e| match e {
            DecisionError::Conflict(msg) => AppError::Conflict(msg),
            DecisionError::Internal(err) => AppError::Internal(err.to_string()),
        })?;

    let updated = queries::get_stage_instance_by_id(&state.pool, &si_id).await?;
    Ok((StatusCode::ACCEPTED, Json(updated)))
}

// ── Delegated-session inbound callbacks ───────────────────────────────────────

#[derive(Deserialize)]
pub struct EmitArtifactBody {
    pub output_name: String,
    pub body: Value,
}

/// Receive an artifact emitted by a kbbl-delegated session (C.2a).
///
/// kbbl calls this when the running agent produces an output. The handler
/// resolves the artifact type from the stage's output slots, validates, persists
/// via ctx.emit, and routes the event to downstream stages.
pub async fn post_stage_instance_artifacts(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<EmitArtifactBody>,
) -> impl IntoResponse {
    let sid = StageInstanceId(id);
    let ctx = state.live_delegated.lock().unwrap().get(&sid).cloned();
    let ctx = match ctx {
        Some(c) => c,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "no live delegated stage for this id"})),
            )
                .into_response();
        }
    };

    let output_slots: Vec<OutputSlot> =
        match serde_json::from_value(ctx.config["output_slots"].clone()) {
            Ok(slots) => slots,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    stage_instance_id = %id,
                    "output_slots config is corrupt"
                );
                return AppError::Internal("output_slots config is corrupt".into())
                    .into_response();
            }
        };

    let slot = match output_slots.iter().find(|s| s.name == body.output_name) {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("unknown output slot: {}", body.output_name)})),
            )
                .into_response();
        }
    };

    match ctx
        .emit(EmitArgs {
            output_name: body.output_name,
            artifact_type: slot.artifact_type,
            body: body.body,
            label: None,
            parent_artifact_id: None,
        })
        .await
    {
        Ok(artifact) => (
            StatusCode::OK,
            Json(json!({"artifact_id": artifact.id.0.to_string()})),
        )
            .into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TerminalStatusBody {
    pub status: String,
    /// kbbl session ID (informational; echoed back by kbbl, not used for routing).
    pub sid: Option<String>,
    /// Stage instance ID claimed by kbbl; validated against the :id path param.
    pub stage_instance_id: Option<String>,
}

/// Receive the terminal status of a kbbl-delegated session (C.2b).
///
/// kbbl calls this when the session ends. The handler transitions the stage to
/// Done or Failed and removes it from the live map so subsequent callbacks 404.
pub async fn post_stage_instance_status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<TerminalStatusBody>,
) -> impl IntoResponse {
    let sid = StageInstanceId(id);

    if let Some(ref claimed) = body.stage_instance_id {
        if claimed != &id.to_string() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "stage_instance_id mismatch"})),
            )
                .into_response();
        }
    }

    let stage_status = match body.status.as_str() {
        "done" => StageStatus::Done,
        "failed" => StageStatus::Failed,
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid status: {}", other)})),
            )
                .into_response();
        }
    };

    let ctx = state.live_delegated.lock().unwrap().get(&sid).cloned();
    let ctx = match ctx {
        Some(c) => c,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "no live delegated stage for this id"})),
            )
                .into_response();
        }
    };

    match ctx.set_status(stage_status, None).await {
        Ok(_) => {
            // Remove only after the transition persisted successfully so a
            // transient DB error doesn't drop the context and strand the stage.
            state.live_delegated.lock().unwrap().remove(&sid);
            tracing::debug!(
                stage_instance_id = %id,
                kbbl_sid = ?body.sid,
                status = %body.status,
                "delegated stage reached terminal status via kbbl callback"
            );
            (StatusCode::OK, Json(json!({}))).into_response()
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                stage_instance_id = %id,
                kbbl_sid = ?body.sid,
                "failed to set terminal status from kbbl callback"
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal error"})),
            )
                .into_response()
        }
    }
}

// ── Delegated-session approval notification (C.3) ─────────────────────────────

#[derive(Deserialize)]
pub struct ApprovalNotificationBody {
    pub request_id: String,
    pub tool_label: String,
    /// kbbl session ID (informational; retained in parked_meta for operator display).
    pub sid: Option<String>,
}

/// Receive an approval-needed notification from kbbl (C.3).
///
/// kbbl calls this when a delegated session hits a tool that requires approval.
/// The handler parks the stage so it appears in GET /parked, with `parked_meta`
/// carrying `request_id` and `tool_label` for the operator to include in the
/// `ResumePayload::Executor` call that resolves it.
pub async fn post_stage_approvals(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ApprovalNotificationBody>,
) -> impl IntoResponse {
    let stage_sid = StageInstanceId(id);
    let ctx = state.live_delegated.lock().unwrap().get(&stage_sid).cloned();
    let ctx = match ctx {
        Some(c) => c,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "no live delegated stage for this id"})),
            )
                .into_response();
        }
    };

    let parked_meta = json!({
        "request_id": body.request_id,
        "tool_label": body.tool_label,
        "sid": body.sid,
    });
    if let Err(e) = ctx.set_parked_meta(Some(parked_meta)).await {
        return AppError::from(e).into_response();
    }
    match ctx
        .set_status(StageStatus::Parked, Some("awaiting executor approval".into()))
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({}))).into_response(),
        Err(e) => {
            // Best-effort: clear the stale parked_meta we just wrote so the
            // stage row isn't left with metadata that implies it's parked.
            let _ = ctx.set_parked_meta(None).await;
            AppError::from(e).into_response()
        }
    }
}

// ── Parked handler ────────────────────────────────────────────────────────────

pub async fn list_parked(
    State(state): State<AppState>,
) -> Result<Json<Vec<StageInstance>>, AppError> {
    let parked = queries::list_parked_stage_instances(&state.pool).await?;
    Ok(Json(parked))
}

// ── Integration tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::events::EventBus;
    use crate::executor::{EmitArgs, ResumePayload, StageContext, StageHandle};
    use crate::registry::{ArtifactTypeDef, ArtifactTypeRegistry, StageTypeRegistry};
    use crate::scheduler::Coordinator;
    use crate::types::{StageNodeDef, StageStatus};
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tower::ServiceExt;
    use uuid::Uuid;

    // ── Dummy stage: marks done immediately ───────────────────────────────────

    struct ImmediateHandle;

    #[async_trait]
    impl StageHandle for ImmediateHandle {
        async fn resume(&self, _: ResumePayload) -> anyhow::Result<()> {
            Ok(())
        }
        async fn cancel(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct ImmediateStage;

    #[async_trait]
    impl crate::registry::stage_type::StageType for ImmediateStage {
        fn id(&self) -> &str {
            "immediate"
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _: &HashMap<String, crate::types::Artifact>,
            _: &[crate::types::OutputSlot],
            _: crate::types::StageInstanceId,
            _: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            ctx.set_status(StageStatus::Running, None).await?;
            ctx.set_status(StageStatus::Done, None).await?;
            Ok(Box::new(ImmediateHandle))
        }
    }

    // ── Scripted stage: parks and waits for resume ────────────────────────────

    struct ScriptedHandle {
        resume_tx: mpsc::Sender<ResumePayload>,
    }

    #[async_trait]
    impl StageHandle for ScriptedHandle {
        async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()> {
            let _ = self.resume_tx.send(payload).await;
            Ok(())
        }
        async fn cancel(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct ScriptedStage {
        type_id: String,
        ctx_tx: mpsc::Sender<(StageContext, mpsc::Receiver<ResumePayload>)>,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for ScriptedStage {
        fn id(&self) -> &str {
            &self.type_id
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _: &HashMap<String, crate::types::Artifact>,
            _: &[crate::types::OutputSlot],
            _: crate::types::StageInstanceId,
            _: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            let (resume_tx, resume_rx) = mpsc::channel(8);
            let _ = self.ctx_tx.send((ctx, resume_rx)).await;
            Ok(Box::new(ScriptedHandle { resume_tx }))
        }
    }

    fn scripted(
        type_id: &str,
    ) -> (
        Arc<ScriptedStage>,
        mpsc::Receiver<(StageContext, mpsc::Receiver<ResumePayload>)>,
    ) {
        let (tx, rx) = mpsc::channel(8);
        (
            Arc::new(ScriptedStage {
                type_id: type_id.to_string(),
                ctx_tx: tx,
            }),
            rx,
        )
    }

    // ── Test state builder ────────────────────────────────────────────────────

    async fn make_state_at(
        path: &str,
        stage_types: Vec<Arc<dyn crate::registry::stage_type::StageType>>,
    ) -> AppState {
        let pool = Arc::new(db::init_pool(&format!("sqlite:{}", path)).await.unwrap());

        let mut stage_reg = StageTypeRegistry::new();
        for st in stage_types {
            stage_reg.register(st);
        }
        let stage_registry = Arc::new(stage_reg);

        let mut art_reg = ArtifactTypeRegistry::new();
        art_reg.register(ArtifactTypeDef {
            id: "any".into(),
            validate: |_| Ok(()),
            component_id: "v".into(),
        });
        let artifact_registry = Arc::new(art_reg);

        let bus = EventBus::new();
        let coordinator = Arc::new(Coordinator::new(
            pool.clone(),
            stage_registry.clone(),
            artifact_registry.clone(),
            bus.clone(),
        ));

        AppState {
            pool,
            stage_registry,
            artifact_registry,
            coordinator,
            bus,
            live_delegated: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn make_state(
        stage_types: Vec<Arc<dyn crate::registry::stage_type::StageType>>,
    ) -> AppState {
        let path = format!("/tmp/oakridge_http_{}.db", Uuid::new_v4());
        make_state_at(&path, stage_types).await
    }

    // ── HTTP request helper ───────────────────────────────────────────────────

    async fn req(
        app: axum::Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let body_bytes = body
            .map(|b| serde_json::to_vec(&b).unwrap())
            .unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body_bytes))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    fn minimal_graph(stage_type: &str) -> Value {
        json!({
            "stages": {
                "s1": {
                    "stage_type": stage_type,
                    "config": {},
                    "inputs": [],
                    "outputs": []
                }
            },
            "edges": []
        })
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_context_merge_project_injected_and_caller_wins() {
        let state = make_state(vec![Arc::new(ImmediateStage)]).await;
        let pool = state.pool.clone();

        // POST /projects
        let app = crate::http::router(state.clone());
        let (status, proj) = req(
            app,
            "POST",
            "/projects",
            Some(json!({"name": "my-project", "repo_dir": "/repos/my-project"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let project_id = proj["id"].as_str().unwrap().to_string();

        // POST /workflow_defs
        let app = crate::http::router(state.clone());
        let (status, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({
                "name": "ctx-wf",
                "version": 1,
                "graph": minimal_graph("immediate")
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let def_id = def["id"].as_str().unwrap().to_string();

        // Case A: caller supplies workdir (should override injected)
        let app = crate::http::router(state.clone());
        let (status, run_a) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({
                "workflow_def_id": def_id,
                "project_id": project_id,
                "context": {"workdir": "/caller/override", "extra": "field"}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "run A: {}", run_a);
        let ctx_a = &run_a["context"];
        assert_eq!(ctx_a["project"]["id"], json!(project_id));
        assert_eq!(ctx_a["project"]["name"], json!("my-project"));
        assert_eq!(ctx_a["project"]["repo_dir"], json!("/repos/my-project"));
        assert_eq!(ctx_a["workdir"], json!("/caller/override"), "caller workdir must win");
        assert_eq!(ctx_a["extra"], json!("field"), "caller extra key preserved");

        // Case B: no caller context => injected workdir used
        let app = crate::http::router(state.clone());
        let (status, run_b) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({
                "workflow_def_id": def_id,
                "project_id": project_id
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "run B: {}", run_b);
        let ctx_b = &run_b["context"];
        assert_eq!(ctx_b["workdir"], json!("/repos/my-project"), "injected workdir when no caller");
        assert_eq!(ctx_b["project"]["id"], json!(project_id));

        // Verify both runs persisted with correct context
        let run_a_id = WorkflowRunId(Uuid::parse_str(run_a["id"].as_str().unwrap()).unwrap());
        let stored_a = queries::get_workflow_run_by_id(&pool, &run_a_id).await.unwrap();
        assert_eq!(stored_a.context["workdir"], json!("/caller/override"));
    }

    #[tokio::test]
    async fn test_start_failure_rolls_back_pending_run_and_retry_stays_single_active() {
        let (stage, _ctx_rx) = scripted("retry_stage");
        let state = make_state(vec![stage.clone() as Arc<dyn crate::registry::stage_type::StageType>]).await;
        let pool = state.pool.clone();

        let def_id = WorkflowDefId(Uuid::new_v4());
        let def = WorkflowDef {
            id: def_id,
            name: "retry-wf".into(),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut stages = HashMap::new();
                    stages.insert(
                        "s1".into(),
                        StageNodeDef {
                            stage_type: "retry_stage".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
                    stages
                },
                edges: vec![],
            },
            created_at: Utc::now(),
        };
        queries::insert_workflow_def(&pool, &def).await.unwrap();
        sqlx::query("UPDATE workflow_def SET graph = ? WHERE id = ?")
            .bind("not-json")
            .bind(def_id.0.to_string())
            .execute(pool.as_ref())
            .await
            .unwrap();

        let first_app = crate::http::router(state.clone());
        let (status, err_body) = req(
            first_app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "error body: {err_body}");

        let runs = queries::list_workflow_runs(&pool, None, Some(&def_id), None)
            .await
            .unwrap();
        assert_eq!(runs.len(), 1, "runs after failed create: {runs:?}");
        assert_eq!(runs[0].status, RunStatus::Failed, "failed row should not remain pending");
        assert_eq!(runs[0].workflow_def_id, def_id);

        let active_after_failure = queries::list_active_runs(&pool).await.unwrap();
        assert!(active_after_failure.is_empty(), "failed create must not leave active work behind");

        sqlx::query("UPDATE workflow_def SET graph = ? WHERE id = ?")
            .bind(serde_json::to_string(&def.graph).unwrap())
            .bind(def_id.0.to_string())
            .execute(pool.as_ref())
            .await
            .unwrap();

        let second_app = crate::http::router(state.clone());
        let (status, run) = req(
            second_app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "retry body: {run}");
        let retry_run_id = WorkflowRunId(Uuid::parse_str(run["id"].as_str().unwrap()).unwrap());

        let active_after_retry = queries::list_active_runs(&pool).await.unwrap();
        assert_eq!(active_after_retry.len(), 1, "retry should create only one active run");
        assert_eq!(active_after_retry[0].id, retry_run_id);
    }

    #[tokio::test]
    async fn test_get_run_returns_stage_instances_inline() {
        let state = make_state(vec![Arc::new(ImmediateStage)]).await;
        let pool = state.pool.clone();

        let app = crate::http::router(state.clone());
        let (_, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({"name": "si-wf", "version": 1, "graph": minimal_graph("immediate")})),
        )
        .await;
        let def_id = def["id"].as_str().unwrap().to_string();

        let app = crate::http::router(state.clone());
        let (status, run) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let run_id_str = run["id"].as_str().unwrap().to_string();
        let run_id = WorkflowRunId(Uuid::parse_str(&run_id_str).unwrap());

        // Wait for stage instance to be created
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let sis = queries::list_stage_instances_for_run(&pool, &run_id).await.unwrap();
            if !sis.is_empty() {
                break;
            }
        }

        let app = crate::http::router(state.clone());
        let (status, detail) =
            req(app, "GET", &format!("/workflow_runs/{}", run_id_str), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["id"].as_str().unwrap(), run_id_str);
        let stage_instances = detail["stage_instances"].as_array().unwrap();
        assert!(!stage_instances.is_empty(), "stage_instances must be inline");
        assert_eq!(stage_instances[0]["stage_key"].as_str().unwrap(), "s1");
    }

    #[tokio::test]
    async fn test_park_verb_results_drives_run_to_done() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![scripted_stage as Arc<dyn crate::registry::stage_type::StageType>]).await;
        let pool = state.pool.clone();

        // workflow_def: one gate_stage with an output artifact
        let gate_graph = json!({
            "stages": {
                "gate": {
                    "stage_type": "gate_stage",
                    "config": {},
                    "inputs": [],
                    "outputs": [{"name": "out", "artifact_type": "any"}]
                }
            },
            "edges": []
        });
        let app = crate::http::router(state.clone());
        let (status, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({"name": "gate-wf", "version": 1, "graph": gate_graph})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let def_id = def["id"].as_str().unwrap().to_string();

        let app = crate::http::router(state.clone());
        let (status, run) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let run_id_str = run["id"].as_str().unwrap().to_string();
        let run_id = WorkflowRunId(Uuid::parse_str(&run_id_str).unwrap());

        // Script the stage: emit artifact, park
        let (ctx, mut resume_rx) =
            tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
                .await
                .unwrap()
                .unwrap();

        ctx.set_status(StageStatus::Running, None).await.unwrap();
        let artifact = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"review_content": "check me"}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        ctx.set_status(StageStatus::Parked, Some("waiting_gate".into()))
            .await
            .unwrap();

        let si_id = ctx.stage_instance_id;
        let artifact_id = artifact.id;

        // GET /parked — poll until the parked stage appears
        let mut parked_count = 0usize;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let app = crate::http::router(state.clone());
            let (status, body) = req(app, "GET", "/parked", None).await;
            assert_eq!(status, StatusCode::OK);
            parked_count = body.as_array().unwrap().len();
            if parked_count > 0 {
                break;
            }
        }
        assert!(parked_count > 0, "parked stage must appear in GET /parked");

        // POST /stage_instances/:id/resume
        let app = crate::http::router(state.clone());
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/resume", si_id.0),
            Some(json!({
                "kind": "gate_decision",
                "decision": {"outcome": "pass", "comment": null, "feedback": null},
                "against_artifact_id": artifact_id.0.to_string()
            })),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["status"], json!("running"), "accepted resume should return the resumed running stage");

        // Wait for resume signal, then mark stage done
        let resume =
            tokio::time::timeout(Duration::from_secs(5), resume_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));
        ctx.set_status(StageStatus::Done, None).await.unwrap();

        // Poll until run reaches done
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                break;
            }
        }
        let final_run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(final_run.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn test_park_verb_results_conflicts_on_duplicate_resume() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![scripted_stage as Arc<dyn crate::registry::stage_type::StageType>]).await;
        let pool = state.pool.clone();

        let gate_graph = json!({
            "stages": {
                "gate": {
                    "stage_type": "gate_stage",
                    "config": {},
                    "inputs": [],
                    "outputs": [{"name": "out", "artifact_type": "any"}]
                }
            },
            "edges": []
        });
        let app = crate::http::router(state.clone());
        let (status, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({"name": "gate-wf", "version": 1, "graph": gate_graph})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let def_id = def["id"].as_str().unwrap().to_string();

        let app = crate::http::router(state.clone());
        let (status, run) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let run_id_str = run["id"].as_str().unwrap().to_string();
        let run_id = WorkflowRunId(Uuid::parse_str(&run_id_str).unwrap());

        let (ctx, mut resume_rx) =
            tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
                .await
                .unwrap()
                .unwrap();

        ctx.set_status(StageStatus::Running, None).await.unwrap();
        let artifact = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"review_content": "check me"}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        ctx.set_status(StageStatus::Parked, Some("waiting_gate".into()))
            .await
            .unwrap();

        let si_id = ctx.stage_instance_id;
        let payload = json!({
            "kind": "gate_decision",
            "decision": {"outcome": "pass", "comment": null, "feedback": null},
            "against_artifact_id": artifact.id.0.to_string()
        });
        let resume_url = format!("/stage_instances/{}/resume", si_id.0);

        let app = crate::http::router(state.clone());
        let (status, body) = req(app, "POST", &resume_url, Some(payload.clone())).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["status"], json!("running"));

        let app = crate::http::router(state.clone());
        let (status, body) = req(app, "POST", &resume_url, Some(payload)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().is_some(), "duplicate resume should return a conflict message");

        let resume =
            tokio::time::timeout(Duration::from_secs(5), resume_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));
        ctx.set_status(StageStatus::Done, None).await.unwrap();

        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                break;
            }
        }
        let final_run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(final_run.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn test_park_verb_results_conflicts_on_inactive_run() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![scripted_stage as Arc<dyn crate::registry::stage_type::StageType>]).await;
        let pool = state.pool.clone();

        let gate_graph = json!({
            "stages": {
                "gate": {
                    "stage_type": "gate_stage",
                    "config": {},
                    "inputs": [],
                    "outputs": [{"name": "out", "artifact_type": "any"}]
                }
            },
            "edges": []
        });
        let app = crate::http::router(state.clone());
        let (status, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({"name": "gate-wf", "version": 1, "graph": gate_graph})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let def_id = def["id"].as_str().unwrap().to_string();

        let app = crate::http::router(state.clone());
        let (status, run) = req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let run_id_str = run["id"].as_str().unwrap().to_string();
        let run_id = WorkflowRunId(Uuid::parse_str(&run_id_str).unwrap());

        let (ctx, _) = tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
            .await
            .unwrap()
            .unwrap();

        ctx.set_status(StageStatus::Running, None).await.unwrap();
        let artifact = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"review_content": "check me"}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        ctx.set_status(StageStatus::Parked, Some("waiting_gate".into()))
            .await
            .unwrap();

        queries::update_workflow_run_status(&pool, &run_id, RunStatus::Done).await.unwrap();

        let app = crate::http::router(state.clone());
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/resume", ctx.stage_instance_id.0),
            Some(json!({
                "kind": "gate_decision",
                "decision": {"outcome": "pass", "comment": null, "feedback": null},
                "against_artifact_id": artifact.id.0.to_string()
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().is_some(), "inactive runs should return a conflict message");
    }

    #[test]
    fn test_resume_payload_executor_serde_round_trip() {
        let original = ResumePayload::Executor {
            payload: json!({"op": "permit", "id": 42}),
        };
        let serialized = serde_json::to_value(&original).unwrap();
        assert_eq!(serialized["kind"], json!("executor"));
        assert_eq!(serialized["payload"], json!({"op": "permit", "id": 42}));
        let deserialized: ResumePayload = serde_json::from_value(serialized).unwrap();
        let ResumePayload::Executor { payload: deserialized_payload } = deserialized else {
            panic!("expected Executor variant");
        };
        assert_eq!(deserialized_payload, json!({"op": "permit", "id": 42}));
    }

    #[tokio::test]
    async fn test_404_on_unknown_ids() {
        let state = make_state(vec![]).await;
        let unknown = Uuid::new_v4().to_string();

        for (method, uri) in [
            ("GET", format!("/projects/{}", unknown)),
            ("GET", format!("/workflow_defs/{}", unknown)),
            ("GET", format!("/workflow_runs/{}", unknown)),
            ("GET", format!("/stage_instances/{}", unknown)),
            ("GET", format!("/artifacts/{}", unknown)),
        ] {
            let app = crate::http::router(state.clone());
            let (status, _) = req(app, method, &uri, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "expected 404 for {} {}", method, uri);
        }
    }

    #[tokio::test]
    async fn test_409_duplicate_workflow_def() {
        let state = make_state(vec![]).await;

        let payload = json!({
            "name": "dup-wf",
            "version": 1,
            "graph": {"stages": {}, "edges": []}
        });

        let app = crate::http::router(state.clone());
        let (status, _) = req(app, "POST", "/workflow_defs", Some(payload.clone())).await;
        assert_eq!(status, StatusCode::CREATED);

        let app = crate::http::router(state.clone());
        let (status, body) = req(app, "POST", "/workflow_defs", Some(payload)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().is_some(), "error field must be present");
    }

    // ── Delegated-session callback handler tests ───────────────────────────────

    #[tokio::test]
    async fn callback_artifacts_404_for_unknown_stage() {
        let state = make_state(vec![]).await;
        let app = crate::http::router(state);
        let unknown = Uuid::new_v4();
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/artifacts", unknown),
            Some(json!({"output_name": "out", "body": "hello"})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["error"].as_str().is_some());
    }

    #[tokio::test]
    async fn callback_status_invalid_string_returns_400() {
        let state = make_state(vec![]).await;
        let app = crate::http::router(state);
        let unknown = Uuid::new_v4();
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/status", unknown),
            Some(json!({"status": "cancelled"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("invalid status"));
    }

    #[tokio::test]
    async fn callback_status_stage_instance_id_mismatch_returns_400() {
        let state = make_state(vec![]).await;
        let app = crate::http::router(state);
        let path_id = Uuid::new_v4();
        let other_id = Uuid::new_v4();
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/status", path_id),
            Some(json!({"status": "done", "stage_instance_id": other_id.to_string()})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("mismatch"));
    }

    // Helper: launch a scripted stage with a named type and return a live ctx
    // inserted into state.live_delegated. Returns (state, si_id, ctx).
    //
    // `outputs` is both the graph-level outputs list AND the `output_slots` value
    // embedded in the stage config — ScriptedStage returns def_config verbatim,
    // so the callback handler can find `ctx.config["output_slots"]`.
    async fn launch_scripted_delegated(
        type_id: &'static str,
        outputs: Value,
    ) -> (
        AppState,
        crate::types::StageInstanceId,
        StageContext,
    ) {
        let (scripted_stage, mut ctx_rx) = scripted(type_id);
        let state =
            make_state(vec![scripted_stage as Arc<dyn crate::registry::stage_type::StageType>])
                .await;

        let app = crate::http::router(state.clone());
        let (_, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({
                "name": type_id,
                "version": 1,
                "graph": {
                    "stages": {
                        "s": {
                            "stage_type": type_id,
                            // embed output_slots in def_config so ScriptedStage
                            // returns {"output_slots": [...]} as ctx.config
                            "config": {"output_slots": outputs},
                            "inputs": [],
                            "outputs": outputs
                        }
                    },
                    "edges": []
                }
            })),
        )
        .await;
        let def_id = def["id"].as_str().unwrap().to_string();

        let app = crate::http::router(state.clone());
        req(
            app,
            "POST",
            "/workflow_runs",
            Some(json!({"workflow_def_id": def_id})),
        )
        .await;

        let (ctx, _resume_rx) =
            tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
                .await
                .unwrap()
                .unwrap();
        ctx.set_status(StageStatus::Running, None).await.unwrap();

        let si_id = ctx.stage_instance_id;
        state.live_delegated.lock().unwrap().insert(si_id, ctx.clone());
        (state, si_id, ctx)
    }

    #[tokio::test]
    async fn callback_artifacts_unknown_output_name_returns_400() {
        let (state, si_id, _ctx) = launch_scripted_delegated(
            "ds_stub_a",
            json!([{"name": "result", "artifact_type": "any"}]),
        )
        .await;

        let app = crate::http::router(state);
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/artifacts", si_id.0),
            Some(json!({"output_name": "no_such_slot", "body": "hello"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("unknown output slot"));
    }

    #[tokio::test]
    async fn callback_status_removes_from_live_map_on_success() {
        let (state, si_id, _ctx) =
            launch_scripted_delegated("ds_stub_b", json!([])).await;

        assert_eq!(
            state.live_delegated.lock().unwrap().len(),
            1,
            "ctx must be in live map before callback"
        );

        let app = crate::http::router(state.clone());
        let (status, _) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/status", si_id.0),
            Some(json!({"status": "done"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        assert!(
            state.live_delegated.lock().unwrap().is_empty(),
            "live map must be empty after terminal status callback"
        );
    }

    #[tokio::test]
    async fn callback_artifacts_emit_routes_through_ctx() {
        let (state, si_id, _ctx) = launch_scripted_delegated(
            "ds_stub_c",
            json!([{"name": "out", "artifact_type": "any"}]),
        )
        .await;
        let pool = state.pool.clone();
        let run_id = {
            let map = state.live_delegated.lock().unwrap();
            map[&si_id].workflow_run_id
        };

        let app = crate::http::router(state);
        let (status, body) = req(
            app,
            "POST",
            &format!("/stage_instances/{}/artifacts", si_id.0),
            Some(json!({"output_name": "out", "body": {"value": 42}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "emit body: {body}");
        assert!(body["artifact_id"].as_str().is_some(), "response must contain artifact_id");

        // Artifact must be persisted in the DB
        let artifacts = queries::list_artifacts_for_run(&pool, &run_id, None).await.unwrap();
        assert_eq!(artifacts.len(), 1, "artifact must be persisted");
        assert_eq!(artifacts[0].output_name.as_deref(), Some("out"));
    }
}
