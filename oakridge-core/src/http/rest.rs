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
use crate::executor::ResumePayload;
use crate::types::{
    Artifact, ArtifactId, GateDecision, Project, ProjectId, RunStatus, StageInstance,
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

#[derive(Deserialize)]
pub struct VerbResult {
    pub stage_instance_id: StageInstanceId,
    pub against_artifact_id: ArtifactId,
    pub decision: GateDecision,
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
    state.coordinator.start_run(run.id).await?;

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

// ── VerbResults handler ───────────────────────────────────────────────────────

pub async fn post_verb_results(
    State(state): State<AppState>,
    Json(body): Json<VerbResult>,
) -> Result<(StatusCode, Json<StageInstance>), AppError> {
    let si = queries::get_stage_instance_by_id(&state.pool, &body.stage_instance_id).await?;

    if si.status != StageStatus::Parked {
        return Err(AppError::Conflict(format!(
            "stage instance {} is not parked (status: {:?})",
            si.id.0, si.status
        )));
    }

    // Known race: the parked check above and the deliver_decision call below are not
    // atomic. A concurrent request (or a cancellation) can advance the stage out of
    // Parked between the SELECT and the control-channel send. The duplicate caller
    // will receive 202 even though the decision may be silently dropped, or a 409 if
    // the run has since gone inactive. Making this atomic requires moving the guard
    // into the Coordinator (cohort 5 scope); for now the window is small and the
    // consequence is a no-op resume, not data corruption.
    state
        .coordinator
        .deliver_decision(
            si.run_id,
            body.stage_instance_id,
            ResumePayload::GateDecision {
                decision: body.decision,
                against_artifact_id: body.against_artifact_id,
            },
        )
        .await
        // run no longer active / control channel closed are stale-state conflicts, not 500s
        .map_err(|e| AppError::Conflict(e.to_string()))?;

    Ok((StatusCode::ACCEPTED, Json(si)))
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
    use crate::types::WorkflowGraph;
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

    async fn make_state(
        stage_types: Vec<Arc<dyn crate::registry::stage_type::StageType>>,
    ) -> AppState {
        let path = format!("/tmp/oakridge_http_{}.db", Uuid::new_v4());
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

        AppState { pool, stage_registry, artifact_registry, coordinator, bus }
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

        // POST /verb_results
        let app = crate::http::router(state.clone());
        let (status, _) = req(
            app,
            "POST",
            "/verb_results",
            Some(json!({
                "stage_instance_id": si_id.0.to_string(),
                "against_artifact_id": artifact_id.0.to_string(),
                "decision": {"outcome": "pass", "comment": null, "feedback": null}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);

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
}
