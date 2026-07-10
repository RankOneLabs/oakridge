use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

use crate::db::queries;
use crate::executor::delegated_session::{
    kbbl_client::DelegatedExternalRef, DelegatedGate, DelegatedGateState,
};
use crate::executor::ResumePayload;
use crate::registry::artifact_type::ArtifactCapabilities;
use crate::scheduler::DecisionError;
use crate::types::{
    Artifact, ArtifactId, GateDecision, GateOutcome, InputSlot, OutputSlot, Project, ProjectId,
    RunStatus, StageInstance, StageInstanceId, StageStatus, WorkflowDef, WorkflowDefId,
    WorkflowGraph, WorkflowRun, WorkflowRunId,
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

#[derive(Serialize)]
pub struct CancelRunResponse {
    pub run_id: Uuid,
    pub accepted: bool,
    pub stages_cancelled: u64,
}

#[derive(Serialize, Clone)]
pub struct OperatorWorktreeMetadata {
    pub branch: String,
    pub path: String,
    pub base_ref: String,
}

#[derive(Serialize, Clone)]
pub struct OperatorStageArtifact {
    pub id: String,
    pub type_id: String,
    pub version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Per-unit row within a fanned stage. Empty until the stage activates; once
/// started, N=1 stages have exactly one row with unit_id="0".
#[derive(Serialize, Clone)]
pub struct OperatorStageUnit {
    pub unit_id: String,
    pub sid: Option<String>,
    pub worktree: Option<OperatorWorktreeMetadata>,
    pub status: String,
    pub gate: Option<String>,
}

#[derive(Serialize)]
pub struct OperatorRunSummary {
    pub id: String,
    pub workflow_name: String,
    pub status: String,
    pub current_stage: Option<String>,
    pub parked_count: usize,
    pub updated_at: String,
    pub is_stuck: bool,
    pub is_failed: bool,
}

#[derive(Serialize)]
pub struct OperatorStageDetail {
    pub stage_instance_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub stage_type: String,
    pub status: String,
    pub artifacts: Vec<OperatorStageArtifact>,
    pub delegated_kbbl_sid: Option<String>,
    pub worktree: Option<OperatorWorktreeMetadata>,
    pub units: Vec<OperatorStageUnit>,
}

#[derive(Serialize)]
pub struct OperatorRunDetail {
    pub id: String,
    pub workflow_name: String,
    pub status: String,
    pub stages: Vec<OperatorStageDetail>,
    pub parked_count: usize,
    pub updated_at: String,
    pub is_stuck: bool,
}

#[derive(Serialize)]
pub struct OperatorParkedGate {
    /// Composite gate id: "{stage_instance_uuid}:{unit_id}". N=1 implicit unit → "…:0".
    pub id: String,
    pub gate_type: String,
    pub run_id: String,
    pub stage_name: String,
    /// unit_id within the stage; "0" for the N=1 implicit unit.
    pub unit_id: String,
    pub artifact_revision_id: Option<String>,
    pub worktree: Option<OperatorWorktreeMetadata>,
    pub resume_actions: Vec<String>,
}

#[derive(Deserialize)]
pub struct OperatorGateResumeRequest {
    pub action: String,
    pub operator_comment: String,
    pub feedback: Option<String>,
}

#[derive(Serialize)]
pub struct OperatorGateResumeResponse {
    pub gate_id: String,
    pub resumed: bool,
}

#[derive(Serialize)]
pub struct OperatorArtifactRevision {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub body: Value,
    pub validation: Value,
}

#[derive(Serialize)]
pub struct OperatorArtifactDetail {
    pub id: String,
    pub type_id: String,
    pub component_id: Option<String>,
    pub capabilities: Option<ArtifactCapabilities>,
    pub anchor_schema: Option<Vec<String>>,
    pub run_id: String,
    pub producing_stage: String,
    pub label: Option<String>,
    pub revisions: Vec<OperatorArtifactRevision>,
}

#[derive(Serialize)]
pub struct ArtifactTypeResponse {
    pub id: String,
    pub component_id: String,
    pub capabilities: ArtifactCapabilities,
    pub anchor_schema: Option<Vec<String>>,
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

// ── Workflow definition validation ───────────────────────────────────────────

fn validation_error(message: impl Into<String>) -> AppError {
    AppError::Domain(crate::Error::Validation(message.into()))
}

fn find_input<'a>(inputs: &'a [InputSlot], name: &str) -> Option<&'a InputSlot> {
    inputs.iter().find(|slot| slot.name == name)
}

fn find_output<'a>(outputs: &'a [OutputSlot], name: &str) -> Option<&'a OutputSlot> {
    outputs.iter().find(|slot| slot.name == name)
}

fn validate_workflow_graph(state: &AppState, graph: &WorkflowGraph) -> Result<(), AppError> {
    for (stage_key, node) in &graph.stages {
        let stage_type = state.stage_registry.get(&node.stage_type).ok_or_else(|| {
            validation_error(format!(
                "stage '{}' references unknown stage type '{}'",
                stage_key, node.stage_type
            ))
        })?;

        for input in &node.inputs {
            if state.artifact_registry.get(&input.artifact_type).is_none() {
                return Err(validation_error(format!(
                    "stage '{}' input '{}' references unknown artifact type '{}'",
                    stage_key, input.name, input.artifact_type
                )));
            }
        }
        for output in &node.outputs {
            if state.artifact_registry.get(&output.artifact_type).is_none() {
                return Err(validation_error(format!(
                    "stage '{}' output '{}' references unknown artifact type '{}'",
                    stage_key, output.name, output.artifact_type
                )));
            }
        }

        stage_type
            .validate_def_config(&node.config, &node.inputs, &node.outputs)
            .map_err(|err| {
                validation_error(format!("stage '{}' config invalid: {}", stage_key, err))
            })?;
    }

    for edge in &graph.edges {
        let producer = graph.stages.get(&edge.from.stage).ok_or_else(|| {
            validation_error(format!(
                "edge source stage '{}' does not exist",
                edge.from.stage
            ))
        })?;
        let consumer = graph.stages.get(&edge.to.stage).ok_or_else(|| {
            validation_error(format!(
                "edge target stage '{}' does not exist",
                edge.to.stage
            ))
        })?;
        let output = find_output(&producer.outputs, &edge.from.slot).ok_or_else(|| {
            validation_error(format!(
                "edge source '{}.{}' does not match any output slot",
                edge.from.stage, edge.from.slot
            ))
        })?;
        let input = find_input(&consumer.inputs, &edge.to.slot).ok_or_else(|| {
            validation_error(format!(
                "edge target '{}.{}' does not match any input slot",
                edge.to.stage, edge.to.slot
            ))
        })?;
        if output.artifact_type != input.artifact_type {
            return Err(validation_error(format!(
                "edge '{}.{}' -> '{}.{}' connects artifact type '{}' to '{}'",
                edge.from.stage,
                edge.from.slot,
                edge.to.stage,
                edge.to.slot,
                output.artifact_type,
                input.artifact_type
            )));
        }
    }

    Ok(())
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

pub async fn list_projects(State(state): State<AppState>) -> Result<Json<Vec<Project>>, AppError> {
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
    validate_workflow_graph(&state, &body.graph)?;
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
    let def = queries::get_workflow_def_by_id(&state.pool, &body.workflow_def_id).await?;
    validate_workflow_graph(&state, &def.graph)?;

    let caller_context = body
        .context
        .unwrap_or_else(|| Value::Object(Default::default()));

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
    Ok(Json(RunDetail {
        run,
        stage_instances,
    }))
}

pub async fn cancel_workflow_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<CancelRunResponse>), AppError> {
    let run_id = WorkflowRunId(id);

    // Validate existence — propagates 404 if missing.
    let run = queries::get_workflow_run_by_id(&state.pool, &run_id).await?;

    if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
        return Ok((
            StatusCode::OK,
            Json(CancelRunResponse {
                run_id: id,
                accepted: false,
                stages_cancelled: 0,
            }),
        ));
    }

    let stages_cancelled = state.coordinator.cancel_run(run_id).await?;

    Ok((
        StatusCode::ACCEPTED,
        Json(CancelRunResponse {
            run_id: id,
            accepted: true,
            stages_cancelled,
        }),
    ))
}

pub async fn list_run_artifacts(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(params): Query<ListArtifactsQuery>,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let run_id = WorkflowRunId(id);
    let artifacts =
        queries::list_artifacts_for_run(&state.pool, &run_id, params.artifact_type.as_deref())
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

/// Optional body for POST /stage_instances/:id/retry_stuck.
/// `unit_id` targets a specific fan-out unit; absent or null → retry the whole stage (N=1 path).
#[derive(Deserialize, Default)]
pub struct RetryStuckRequest {
    #[serde(default)]
    pub unit_id: Option<String>,
}

pub async fn retry_stuck_stage_instance(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    body: Option<Json<RetryStuckRequest>>,
) -> Result<(StatusCode, Json<StageInstance>), AppError> {
    let si_id = StageInstanceId(id);
    // unit_id is accepted in the body but not yet forwarded to the coordinator
    // (the N=1 path always retries the whole stage). N>1 fan-out will use it in Phase 2b.
    let _unit_id = body.map(|Json(b)| b.unit_id).unwrap_or(None);

    state
        .coordinator
        .retry_stuck_stage(si_id)
        .await
        .map_err(|e| match e {
            DecisionError::Conflict(msg) => AppError::Conflict(msg),
            DecisionError::Internal(err) => AppError::Internal(err.to_string()),
        })?;

    let updated = queries::get_stage_instance_by_id(&state.pool, &si_id).await?;
    Ok((StatusCode::ACCEPTED, Json(updated)))
}

// ── Parked handler ────────────────────────────────────────────────────────────

pub async fn list_parked(
    State(state): State<AppState>,
) -> Result<Json<Vec<StageInstance>>, AppError> {
    let parked = queries::list_parked_stage_instances(&state.pool).await?;
    Ok(Json(parked))
}

// ── Operator/PWA read-model handlers ─────────────────────────────────────────

fn operator_run_status(run: &WorkflowRun, parked_count: usize) -> String {
    operator_run_status_from_parts(run.status, parked_count)
}

fn operator_run_status_from_parts(status: RunStatus, parked_count: usize) -> String {
    match status {
        RunStatus::Done => "complete".to_owned(),
        RunStatus::Failed => "failed".to_owned(),
        RunStatus::Pending | RunStatus::Running if parked_count > 0 => "parked".to_owned(),
        RunStatus::Pending | RunStatus::Running => "running".to_owned(),
    }
}

fn operator_stage_status(status: StageStatus) -> String {
    match status {
        StageStatus::Pending => "pending",
        StageStatus::Running => "running",
        StageStatus::Parked => "parked",
        StageStatus::Done => "complete",
        StageStatus::Failed => "failed",
    }
    .to_owned()
}

fn operator_artifact_revision_status(status: StageStatus) -> String {
    if matches!(status, StageStatus::Done) {
        "approved"
    } else {
        "draft"
    }
    .to_owned()
}

fn delegated_external_ref(stage: &StageInstance) -> Option<DelegatedExternalRef> {
    stage
        .external_ref
        .as_deref()
        .map(DelegatedExternalRef::parse)
}

fn delegated_gate_state(stage: &StageInstance) -> Option<DelegatedGateState> {
    stage
        .parked_meta
        .as_ref()
        .and_then(|meta| serde_json::from_value::<DelegatedGateState>(meta.clone()).ok())
}

fn worktree_from_parts(
    path: Option<String>,
    branch: Option<String>,
    base_ref: Option<String>,
) -> Option<OperatorWorktreeMetadata> {
    Some(OperatorWorktreeMetadata {
        branch: branch?,
        path: path?,
        base_ref: base_ref?,
    })
}

fn operator_worktree(stage: &StageInstance) -> Option<OperatorWorktreeMetadata> {
    if let Some(gate) = delegated_gate_state(stage) {
        if let Some(worktree) = worktree_from_parts(
            gate.worktree_path,
            gate.worktree_branch,
            gate.worktree_base_ref,
        ) {
            return Some(worktree);
        }
    }
    delegated_external_ref(stage).and_then(|external| {
        worktree_from_parts(
            external.worktree_path,
            external.worktree_branch,
            external.worktree_base_ref,
        )
    })
}

fn operator_gate_type(stage: &StageInstance, gate: Option<&DelegatedGateState>) -> String {
    match gate.map(|gate| &gate.gate) {
        Some(DelegatedGate::ArtifactApproval) => "artifact_approval".to_owned(),
        Some(DelegatedGate::MergeConfirmation) => "merge_confirmation".to_owned(),
        None => stage
            .parked_reason
            .clone()
            .unwrap_or_else(|| "parked".to_owned()),
    }
}

fn operator_resume_actions(gate: Option<&DelegatedGateState>) -> Vec<String> {
    match gate.map(|gate| &gate.gate) {
        Some(DelegatedGate::ArtifactApproval) => {
            vec!["pass".to_owned(), "fail".to_owned(), "rerun".to_owned()]
        }
        Some(DelegatedGate::MergeConfirmation) => vec!["pass".to_owned()],
        None => vec![],
    }
}

fn operator_gate(stage: &StageInstance) -> OperatorParkedGate {
    let gate = delegated_gate_state(stage);
    // N=1 implicit unit always uses unit_id "0".
    // N>1 fan-out (Phase 2b) will supply the unit_id from stage_session_units.
    let unit_id = "0".to_owned();
    OperatorParkedGate {
        id: format!("{}:{}", stage.id.0, unit_id),
        gate_type: operator_gate_type(stage, gate.as_ref()),
        run_id: stage.run_id.0.to_string(),
        stage_name: stage.stage_key.clone(),
        unit_id,
        artifact_revision_id: gate.as_ref().map(|gate| gate.artifact_id.0.to_string()),
        worktree: operator_worktree(stage),
        resume_actions: operator_resume_actions(gate.as_ref()),
    }
}

fn artifacts_by_stage(
    artifacts: Vec<Artifact>,
) -> HashMap<StageInstanceId, Vec<OperatorStageArtifact>> {
    let mut by_stage: HashMap<StageInstanceId, Vec<OperatorStageArtifact>> = HashMap::new();
    for artifact in artifacts {
        by_stage
            .entry(artifact.stage_instance_id)
            .or_default()
            .push(OperatorStageArtifact {
                id: artifact.id.0.to_string(),
                type_id: artifact.artifact_type,
                version: artifact.version,
                label: artifact.label,
            });
    }
    by_stage
}

fn operator_unit_status(status: &crate::types::UnitStatus) -> String {
    match status {
        crate::types::UnitStatus::Pending => "pending",
        crate::types::UnitStatus::Running => "running",
        crate::types::UnitStatus::Parked => "parked",
        crate::types::UnitStatus::Done => "complete",
        crate::types::UnitStatus::Failed => "failed",
    }
    .to_owned()
}

fn operator_stage_unit(unit: crate::types::SessionUnit) -> OperatorStageUnit {
    let sid = unit
        .external_ref
        .as_deref()
        .map(|s| DelegatedExternalRef::parse(s).sid);
    let worktree = worktree_from_parts(
        unit.worktree_path,
        unit.worktree_branch,
        unit.worktree_base_ref,
    );
    let gate = unit
        .gate_state
        .as_ref()
        .and_then(|v| serde_json::from_value::<DelegatedGateState>(v.clone()).ok())
        .map(|g| operator_gate_type_str(&g.gate));
    OperatorStageUnit {
        unit_id: unit.unit_id,
        sid,
        worktree,
        status: operator_unit_status(&unit.status),
        gate,
    }
}

fn operator_gate_type_str(gate: &DelegatedGate) -> String {
    match gate {
        DelegatedGate::ArtifactApproval => "artifact_approval".to_owned(),
        DelegatedGate::MergeConfirmation => "merge_confirmation".to_owned(),
    }
}

fn units_by_stage(
    units: Vec<crate::types::SessionUnit>,
) -> HashMap<StageInstanceId, Vec<OperatorStageUnit>> {
    let mut by_stage: HashMap<StageInstanceId, Vec<OperatorStageUnit>> = HashMap::new();
    for unit in units {
        let stage_id = unit.stage_instance_id;
        by_stage
            .entry(stage_id)
            .or_default()
            .push(operator_stage_unit(unit));
    }
    by_stage
}

fn operator_stage(
    stage: StageInstance,
    artifacts_by_stage: &HashMap<StageInstanceId, Vec<OperatorStageArtifact>>,
    units_by_stage: &HashMap<StageInstanceId, Vec<OperatorStageUnit>>,
) -> OperatorStageDetail {
    let external = delegated_external_ref(&stage);
    OperatorStageDetail {
        stage_instance_id: stage.id.0.to_string(),
        name: stage.stage_key.clone(),
        stage_type: stage.stage_type.clone(),
        status: operator_stage_status(stage.status),
        artifacts: artifacts_by_stage
            .get(&stage.id)
            .cloned()
            .unwrap_or_default(),
        delegated_kbbl_sid: external.map(|external| external.sid),
        worktree: operator_worktree(&stage),
        units: units_by_stage
            .get(&stage.id)
            .cloned()
            .unwrap_or_default(),
    }
}

fn operator_run_summary(row: queries::OperatorRunSummary) -> OperatorRunSummary {
    OperatorRunSummary {
        id: row.run_id.0.to_string(),
        workflow_name: row.workflow_name,
        status: operator_run_status_from_parts(row.status, row.parked_count),
        current_stage: row.current_stage,
        parked_count: row.parked_count,
        updated_at: row.updated_at.to_rfc3339(),
        is_stuck: row.is_stuck,
        is_failed: matches!(row.status, RunStatus::Failed),
    }
}

pub async fn list_operator_runs(
    State(state): State<AppState>,
) -> Result<Json<Vec<OperatorRunSummary>>, AppError> {
    let summaries = queries::list_operator_run_summaries(&state.pool)
        .await?
        .into_iter()
        .map(operator_run_summary)
        .collect();
    Ok(Json(summaries))
}

pub async fn get_operator_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<OperatorRunDetail>, AppError> {
    let run_id = WorkflowRunId(id);
    let run = queries::get_workflow_run_by_id(&state.pool, &run_id).await?;
    let def = queries::get_workflow_def_by_id(&state.pool, &run.workflow_def_id).await?;
    let stages = queries::list_stage_instances_for_run(&state.pool, &run_id).await?;
    let artifacts = queries::list_artifacts_for_run(&state.pool, &run_id, None).await?;
    let session_units = queries::list_session_units_for_run(&state.pool, &run_id).await?;
    let artifacts_by_stage = artifacts_by_stage(artifacts);
    let units_by_stage = units_by_stage(session_units);
    let parked_count = stages
        .iter()
        .filter(|stage| matches!(stage.status, StageStatus::Parked))
        .count();
    let is_stuck = stages
        .iter()
        .any(|s| s.parked_reason.as_deref() == Some("stuck_timeout"));
    let current_status = operator_run_status(&run, parked_count);
    let stage_details = stages
        .into_iter()
        .map(|stage| operator_stage(stage, &artifacts_by_stage, &units_by_stage))
        .collect();
    Ok(Json(OperatorRunDetail {
        id: run.id.0.to_string(),
        workflow_name: def.name,
        status: current_status,
        stages: stage_details,
        parked_count,
        updated_at: run.updated_at.to_rfc3339(),
        is_stuck,
    }))
}

pub async fn list_operator_gates(
    State(state): State<AppState>,
) -> Result<Json<Vec<OperatorParkedGate>>, AppError> {
    let parked = queries::list_parked_stage_instances(&state.pool).await?;
    Ok(Json(parked.iter().map(operator_gate).collect()))
}

pub async fn list_operator_run_gates(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<OperatorParkedGate>>, AppError> {
    let run_id = WorkflowRunId(id);
    queries::get_workflow_run_by_id(&state.pool, &run_id).await?;
    let stages = queries::list_stage_instances_for_run(&state.pool, &run_id).await?;
    let parked = stages
        .iter()
        .filter(|stage| matches!(stage.status, StageStatus::Parked))
        .map(operator_gate)
        .collect();
    Ok(Json(parked))
}

fn gate_outcome(action: &str) -> Option<GateOutcome> {
    match action {
        "pass" | "approve" => Some(GateOutcome::Pass),
        "fail" | "reject" => Some(GateOutcome::Fail),
        "rerun" => Some(GateOutcome::Rerun),
        _ => None,
    }
}

pub async fn resume_operator_gate(
    State(state): State<AppState>,
    Path(composite_id): Path<String>,
    Json(body): Json<OperatorGateResumeRequest>,
) -> Result<(StatusCode, Json<OperatorGateResumeResponse>), AppError> {
    // Parse composite gate id: "{stage_uuid}:{unit_id}"
    let (stage_uuid_str, unit_id) = composite_id.split_once(':').ok_or_else(|| {
        validation_error(format!(
            "invalid gate id '{}': expected '{{stage_uuid}}:{{unit_id}}'",
            composite_id
        ))
    })?;
    let stage_uuid = Uuid::parse_str(stage_uuid_str).map_err(|_| {
        validation_error(format!(
            "invalid stage uuid in gate id '{}'",
            composite_id
        ))
    })?;
    let stage_instance_id = StageInstanceId(stage_uuid);
    let stage = queries::get_stage_instance_by_id(&state.pool, &stage_instance_id).await?;
    // Validate unit_id against the known units for this stage (rejects stale or
    // client-side bugs where a wrong unit is targeted — e.g. "uuid:1" when only "0" exists).
    let units = queries::list_session_units_for_stage(&state.pool, &stage_instance_id).await?;
    if !units.iter().any(|u| u.unit_id == unit_id) {
        return Err(validation_error(format!(
            "unit '{}' not found on stage instance '{}'",
            unit_id, stage_instance_id.0
        )));
    }
    let gate = delegated_gate_state(&stage).ok_or_else(|| {
        validation_error(format!(
            "stage instance {} has no resumable delegated gate metadata",
            stage_instance_id.0
        ))
    })?;
    let outcome = gate_outcome(body.action.as_str())
        .ok_or_else(|| validation_error(format!("unknown gate action '{}'", body.action)))?;
    let comment = body.operator_comment.trim();
    if comment.is_empty() {
        return Err(validation_error("operator_comment is required"));
    }
    let feedback = body
        .feedback
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    state
        .coordinator
        .resume_parked_stage_if_active(
            stage.run_id,
            stage_instance_id,
            ResumePayload::GateDecision {
                decision: GateDecision {
                    outcome,
                    comment: Some(comment.to_owned()),
                    feedback,
                },
                against_artifact_id: gate.artifact_id,
            },
        )
        .await
        .map_err(|e| match e {
            DecisionError::Conflict(msg) => AppError::Conflict(msg),
            DecisionError::Internal(err) => AppError::Internal(err.to_string()),
        })?;

    Ok((
        StatusCode::ACCEPTED,
        Json(OperatorGateResumeResponse {
            gate_id: composite_id,
            resumed: true,
        }),
    ))
}

pub async fn get_operator_artifact_detail(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<OperatorArtifactDetail>, AppError> {
    let artifact_id = ArtifactId(id);
    let mut chain = queries::get_artifact_chain(&state.pool, &artifact_id).await?;
    chain.reverse();
    let requested = chain
        .last()
        .cloned()
        .ok_or_else(|| crate::Error::NotFound {
            entity: "artifact".into(),
            id: id.to_string(),
        })?;
    let producing_stage =
        queries::get_stage_instance_by_id(&state.pool, &requested.stage_instance_id).await?;
    let mut status_by_stage: HashMap<StageInstanceId, String> = HashMap::new();
    for artifact in &chain {
        if !status_by_stage.contains_key(&artifact.stage_instance_id) {
            let stage =
                queries::get_stage_instance_by_id(&state.pool, &artifact.stage_instance_id).await?;
            status_by_stage.insert(
                artifact.stage_instance_id,
                operator_artifact_revision_status(stage.status),
            );
        }
    }
    let revisions = chain
        .into_iter()
        .map(|artifact| OperatorArtifactRevision {
            id: artifact.id.0.to_string(),
            status: status_by_stage
                .get(&artifact.stage_instance_id)
                .cloned()
                .unwrap_or_else(|| "draft".to_owned()),
            created_at: artifact.created_at.to_rfc3339(),
            body: artifact.body,
            validation: json!({
                "valid": true,
                "artifact_type": artifact.artifact_type,
            }),
        })
        .collect();

    let type_def = state.artifact_registry.get(&requested.artifact_type);
    let component_id = type_def.map(|d| d.component_id.clone());
    let capabilities = type_def.map(|d| d.capabilities.clone());
    let anchor_schema = type_def.and_then(|d| d.anchor_schema.clone());

    Ok(Json(OperatorArtifactDetail {
        id: requested.id.0.to_string(),
        type_id: requested.artifact_type,
        component_id,
        capabilities,
        anchor_schema,
        run_id: requested.run_id.0.to_string(),
        producing_stage: producing_stage.stage_key,
        label: requested.label,
        revisions,
    }))
}

pub async fn get_artifact_types(
    State(state): State<AppState>,
) -> Result<Json<Vec<ArtifactTypeResponse>>, AppError> {
    let mut types: Vec<ArtifactTypeResponse> = state
        .artifact_registry
        .all()
        .map(|def| ArtifactTypeResponse {
            id: def.id.clone(),
            component_id: def.component_id.clone(),
            capabilities: def.capabilities.clone(),
            anchor_schema: def.anchor_schema.clone(),
        })
        .collect();
    types.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Json(types))
}

// ── Collab DTOs ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PostThreadRequest {
    pub anchor: Option<String>,
    pub body: String,
    pub author: String,
}

#[derive(Serialize)]
pub struct PostThreadResponse {
    pub thread_id: String,
    pub message_id: String,
}

#[derive(Deserialize)]
pub struct PostMessageRequest {
    pub body: String,
    pub author: String,
}

#[derive(Serialize)]
pub struct PostMessageResponse {
    pub message_id: String,
}

#[derive(Deserialize)]
pub struct PatchThreadRequest {
    pub status: String,
}

#[derive(Serialize)]
pub struct ThreadWithMessages {
    pub id: String,
    pub artifact_id: String,
    pub revision_id: String,
    pub anchor: Option<String>,
    pub status: String,
    pub created_at: String,
    pub messages: Vec<MessageDto>,
}

#[derive(Serialize)]
pub struct MessageDto {
    pub id: String,
    pub thread_id: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct PostAtomEditRequest {
    pub anchor: String,
    pub prev_value: Value,
    pub new_value: Value,
    pub author: String,
}

#[derive(Serialize)]
pub struct PostAtomEditResponse {
    pub artifact_id: String,
}

#[derive(Deserialize)]
pub struct PostReviewItemRequest {
    pub anchor: String,
    pub claim: String,
    pub reality: String,
}

#[derive(Serialize)]
pub struct ReviewItemDto {
    pub id: String,
    pub artifact_id: String,
    pub revision_id: String,
    pub anchor: String,
    pub claim: String,
    pub reality: String,
    pub status: String,
    pub resolution: Option<String>,
    pub created_at: String,
}

impl From<crate::collab::ReviewItem> for ReviewItemDto {
    fn from(ri: crate::collab::ReviewItem) -> Self {
        ReviewItemDto {
            id: ri.id.to_string(),
            artifact_id: ri.artifact_id.to_string(),
            revision_id: ri.revision_id,
            anchor: ri.anchor,
            claim: ri.claim,
            reality: ri.reality,
            status: ri.status.as_str().to_string(),
            resolution: ri.resolution,
            created_at: ri.created_at.to_rfc3339(),
        }
    }
}

#[derive(Deserialize)]
pub struct PatchReviewItemRequest {
    pub status: String,
    pub resolution: Option<String>,
}

// ── Collab helpers ────────────────────────────────────────────────────────────

/// Require that the artifact type supports the given capability flag.
fn require_cap(
    state: &super::AppState,
    artifact_type: &str,
    getter: impl Fn(&crate::registry::artifact_type::ArtifactCapabilities) -> bool,
    cap_name: &str,
) -> Result<(), AppError> {
    let def = state
        .artifact_registry
        .get(artifact_type)
        .ok_or_else(|| crate::Error::RegistryMiss(artifact_type.to_string()))?;
    if !getter(&def.capabilities) {
        return Err(AppError::Domain(crate::Error::Validation(format!(
            "artifact type '{artifact_type}' does not support '{cap_name}'"
        ))));
    }
    Ok(())
}

/// Walk the parent chain to find the chain-root artifact id.
async fn chain_root_id(
    pool: &sqlx::SqlitePool,
    artifact_id: &crate::types::ArtifactId,
) -> crate::Result<String> {
    let chain = queries::get_artifact_chain(pool, artifact_id).await?;
    let root = chain
        .last()
        .ok_or_else(|| crate::Error::Validation("empty artifact chain".into()))?;
    Ok(root.id.0.to_string())
}

// ── POST /artifacts/:id/threads ───────────────────────────────────────────────

pub async fn post_thread(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PostThreadRequest>,
) -> Result<(StatusCode, Json<PostThreadResponse>), AppError> {
    let artifact_id = crate::types::ArtifactId(id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    require_cap(&state, &artifact.artifact_type, |c| c.commentable, "commentable")?;

    let revision_id = chain_root_id(&state.pool, &artifact_id).await?;
    let now = chrono::Utc::now();
    let thread_id = Uuid::new_v4();
    let message_id = Uuid::new_v4();

    let thread = crate::collab::CollabThread {
        id: thread_id,
        artifact_id: id,
        revision_id,
        anchor: req.anchor,
        status: crate::collab::ThreadStatus::Open,
        created_at: now,
    };
    queries::insert_thread(&state.pool, &thread).await?;

    let message = crate::collab::CollabMessage {
        id: message_id,
        thread_id,
        body: req.body,
        author: req.author,
        created_at: now,
    };
    queries::insert_message(&state.pool, &message).await?;

    Ok((
        StatusCode::CREATED,
        Json(PostThreadResponse {
            thread_id: thread_id.to_string(),
            message_id: message_id.to_string(),
        }),
    ))
}

// ── GET /artifacts/:id/threads ────────────────────────────────────────────────

pub async fn list_threads(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ThreadWithMessages>>, AppError> {
    let artifact_id = crate::types::ArtifactId(id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    require_cap(&state, &artifact.artifact_type, |c| c.commentable, "commentable")?;

    let threads = queries::list_threads_for_artifact(&state.pool, &id).await?;
    let mut result = Vec::with_capacity(threads.len());
    for t in threads {
        let messages = queries::list_messages_for_thread(&state.pool, &t.id).await?;
        result.push(ThreadWithMessages {
            id: t.id.to_string(),
            artifact_id: t.artifact_id.to_string(),
            revision_id: t.revision_id,
            anchor: t.anchor,
            status: t.status.as_str().to_string(),
            created_at: t.created_at.to_rfc3339(),
            messages: messages
                .into_iter()
                .map(|m| MessageDto {
                    id: m.id.to_string(),
                    thread_id: m.thread_id.to_string(),
                    body: m.body,
                    author: m.author,
                    created_at: m.created_at.to_rfc3339(),
                })
                .collect(),
        });
    }
    Ok(Json(result))
}

// ── POST /threads/:id/messages ────────────────────────────────────────────────

pub async fn post_message(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PostMessageRequest>,
) -> Result<(StatusCode, Json<PostMessageResponse>), AppError> {
    let thread = queries::get_thread_by_id(&state.pool, &id).await?;
    if thread.status != crate::collab::ThreadStatus::Open {
        return Err(AppError::Domain(crate::Error::Validation(
            "cannot post to a resolved thread".into(),
        )));
    }
    let message_id = Uuid::new_v4();
    let message = crate::collab::CollabMessage {
        id: message_id,
        thread_id: id,
        body: req.body,
        author: req.author,
        created_at: chrono::Utc::now(),
    };
    queries::insert_message(&state.pool, &message).await?;
    Ok((
        StatusCode::CREATED,
        Json(PostMessageResponse {
            message_id: message_id.to_string(),
        }),
    ))
}

// ── POST /threads/:id/ping ────────────────────────────────────────────────────

pub async fn post_ping(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let thread = queries::get_thread_by_id(&state.pool, &id).await?;
    if thread.status != crate::collab::ThreadStatus::Open {
        return Err(AppError::Domain(crate::Error::Validation(
            "cannot ping a resolved thread".into(),
        )));
    }
    let artifact_id = crate::types::ArtifactId(thread.artifact_id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    let messages = queries::list_messages_for_thread(&state.pool, &id).await?;

    let thread_id_str = id.to_string();
    let anchor_str = thread.anchor.clone().unwrap_or_else(|| "entire artifact".into());
    let artifact_body_pretty =
        serde_json::to_string_pretty(&artifact.body).unwrap_or_else(|_| artifact.body.to_string());

    let messages_text = messages
        .iter()
        .map(|m| format!("{} ({}): {}", m.author, m.created_at.to_rfc3339(), m.body))
        .collect::<Vec<_>>()
        .join("\n\n");

    let oakridge_base = std::env::var("OAKRIDGE_CORE_SELF_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8790".into());

    // Load ping-responder prompt template from prompts_dir.
    let prompts_dir = std::env::var("OAKRIDGE_PROMPTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("./prompts"));
    let template_path = prompts_dir.join("collab").join("ping_responder.md");
    let template = match tokio::fs::read_to_string(&template_path).await {
        Ok(t) => t,
        Err(_) => {
            return Err(AppError::Internal(format!(
                "ping_responder.md not found at {:?}",
                template_path
            )))
        }
    };

    let prompt = template
        .replace("{{ARTIFACT_ID}}", &artifact.id.0.to_string())
        .replace("{{ARTIFACT_BODY}}", &artifact_body_pretty)
        .replace("{{THREAD_ID}}", &thread_id_str)
        .replace("{{ANCHOR}}", &anchor_str)
        .replace("{{MESSAGES}}", &messages_text)
        .replace("{{OAKRIDGE_API_BASE}}", &format!("{oakridge_base}"));

    // Spawn fire-and-forget kbbl session for the responder.
    let kbbl_url = std::env::var("KBBL_API_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8788/".into());
    match crate::executor::delegated_session::kbbl_client::KbblClient::new(&kbbl_url) {
        Ok(kbbl) => {
            tokio::spawn(async move {
                use crate::executor::delegated_session::kbbl_client::{
                    CreateSessionRequest, SendInputRequest,
                };
                use crate::executor::delegated_session::config::DelegatedRuntime;
                let req = CreateSessionRequest {
                    workdir: "/tmp".into(),
                    name: format!("ping-responder-{}", thread_id_str),
                    artifact_id: thread_id_str.clone(),
                    runtime: DelegatedRuntime::ClaudeCode,
                    model: None,
                    effort: None,
                    worktree: None,
                };
                match kbbl.create_session(req).await {
                    Ok(snap) => {
                        let _ = kbbl
                            .send_input(&snap.sid, SendInputRequest { text: prompt })
                            .await;
                    }
                    Err(e) => {
                        tracing::warn!("ping-responder session failed: {e}");
                    }
                }
            });
        }
        Err(e) => {
            tracing::warn!("ping-responder: invalid KBBL_API_BASE_URL: {e}");
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ── PATCH /threads/:id ────────────────────────────────────────────────────────

pub async fn patch_thread(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PatchThreadRequest>,
) -> Result<Json<Value>, AppError> {
    let status = crate::collab::ThreadStatus::from_str(&req.status)?;
    queries::update_thread_status(&state.pool, &id, &status).await?;
    Ok(Json(json!({ "thread_id": id.to_string(), "status": req.status })))
}

// ── POST /artifacts/:id/edits ─────────────────────────────────────────────────

pub async fn post_atom_edit(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PostAtomEditRequest>,
) -> Result<(StatusCode, Json<PostAtomEditResponse>), AppError> {
    let artifact_id = crate::types::ArtifactId(id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    require_cap(&state, &artifact.artifact_type, |c| c.atom_editable, "atom_editable")?;

    // Verify prev_value matches current value at anchor (OCC check).
    let current_at_anchor = artifact.body.pointer(&req.anchor);
    let prev_matches = match current_at_anchor {
        Some(v) => v == &req.prev_value,
        None => req.prev_value.is_null(),
    };
    if !prev_matches {
        return Err(AppError::Conflict(format!(
            "prev_value mismatch at anchor '{}': optimistic lock failed",
            req.anchor
        )));
    }

    // Apply edit to a clone of the body.
    let mut new_body = artifact.body.clone();
    let target = new_body
        .pointer_mut(&req.anchor)
        .ok_or_else(|| crate::Error::Validation(format!("anchor '{}' not found in body", req.anchor)))?;
    *target = req.new_value;

    // Validate the new body against the artifact type's schema.
    if let Some(def) = state.artifact_registry.get(&artifact.artifact_type) {
        (def.validate)(&new_body)?;
    }

    // Create a new artifact revision.
    let new_id = crate::types::ArtifactId(Uuid::new_v4());
    let new_artifact = crate::types::Artifact {
        id: new_id,
        run_id: artifact.run_id,
        stage_instance_id: artifact.stage_instance_id,
        artifact_type: artifact.artifact_type,
        output_name: artifact.output_name,
        label: artifact.label,
        body: new_body,
        version: artifact.version + 1,
        parent_artifact_id: Some(artifact_id),
        created_at: chrono::Utc::now(),
    };
    queries::insert_artifact(&state.pool, &new_artifact).await?;

    Ok((
        StatusCode::CREATED,
        Json(PostAtomEditResponse {
            artifact_id: new_id.0.to_string(),
        }),
    ))
}

// ── POST /artifacts/:id/review_items ─────────────────────────────────────────

pub async fn post_review_item(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PostReviewItemRequest>,
) -> Result<(StatusCode, Json<ReviewItemDto>), AppError> {
    let artifact_id = crate::types::ArtifactId(id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    require_cap(&state, &artifact.artifact_type, |c| c.review_items, "review_items")?;

    let revision_id = chain_root_id(&state.pool, &artifact_id).await?;
    let ri = crate::collab::ReviewItem {
        id: Uuid::new_v4(),
        artifact_id: id,
        revision_id,
        anchor: req.anchor,
        claim: req.claim,
        reality: req.reality,
        status: crate::collab::ReviewItemStatus::Open,
        resolution: None,
        created_at: chrono::Utc::now(),
    };
    queries::insert_review_item(&state.pool, &ri).await?;
    Ok((StatusCode::CREATED, Json(ri.into())))
}

// ── GET /artifacts/:id/review_items ──────────────────────────────────────────

pub async fn list_review_items(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ReviewItemDto>>, AppError> {
    let artifact_id = crate::types::ArtifactId(id);
    let artifact = queries::get_artifact_by_id(&state.pool, &artifact_id).await?;
    require_cap(&state, &artifact.artifact_type, |c| c.review_items, "review_items")?;

    let items = queries::list_review_items_for_artifact(&state.pool, &id).await?;
    Ok(Json(items.into_iter().map(ReviewItemDto::from).collect()))
}

// ── PATCH /review_items/:id ───────────────────────────────────────────────────

pub async fn patch_review_item_status(
    State(state): State<super::AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PatchReviewItemRequest>,
) -> Result<Json<ReviewItemDto>, AppError> {
    let status = crate::collab::ReviewItemStatus::from_str(&req.status)?;
    queries::patch_review_item(
        &state.pool,
        &id,
        &status,
        req.resolution.as_deref(),
    )
    .await?;
    let updated = queries::get_review_item_by_id(&state.pool, &id).await?;
    Ok(Json(updated.into()))
}

// ── Integration tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::events::EventBus;
    use crate::executor::delegated_session::DelegatedExecutor;
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
            ctx.set_status_with_terminal_meta(
                StageStatus::Done,
                None,
                Some(json!({"result": "immediate"})),
            )
            .await?;
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
            capabilities: crate::registry::artifact_type::ArtifactCapabilities {
                reviewable: false,
                commentable: false,
                atom_editable: false,
                review_items: false,
            },
            anchor_schema: None,
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
    async fn test_workflow_def_validation_rejects_unknown_stage_type() {
        let state = make_state(vec![]).await;
        let app = crate::http::router(state);
        let (status, body) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(json!({
                "name": "bad-wf",
                "version": 1,
                "graph": minimal_graph("missing_stage_type")
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("unknown stage type"),
            "unexpected body: {body:?}"
        );
    }

    #[tokio::test]
    async fn test_operator_read_models_expose_delegated_metadata_and_artifact_detail() {
        let state = make_state(vec![]).await;
        let now = Utc::now();
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: "operator-wf".into(),
            version: 1,
            graph: WorkflowGraph {
                stages: HashMap::new(),
                edges: vec![],
            },
            created_at: now,
        };
        queries::insert_workflow_def(&state.pool, &def)
            .await
            .unwrap();
        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({}),
            version: 1,
            created_at: now,
            updated_at: now,
        };
        queries::insert_workflow_run(&state.pool, &run)
            .await
            .unwrap();

        let stage_id = StageInstanceId(Uuid::new_v4());
        let artifact_id = ArtifactId(Uuid::new_v4());
        let external_ref = DelegatedExternalRef {
            sid: "sid-123".into(),
            worktree_path: Some("/worktrees/v2/build".into()),
            worktree_branch: Some("cohort/v2/1-build".into()),
            worktree_base_ref: Some("abc123".into()),
        };
        let gate_state = DelegatedGateState {
            executor: DelegatedExecutor::DelegatedSession,
            kbbl_sid: "sid-123".into(),
            gate: DelegatedGate::ArtifactApproval,
            artifact_id,
            revision_count: 1,
            worktree_path: Some("/worktrees/v2/build".into()),
            worktree_branch: Some("cohort/v2/1-build".into()),
            worktree_base_ref: Some("abc123".into()),
        };
        let stage = StageInstance {
            id: stage_id,
            run_id: run.id,
            stage_key: "build".into(),
            stage_type: "delegated_session".into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("waiting_gate".into()),
            parked_meta: Some(serde_json::to_value(&gate_state).unwrap()),
            terminal_meta: None,
            external_ref: Some(serde_json::to_string(&external_ref).unwrap()),
            started_at: Some(now),
            ended_at: None,
            created_at: now,
            updated_at: now,
        };
        queries::insert_stage_instance(&state.pool, &stage)
            .await
            .unwrap();
        let artifact = Artifact {
            id: artifact_id,
            run_id: run.id,
            stage_instance_id: stage_id,
            artifact_type: "any".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!({"summary": "done"}),
            version: 1,
            parent_artifact_id: None,
            created_at: now,
        };
        queries::insert_artifact(&state.pool, &artifact)
            .await
            .unwrap();

        let app = crate::http::router(state.clone());
        let (status, run_detail) = req(app, "GET", &format!("/runs/{}", run.id.0), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(run_detail["workflow_name"], json!("operator-wf"));
        assert_eq!(
            run_detail["stages"][0]["delegated_kbbl_sid"],
            json!("sid-123")
        );
        assert_eq!(
            run_detail["stages"][0]["worktree"]["branch"],
            json!("cohort/v2/1-build")
        );
        assert_eq!(
            run_detail["stages"][0]["artifacts"][0]["id"],
            json!(artifact_id.0.to_string())
        );

        let app = crate::http::router(state.clone());
        let (status, gates) = req(app, "GET", "/gates", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(gates[0]["gate_type"], json!("artifact_approval"));
        assert_eq!(gates[0]["resume_actions"], json!(["pass", "fail", "rerun"]));
        assert_eq!(gates[0]["worktree"]["path"], json!("/worktrees/v2/build"));

        let app = crate::http::router(state.clone());
        let (status, artifact_detail) = req(
            app,
            "GET",
            &format!("/artifact_details/{}", artifact_id.0),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(artifact_detail["type_id"], json!("any"));
        assert_eq!(artifact_detail["producing_stage"], json!("build"));
        assert_eq!(
            artifact_detail["revisions"][0]["validation"]["valid"],
            json!(true)
        );
    }

    #[tokio::test]
    async fn test_operator_artifact_detail_uses_per_revision_stage_status() {
        let state = make_state(vec![]).await;
        let now = Utc::now();
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: "artifact-revisions".into(),
            version: 1,
            graph: WorkflowGraph {
                stages: HashMap::new(),
                edges: vec![],
            },
            created_at: now,
        };
        queries::insert_workflow_def(&state.pool, &def)
            .await
            .unwrap();
        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({}),
            version: 1,
            created_at: now,
            updated_at: now,
        };
        queries::insert_workflow_run(&state.pool, &run)
            .await
            .unwrap();

        let root_stage = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "plan".into(),
            stage_type: "delegated_session".into(),
            status: StageStatus::Done,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(now),
            ended_at: Some(now),
            created_at: now,
            updated_at: now,
        };
        let child_stage = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "build".into(),
            stage_type: "delegated_session".into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("waiting_gate".into()),
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(now),
            ended_at: None,
            created_at: now,
            updated_at: now,
        };
        queries::insert_stage_instance(&state.pool, &root_stage)
            .await
            .unwrap();
        queries::insert_stage_instance(&state.pool, &child_stage)
            .await
            .unwrap();

        let root_artifact = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: root_stage.id,
            artifact_type: "any".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!({"version": 1}),
            version: 1,
            parent_artifact_id: None,
            created_at: now,
        };
        let child_artifact = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: child_stage.id,
            artifact_type: "any".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!({"version": 2}),
            version: 2,
            parent_artifact_id: Some(root_artifact.id),
            created_at: now,
        };
        queries::insert_artifact(&state.pool, &root_artifact)
            .await
            .unwrap();
        queries::insert_artifact(&state.pool, &child_artifact)
            .await
            .unwrap();

        let app = crate::http::router(state.clone());
        let (status, artifact_detail) = req(
            app,
            "GET",
            &format!("/artifact_details/{}", child_artifact.id.0),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(artifact_detail["producing_stage"], json!("build"));
        assert_eq!(artifact_detail["revisions"][0]["status"], json!("approved"));
        assert_eq!(artifact_detail["revisions"][1]["status"], json!("draft"));
    }

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
        assert_eq!(
            ctx_a["workdir"],
            json!("/caller/override"),
            "caller workdir must win"
        );
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
        assert_eq!(
            ctx_b["workdir"],
            json!("/repos/my-project"),
            "injected workdir when no caller"
        );
        assert_eq!(ctx_b["project"]["id"], json!(project_id));

        // Verify both runs persisted with correct context
        let run_a_id = WorkflowRunId(Uuid::parse_str(run_a["id"].as_str().unwrap()).unwrap());
        let stored_a = queries::get_workflow_run_by_id(&pool, &run_a_id)
            .await
            .unwrap();
        assert_eq!(stored_a.context["workdir"], json!("/caller/override"));
    }

    #[tokio::test]
    async fn test_invalid_saved_workflow_def_does_not_insert_run_and_retry_stays_single_active() {
        let (stage, _ctx_rx) = scripted("retry_stage");
        let state = make_state(vec![
            stage.clone() as Arc<dyn crate::registry::stage_type::StageType>
        ])
        .await;
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
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "error body: {err_body}"
        );

        let runs = queries::list_workflow_runs(&pool, None, Some(&def_id), None)
            .await
            .unwrap();
        assert!(
            runs.is_empty(),
            "definition validation failure must not insert a run row: {runs:?}"
        );

        let active_after_failure = queries::list_active_runs(&pool).await.unwrap();
        assert!(
            active_after_failure.is_empty(),
            "failed create must not leave active work behind"
        );

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
        assert_eq!(
            active_after_retry.len(),
            1,
            "retry should create only one active run"
        );
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

        // Wait for the immediate stage to finish. Creation happens before
        // execute(), so merely seeing the row can observe Pending with no
        // terminal_meta yet.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let sis = queries::list_stage_instances_for_run(&pool, &run_id)
                .await
                .unwrap();
            if sis.iter().any(|si| {
                si.status == StageStatus::Done
                    && si.terminal_meta == Some(json!({"result": "immediate"}))
            }) {
                break;
            }
        }

        let app = crate::http::router(state.clone());
        let (status, detail) =
            req(app, "GET", &format!("/workflow_runs/{}", run_id_str), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["id"].as_str().unwrap(), run_id_str);
        let stage_instances = detail["stage_instances"].as_array().unwrap();
        assert!(
            !stage_instances.is_empty(),
            "stage_instances must be inline"
        );
        assert_eq!(stage_instances[0]["stage_key"].as_str().unwrap(), "s1");
        assert_eq!(
            stage_instances[0]["terminal_meta"],
            json!({"result": "immediate"})
        );

        let app = crate::http::router(state.clone());
        let (status, stage_instance) = req(
            app,
            "GET",
            &format!(
                "/stage_instances/{}",
                stage_instances[0]["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            stage_instance["terminal_meta"],
            json!({"result": "immediate"})
        );
    }

    #[tokio::test]
    async fn test_park_verb_results_drives_run_to_done() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![
            scripted_stage as Arc<dyn crate::registry::stage_type::StageType>,
        ])
        .await;
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
        let (ctx, mut resume_rx) = tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
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
        assert_eq!(
            body["status"],
            json!("running"),
            "accepted resume should return the resumed running stage"
        );

        // Wait for resume signal, then mark stage done
        let resume = tokio::time::timeout(Duration::from_secs(5), resume_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));
        ctx.set_status(StageStatus::Done, None).await.unwrap();

        // Poll until run reaches done
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(&pool, &run_id)
                .await
                .unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                break;
            }
        }
        let final_run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
        assert_eq!(final_run.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn test_park_verb_results_conflicts_on_duplicate_resume() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![
            scripted_stage as Arc<dyn crate::registry::stage_type::StageType>,
        ])
        .await;
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

        let (ctx, mut resume_rx) = tokio::time::timeout(Duration::from_secs(5), ctx_rx.recv())
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
        assert!(
            body["error"].as_str().is_some(),
            "duplicate resume should return a conflict message"
        );

        let resume = tokio::time::timeout(Duration::from_secs(5), resume_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));
        ctx.set_status(StageStatus::Done, None).await.unwrap();

        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(&pool, &run_id)
                .await
                .unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                break;
            }
        }
        let final_run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
        assert_eq!(final_run.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn test_park_verb_results_conflicts_on_inactive_run() {
        let (scripted_stage, mut ctx_rx) = scripted("gate_stage");
        let state = make_state(vec![
            scripted_stage as Arc<dyn crate::registry::stage_type::StageType>,
        ])
        .await;
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

        queries::update_workflow_run_status(&pool, &run_id, RunStatus::Done)
            .await
            .unwrap();

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
        assert!(
            body["error"].as_str().is_some(),
            "inactive runs should return a conflict message"
        );
    }

    // ── ParkingStage: parks immediately, never resumes on its own ────────────

    struct ParkingHandle;

    #[async_trait]
    impl StageHandle for ParkingHandle {
        async fn resume(&self, _: ResumePayload) -> anyhow::Result<()> {
            Ok(())
        }
        async fn cancel(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct ParkingStage {
        type_id: String,
        parked_tx: mpsc::Sender<StageInstanceId>,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for ParkingStage {
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
            ctx.set_status(StageStatus::Running, None).await?;
            ctx.set_status(StageStatus::Parked, Some("waiting_cancel".into()))
                .await?;
            ctx.set_parked_meta(Some(json!({"kind": "waiting_cancel"})))
                .await?;
            let _ = self.parked_tx.send(ctx.stage_instance_id).await;
            Ok(Box::new(ParkingHandle))
        }
    }

    #[tokio::test]
    async fn test_cancel_run_transitions_parked_stage_to_failed_cancelled() {
        let (parked_tx, mut parked_rx) = mpsc::channel::<crate::types::StageInstanceId>(4);
        let parking = Arc::new(ParkingStage {
            type_id: "parking_stage".into(),
            parked_tx,
        });
        let state = make_state(vec![
            parking as Arc<dyn crate::registry::stage_type::StageType>,
        ])
        .await;
        let pool = state.pool.clone();

        let app = crate::http::router(state.clone());
        let (_, def) = req(
            app,
            "POST",
            "/workflow_defs",
            Some(
                json!({"name": "cancel-wf", "version": 1, "graph": minimal_graph("parking_stage")}),
            ),
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

        // Wait for stage to park.
        let si_id = tokio::time::timeout(Duration::from_secs(5), parked_rx.recv())
            .await
            .expect("stage must park within 5s")
            .unwrap();

        // GET /parked should show the stage.
        let mut parked_count = 0usize;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let app = crate::http::router(state.clone());
            let (_, body) = req(app, "GET", "/parked", None).await;
            parked_count = body.as_array().unwrap().len();
            if parked_count > 0 {
                break;
            }
        }
        assert!(
            parked_count > 0,
            "parked stage must appear in GET /parked before cancel"
        );

        // POST /workflow_runs/:id/cancel
        let app = crate::http::router(state.clone());
        let (status, body) = req(
            app,
            "POST",
            &format!("/workflow_runs/{}/cancel", run_id_str),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "cancel body: {body}");
        assert_eq!(body["accepted"], json!(true));
        assert_eq!(body["run_id"], json!(run_id_str));
        assert!(
            body["stages_cancelled"].as_u64().unwrap() >= 1,
            "at least one stage must have been cancelled"
        );

        // Poll until stage is Failed with kind=cancelled.
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let si = queries::get_stage_instance_by_id(&pool, &si_id)
                .await
                .unwrap();
            if si.status == StageStatus::Failed {
                let meta = si
                    .terminal_meta
                    .as_ref()
                    .expect("terminal_meta must be set on Failed cancelled stage");
                assert_eq!(
                    meta.get("kind").and_then(|v| v.as_str()),
                    Some("cancelled"),
                    "terminal_meta.kind must be 'cancelled'"
                );
                break;
            }
        }
        let si_final = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(
            si_final.status,
            StageStatus::Failed,
            "stage must be Failed after cancel"
        );
        assert!(
            si_final.parked_reason.is_none(),
            "cancel must clear parked_reason"
        );
        assert!(
            si_final.parked_meta.is_none(),
            "cancel must clear parked_meta"
        );
        let meta = si_final.terminal_meta.expect("terminal_meta must be set");
        assert_eq!(meta["kind"], json!("cancelled"));

        // GET /parked must be empty after cancel.
        let app = crate::http::router(state.clone());
        let (status, body) = req(app, "GET", "/parked", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.as_array().unwrap().len(),
            0,
            "cancelled parked stage must not appear in GET /parked"
        );

        // Second cancel on the same run returns accepted=false (run is already terminal or stages gone).
        // Wait for run to reach terminal first.
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(&pool, &run_id)
                .await
                .unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                break;
            }
        }
        let app = crate::http::router(state.clone());
        let (status, body) = req(
            app,
            "POST",
            &format!("/workflow_runs/{}/cancel", run_id_str),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "second cancel body: {body}");
        assert_eq!(body["accepted"], json!(false));
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
        let ResumePayload::Executor {
            payload: deserialized_payload,
        } = deserialized
        else {
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
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "expected 404 for {} {}",
                method,
                uri
            );
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
        assert!(
            body["error"].as_str().is_some(),
            "error field must be present"
        );
    }

    #[tokio::test]
    async fn test_get_artifact_types_returns_registered_types_with_capabilities() {
        let state = make_state(vec![]).await;
        let app = crate::http::router(state);

        let (status, body) = req(app, "GET", "/artifact_types", None).await;
        assert_eq!(status, StatusCode::OK);

        let types = body.as_array().expect("response must be an array");
        assert_eq!(types.len(), 1, "one artifact type registered in test state");

        let entry = &types[0];
        assert_eq!(entry["id"], "any");
        assert_eq!(entry["component_id"], "v");

        let caps = &entry["capabilities"];
        assert!(caps.is_object(), "capabilities must be an object");
        assert!(caps["reviewable"].is_boolean());
        assert!(caps["commentable"].is_boolean());
        assert!(caps["atom_editable"].is_boolean());
        assert!(caps["review_items"].is_boolean());

        // anchor_schema is present (may be null for types without one)
        assert!(
            entry.get("anchor_schema").is_some(),
            "anchor_schema field must be present"
        );
    }
}
