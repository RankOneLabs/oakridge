pub mod config;
pub mod kbbl_client;
pub mod routes;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::{sleep, Duration};
use tracing::{debug, warn};

use crate::executor::prompt_config::{load_template, render_template, resolve_binding};
use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId, StageStatus};

use config::{DelegatedSessionConfig, DelegatedSessionDefConfig};
use kbbl_client::{
    AckResponse, CreateSessionRequest, EventsSinceResponse, KbblClient, SendInputRequest,
    SetYoloRequest,
};

const STAGE_INSTANCE_ID_SENTINEL: &str = "{{STAGE_INSTANCE_ID}}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegatedGate {
    ArtifactApproval,
    MergeConfirmation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegatedExecutor {
    DelegatedSession,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DelegatedGateState {
    pub executor: DelegatedExecutor,
    pub kbbl_sid: String,
    pub gate: DelegatedGate,
    pub artifact_id: crate::types::ArtifactId,
    pub revision_count: u32,
}

impl DelegatedGateState {
    pub fn artifact_approval(
        kbbl_sid: String,
        artifact_id: crate::types::ArtifactId,
        revision_count: u32,
    ) -> Self {
        Self {
            executor: DelegatedExecutor::DelegatedSession,
            kbbl_sid,
            gate: DelegatedGate::ArtifactApproval,
            artifact_id,
            revision_count,
        }
    }
}

fn revision_count_from_meta(meta: Option<&Value>) -> u32 {
    meta.and_then(|meta| serde_json::from_value::<DelegatedGateState>(meta.clone()).ok())
        .map(|state| state.revision_count)
        .unwrap_or(1)
}

pub struct DelegatedSessionStage {
    pub prompts_dir: PathBuf,
    pub kbbl_client: Arc<KbblClient>,
    live_sessions: LiveSessions,
}

impl DelegatedSessionStage {
    pub fn new(prompts_dir: PathBuf, kbbl_client: KbblClient) -> Self {
        Self {
            prompts_dir,
            kbbl_client: Arc::new(kbbl_client),
            live_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone)]
pub(crate) struct LiveSession {
    pub cancelled: Arc<AtomicBool>,
    pub ctx: StageContext,
    pub sid: String,
    pub config: DelegatedSessionConfig,
}

pub(crate) type LiveSessions = Arc<Mutex<HashMap<StageInstanceId, LiveSession>>>;

struct DelegatedSessionHandle {
    stage_instance_id: StageInstanceId,
    sid: String,
    kbbl_client: Arc<KbblClient>,
    live_sessions: LiveSessions,
}

impl DelegatedSessionStage {
    async fn create_session(
        &self,
        config: &DelegatedSessionConfig,
        ctx: &StageContext,
    ) -> anyhow::Result<String> {
        let snapshot = self
            .kbbl_client
            .create_session(CreateSessionRequest {
                workdir: config.workdir.display().to_string(),
                name: config.session_name.clone(),
                artifact_id: ctx.stage_instance_id.0.to_string(),
                runtime: config.runtime.clone(),
                model: config.model.clone(),
            })
            .await?;

        if let Err(err) = ctx.set_external_ref(Some(snapshot.sid.clone())).await {
            self.cleanup_live_session(ctx.stage_instance_id, &snapshot.sid, None)
                .await;
            return Err(err);
        }
        Ok(snapshot.sid)
    }

    async fn probe_live_session(&self, sid: &str) -> anyhow::Result<Option<i64>> {
        let response = self.kbbl_client.read_events_since(sid, -1).await?;
        self.ensure_observable(sid, &response)?;
        Ok(latest_event_id(&response.events))
    }

    fn ensure_observable(&self, sid: &str, response: &EventsSinceResponse) -> anyhow::Result<()> {
        if response.session_id != sid {
            anyhow::bail!(
                "substrate recovery error: kbbl responded for session '{}' instead of '{}'",
                response.session_id,
                sid
            );
        }

        if let Some(reason) = failure_reason_from_events(sid, &response.events) {
            anyhow::bail!("substrate recovery error: {}", reason);
        }

        Ok(())
    }

    async fn send_initial_prompt(&self, sid: &str, prompt: &str) -> anyhow::Result<()> {
        Ok(self
            .kbbl_client
            .send_input(
                sid,
                SendInputRequest {
                    text: prompt.to_owned(),
                },
            )
            .await
            .map(|_: AckResponse| ())?)
    }

    async fn apply_yolo(&self, sid: &str) -> anyhow::Result<()> {
        Ok(self
            .kbbl_client
            .set_yolo(sid, SetYoloRequest { enabled: true })
            .await
            .map(|_: AckResponse| ())?)
    }

    fn insert_live_session(
        &self,
        stage_instance_id: StageInstanceId,
        ctx: StageContext,
        sid: String,
        config: DelegatedSessionConfig,
    ) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live_sessions.lock().unwrap().insert(
            stage_instance_id,
            LiveSession {
                cancelled: cancelled.clone(),
                ctx,
                sid,
                config,
            },
        );
        cancelled
    }

    async fn cleanup_live_session(
        &self,
        stage_instance_id: StageInstanceId,
        sid: &str,
        cancelled: Option<&Arc<AtomicBool>>,
    ) {
        if let Some(cancelled) = cancelled {
            cancelled.store(true, Ordering::SeqCst);
        }
        self.live_sessions
            .lock()
            .unwrap()
            .remove(&stage_instance_id);
        if let Err(err) = self.kbbl_client.stop_session(sid).await {
            warn!(stage_instance_id = %stage_instance_id.0, sid, "best-effort kbbl stop failed: {}", err);
        }
    }

    fn spawn_observer(
        &self,
        ctx: StageContext,
        stage_instance_id: StageInstanceId,
        sid: String,
        cancelled: Arc<AtomicBool>,
        mut last_seen: i64,
    ) {
        let client = self.kbbl_client.clone();
        let live_sessions = self.live_sessions.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(5)).await;
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }

                match client.read_events_since(&sid, last_seen).await {
                    Ok(response) => {
                        if response.session_id != sid {
                            if !cancelled.load(Ordering::SeqCst) {
                                let _ = ctx
                                    .set_status(
                                        StageStatus::Failed,
                                        Some(format!("kbbl session {} became unavailable", sid)),
                                    )
                                    .await;
                            }
                            break;
                        }

                        if let Some(reason) = failure_reason_from_events(&sid, &response.events) {
                            if !cancelled.load(Ordering::SeqCst) {
                                let _ = ctx.set_status(StageStatus::Failed, Some(reason)).await;
                            }
                            break;
                        }

                        if let Some(new_last_seen) = latest_event_id(&response.events) {
                            last_seen = new_last_seen;
                        }
                    }
                    Err(err) => {
                        if !cancelled.load(Ordering::SeqCst) {
                            let _ = ctx
                                .set_status(
                                    StageStatus::Failed,
                                    Some(format!(
                                        "kbbl session {} became unavailable: {}",
                                        sid, err
                                    )),
                                )
                                .await;
                        }
                        break;
                    }
                }
            }

            live_sessions.lock().unwrap().remove(&stage_instance_id);
        });
    }
}

#[async_trait]
impl StageType for DelegatedSessionStage {
    fn id(&self) -> &str {
        "delegated_session"
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, Artifact>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: DelegatedSessionDefConfig = serde_json::from_value(def_config.clone())?;
        let template = load_template(&self.prompts_dir, &def.prompt_template_path)?;

        let mut slot_values: HashMap<String, String> = HashMap::new();
        for (slot_name, binding) in &def.slot_bindings {
            slot_values.insert(
                slot_name.clone(),
                resolve_binding(binding, inputs, run_context)?,
            );
        }
        slot_values.insert(
            "STAGE_INSTANCE_ID".to_owned(),
            stage_instance_id.0.to_string(),
        );

        let rendered_prompt = render_template(&template, &slot_values)?;
        let sid_str = stage_instance_id.0.to_string();
        let workdir_str = resolve_binding(&def.workdir, inputs, run_context)?
            .replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str);

        let config = DelegatedSessionConfig {
            runtime: def.runtime,
            rendered_prompt,
            workdir: PathBuf::from(workdir_str),
            session_name: def
                .session_name
                .replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str),
            model: def.model,
            pre_authorized_tools: def.pre_authorized_tools,
            yolo: def.yolo,
            output_slots: output_slots.to_vec(),
        };

        Ok(serde_json::to_value(config)?)
    }

    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let config: DelegatedSessionConfig = serde_json::from_value(ctx.config.clone())?;
        if !config.pre_authorized_tools.is_empty() {
            warn!(
                stage_instance_id = %ctx.stage_instance_id.0,
                tools = ?config.pre_authorized_tools,
                "pre_authorized_tools ignored by kbbl delegated session"
            );
        }

        let summary = ctx.stage_instance_summary();
        let recovered_parked = matches!(summary.status, StageStatus::Parked);
        let stage_instance_id = ctx.stage_instance_id;
        let mut created_session = false;

        let mut recovery_last_seen = -1;
        let sid = match summary.external_ref.clone() {
            Some(existing_sid) => {
                if let Some(last_seen) = self.probe_live_session(&existing_sid).await? {
                    recovery_last_seen = last_seen;
                }
                existing_sid
            }
            None => {
                created_session = true;
                self.create_session(&config, &ctx).await?
            }
        };

        let cancelled = self.insert_live_session(
            stage_instance_id,
            ctx.clone(),
            sid.clone(),
            config.clone(),
        );

        if !recovered_parked {
            if let Err(err) = ctx.set_status(StageStatus::Running, None).await {
                self.cleanup_live_session(stage_instance_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        if config.yolo {
            if let Err(err) = self.apply_yolo(&sid).await {
                self.cleanup_live_session(stage_instance_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        if created_session {
            if let Err(err) = self
                .send_initial_prompt(&sid, &config.rendered_prompt)
                .await
            {
                self.cleanup_live_session(stage_instance_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        self.spawn_observer(
            ctx.clone(),
            stage_instance_id,
            sid.clone(),
            cancelled.clone(),
            if created_session {
                -1
            } else {
                recovery_last_seen
            },
        );

        Ok(Box::new(DelegatedSessionHandle {
            stage_instance_id,
            sid,
            kbbl_client: self.kbbl_client.clone(),
            live_sessions: self.live_sessions.clone(),
        }))
    }

    fn http_routes(&self) -> Option<axum::Router> {
        Some(routes::emit_routes(
            self.kbbl_client.clone(),
            self.live_sessions.clone(),
        ))
    }
}

#[async_trait]
impl StageHandle for DelegatedSessionHandle {
    async fn resume(&self, payload: crate::executor::ResumePayload) -> anyhow::Result<()> {
        match payload {
            crate::executor::ResumePayload::GateDecision {
                decision,
                against_artifact_id,
            } => {
                self.resume_gate_decision(decision, against_artifact_id)
                    .await
            }
            crate::executor::ResumePayload::FeedbackArtifact { artifact } => {
                self.resume_feedback_artifact(artifact).await
            }
            crate::executor::ResumePayload::Executor { .. } => {
                anyhow::bail!(
                    "delegated approval forwarding is not enabled until K1 exists"
                )
            }
        }
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        let cancelled = {
            let mut live_sessions = self.live_sessions.lock().unwrap();
            live_sessions
                .remove(&self.stage_instance_id)
                .map(|session| session.cancelled)
        };
        if let Some(cancelled) = cancelled {
            cancelled.store(true, Ordering::SeqCst);
        }
        if let Err(err) = self.kbbl_client.stop_session(&self.sid).await {
            debug!(
                stage_instance_id = %self.stage_instance_id.0,
                sid = %self.sid,
                "best-effort kbbl stop during cancel failed: {}",
                err
            );
        }
        Ok(())
    }
}

impl DelegatedSessionHandle {
    fn live_session(&self) -> anyhow::Result<LiveSession> {
        self.live_sessions
            .lock()
            .unwrap()
            .get(&self.stage_instance_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("stage not live"))
    }

    fn parked_gate_state(&self, session: &LiveSession) -> anyhow::Result<DelegatedGateState> {
        let summary = session.ctx.stage_instance_summary();
        let meta = summary
            .parked_meta
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("delegated session is missing parked gate state"))?;
        serde_json::from_value(meta.clone())
            .map_err(|err| anyhow::anyhow!("invalid delegated gate state: {}", err))
    }

    fn follow_up_message(
        &self,
        decision: &crate::types::GateDecision,
        gate_state: &DelegatedGateState,
    ) -> String {
        if let Some(feedback) = decision
            .feedback
            .as_ref()
            .filter(|feedback| !feedback.trim().is_empty())
        {
            return feedback.trim().to_string();
        }
        if let Some(comment) = decision
            .comment
            .as_ref()
            .filter(|comment| !comment.trim().is_empty())
        {
            return comment.trim().to_string();
        }
        format!(
            "Gate decision on artifact {}: {:?}",
            gate_state.artifact_id.0, decision.outcome
        )
    }

    async fn send_kbbl_input(&self, sid: &str, text: String) -> anyhow::Result<()> {
        self.kbbl_client
            .send_input(sid, SendInputRequest { text })
            .await
            .map(|_: AckResponse| ())
            .map_err(|err| anyhow::anyhow!(err))
    }

    async fn resume_feedback_artifact(&self, artifact: Artifact) -> anyhow::Result<()> {
        let session = self.live_session()?;
        let pretty_body =
            serde_json::to_string_pretty(&artifact.body).unwrap_or_else(|_| artifact.body.to_string());
        let text = format!(
            "Feedback artifact {} (type {}):\n{}",
            artifact.id.0, artifact.artifact_type, pretty_body
        );
        self.send_kbbl_input(&session.sid, text).await
    }

    async fn resume_gate_decision(
        &self,
        decision: crate::types::GateDecision,
        against_artifact_id: crate::types::ArtifactId,
    ) -> anyhow::Result<()> {
        let session = self.live_session()?;
        let gate_state = self.parked_gate_state(&session)?;
        if gate_state.artifact_id != against_artifact_id {
            anyhow::bail!(
                "gate decision artifact {} does not match parked artifact {}",
                against_artifact_id.0,
                gate_state.artifact_id.0
            );
        }

        match gate_state.gate {
            DelegatedGate::ArtifactApproval => {
                self.resume_artifact_approval(session, gate_state, decision)
                    .await
            }
            DelegatedGate::MergeConfirmation => {
                self.resume_merge_confirmation(session, gate_state, decision)
                    .await
            }
        }
    }

    async fn resume_artifact_approval(
        &self,
        session: LiveSession,
        gate_state: DelegatedGateState,
        decision: crate::types::GateDecision,
    ) -> anyhow::Result<()> {
        match decision.outcome {
            crate::types::GateOutcome::Pass => {
                let updated_state = DelegatedGateState {
                    gate: DelegatedGate::MergeConfirmation,
                    ..gate_state
                };
                session
                    .ctx
                    .set_parked_meta(Some(serde_json::to_value(&updated_state)?))
                    .await?;
                Ok(())
            }
            crate::types::GateOutcome::Fail | crate::types::GateOutcome::Rerun => {
                let follow_up = self.follow_up_message(&decision, &gate_state);
                self.send_kbbl_input(&session.sid, follow_up).await?;
                let updated_state = DelegatedGateState {
                    revision_count: gate_state.revision_count.saturating_add(1),
                    ..gate_state
                };
                session
                    .ctx
                    .set_parked_meta(Some(serde_json::to_value(&updated_state)?))
                    .await?;
                session.ctx.set_status(StageStatus::Running, None).await?;
                Ok(())
            }
        }
    }

    async fn resume_merge_confirmation(
        &self,
        session: LiveSession,
        _gate_state: DelegatedGateState,
        decision: crate::types::GateDecision,
    ) -> anyhow::Result<()> {
        match decision.outcome {
            crate::types::GateOutcome::Pass => {
                session.ctx.set_status(StageStatus::Done, None).await?;
                let _ = session.ctx.set_parked_meta(None).await;
                session.cancelled.store(true, Ordering::SeqCst);
                self.live_sessions
                    .lock()
                    .unwrap()
                    .remove(&self.stage_instance_id);
                if let Err(err) = self.kbbl_client.stop_session(&session.sid).await {
                    debug!(
                        stage_instance_id = %self.stage_instance_id.0,
                        sid = %session.sid,
                        "best-effort kbbl stop after merge confirmation failed: {}",
                        err
                    );
                }
                Ok(())
            }
            crate::types::GateOutcome::Fail | crate::types::GateOutcome::Rerun => {
                anyhow::bail!("merge confirmation only accepts pass decisions")
            }
        }
    }
}

fn latest_event_id(events: &[kbbl_client::SessionEvent]) -> Option<i64> {
    events.iter().map(|event| event.id as i64).max().or(None)
}

fn failure_reason_from_events(sid: &str, events: &[kbbl_client::SessionEvent]) -> Option<String> {
    events
        .iter()
        .find_map(|event| match event.event_type.as_str() {
            "runtime_error" | "runtime-error" => {
                Some(format!("kbbl session {} emitted runtime_error", sid))
            }
            "subprocess_exited" => event
                .payload
                .get("code")
                .and_then(|code| code.as_i64())
                .filter(|code| *code != 0)
                .map(|code| {
                    format!(
                        "kbbl session {} exited unexpectedly with code {}",
                        sid, code
                    )
                }),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::executor::{ExecutorEvent, ResumePayload};
    use crate::registry::{ArtifactTypeDef, ArtifactTypeRegistry};
    use crate::types::{
        ArtifactId, GateDecision, GateOutcome, RunStatus, StageInstance, StageKey, WorkflowDef,
        WorkflowDefId, WorkflowGraph, WorkflowRun, WorkflowRunId,
    };
    use axum::{
        body::Body,
        extract::{OriginalUri, State},
        http::{Method, Request, StatusCode},
        response::IntoResponse,
        routing::{delete, get, post},
        Json, Router,
    };
    use serde_json::json;
    use std::collections::VecDeque;
    use tokio::net::TcpListener;
    use tower::ServiceExt;
    use uuid::Uuid;

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct RecordedRequest {
        method: Method,
        path: String,
        body: Option<serde_json::Value>,
    }

    #[derive(Clone)]
    struct TestState {
        capture: Arc<Mutex<VecDeque<RecordedRequest>>>,
    }

    fn capture_request(
        capture: &Arc<Mutex<VecDeque<RecordedRequest>>>,
        method: Method,
        path: String,
        body: Option<serde_json::Value>,
    ) {
        capture
            .lock()
            .unwrap()
            .push_back(RecordedRequest { method, path, body });
    }

    async fn capture_create(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        (
            StatusCode::CREATED,
            Json(serde_json::json!({ "sid": "sid-123" })),
        )
    }

    async fn capture_post(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        Json(serde_json::json!({ "ok": true }))
    }

    async fn capture_events(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
    ) -> impl IntoResponse {
        capture_request(&state.capture, Method::GET, uri.to_string(), None);
        Json(serde_json::json!({
            "session_id": "sid-123",
            "events": []
        }))
    }

    async fn capture_delete(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
    ) -> impl IntoResponse {
        capture_request(&state.capture, Method::DELETE, uri.path().to_string(), None);
        Json(serde_json::json!({ "ok": true, "removed": true }))
    }

    async fn spawn_kbbl_mock() -> (
        String,
        Arc<Mutex<VecDeque<RecordedRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let capture = Arc::new(Mutex::new(VecDeque::new()));
        let state = TestState {
            capture: capture.clone(),
        };
        let app = Router::new()
            .route("/sessions", post(capture_create))
            .route("/:sid/input", post(capture_post))
            .route("/:sid/yolo", post(capture_post))
            .route("/:sid/events", get(capture_events))
            .route("/sessions/:sid", delete(capture_delete))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/"), capture, join)
    }

    async fn make_pool() -> Arc<sqlx::SqlitePool> {
        let path = format!("/tmp/oakridge_delegated_session_{}.db", Uuid::new_v4());
        Arc::new(
            crate::db::init_pool(&format!("sqlite:{}", path))
                .await
                .unwrap(),
        )
    }

    fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    async fn setup_stage_instance(
        pool: &sqlx::SqlitePool,
        config: Value,
        external_ref: Option<String>,
    ) -> (WorkflowRunId, StageInstanceId) {
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: std::collections::HashMap::new(),
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        queries::insert_workflow_def(pool, &def).await.unwrap();

        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_workflow_run(pool, &run).await.unwrap();

        let si = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: StageKey::from("delegate"),
            stage_type: "delegated_session".into(),
            status: crate::types::StageStatus::Pending,
            config,
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref,
            started_at: None,
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(pool, &si).await.unwrap();
        (run.id, si.id)
    }

    fn delegated_config_json(prompt: &str, workdir: &str, yolo: bool) -> Value {
        json!({
            "runtime": "codex",
            "rendered_prompt": prompt,
            "workdir": workdir,
            "session_name": "delegate",
            "model": null,
            "pre_authorized_tools": [],
            "yolo": yolo,
            "output_slots": []
        })
    }

    fn delegated_config_json_with_outputs(
        prompt: &str,
        workdir: &str,
        yolo: bool,
        output_slots: Vec<OutputSlot>,
    ) -> Value {
        json!({
            "runtime": "codex",
            "rendered_prompt": prompt,
            "workdir": workdir,
            "session_name": "delegate",
            "model": null,
            "pre_authorized_tools": [],
            "yolo": yolo,
            "output_slots": output_slots
        })
    }

    fn make_text_artifact_registry() -> Arc<ArtifactTypeRegistry> {
        let mut registry = ArtifactTypeRegistry::new();
        registry.register(ArtifactTypeDef {
            id: "text".into(),
            validate: |_| Ok(()),
            component_id: "text-viewer".into(),
        });
        Arc::new(registry)
    }

    #[test]
    fn delegated_session_stage_id_is_stable() {
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        assert_eq!(stage.id(), "delegated_session");
    }

    #[test]
    fn delegated_gate_state_roundtrip() {
        let state = DelegatedGateState {
            executor: DelegatedExecutor::DelegatedSession,
            kbbl_sid: "sid-123".into(),
            gate: DelegatedGate::ArtifactApproval,
            artifact_id: crate::types::ArtifactId(Uuid::new_v4()),
            revision_count: 3,
        };

        let value = serde_json::to_value(&state).unwrap();
        let back: DelegatedGateState = serde_json::from_value(value).unwrap();
        assert_eq!(state, back);
    }

    #[test]
    fn latest_event_id_ignores_empty_batches() {
        assert_eq!(latest_event_id(&[]), None);
    }

    #[test]
    fn failure_reason_ignores_clean_subprocess_exit() {
        let events = vec![kbbl_client::SessionEvent {
            id: 7,
            event_type: "subprocess_exited".into(),
            ts: "2026-01-01T00:00:00Z".into(),
            payload: json!({ "code": 0, "reason": "completed" }),
        }];

        assert_eq!(failure_reason_from_events("sid-123", &events), None);
    }

    #[test]
    fn failure_reason_treats_non_zero_subprocess_exit_as_terminal_failure() {
        let events = vec![kbbl_client::SessionEvent {
            id: 7,
            event_type: "subprocess_exited".into(),
            ts: "2026-01-01T00:00:00Z".into(),
            payload: json!({ "code": 17 }),
        }];

        let reason = failure_reason_from_events("sid-123", &events).unwrap();
        assert!(reason.contains("sid-123"));
        assert!(reason.contains("17"));
    }

    #[test]
    fn failure_reason_treats_runtime_error_as_terminal_failure() {
        let events = vec![kbbl_client::SessionEvent {
            id: 8,
            event_type: "runtime_error".into(),
            ts: "2026-01-01T00:00:00Z".into(),
            payload: json!({}),
        }];

        let reason = failure_reason_from_events("sid-123", &events).unwrap();
        assert!(reason.contains("sid-123"));
        assert!(reason.contains("runtime_error"));
    }

    #[tokio::test]
    async fn build_config_substitutes_stage_instance_and_carries_outputs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("delegated.md"),
            "Task {{TASK}} for {{STAGE_INSTANCE_ID}}",
        )
        .unwrap();

        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );

        let def_config = json!({
            "runtime": "codex",
            "prompt_template_path": "delegated.md",
            "slot_bindings": {
                "TASK": {"from": "literal", "value": "build"}
            },
            "workdir": {"from": "literal", "value": "/work/{{STAGE_INSTANCE_ID}}"},
            "session_name": "session-{{STAGE_INSTANCE_ID}}",
            "model": "gpt-4.1",
            "pre_authorized_tools": ["Bash"],
            "yolo": true
        });
        let stage_instance_id =
            StageInstanceId(uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000042").unwrap());
        let output_slots = vec![OutputSlot {
            name: "out".into(),
            artifact_type: "text".into(),
        }];

        let config = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                stage_instance_id,
                &json!({}),
            )
            .await
            .unwrap();

        let cfg: DelegatedSessionConfig = serde_json::from_value(config).unwrap();
        assert_eq!(cfg.runtime, config::DelegatedRuntime::Codex);
        assert!(cfg.rendered_prompt.contains("build"));
        assert!(cfg
            .rendered_prompt
            .contains("00000000-0000-0000-0000-000000000042"));
        assert_eq!(
            cfg.workdir,
            PathBuf::from("/work/00000000-0000-0000-0000-000000000042")
        );
        assert_eq!(
            cfg.session_name,
            "session-00000000-0000-0000-0000-000000000042"
        );
        assert_eq!(cfg.output_slots, output_slots);
        assert_eq!(cfg.pre_authorized_tools, vec!["Bash".to_string()]);
        assert!(cfg.yolo);
    }

    #[tokio::test]
    async fn execute_creates_session_persists_external_ref_and_sends_prompt() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello world", "/workdir", true),
            None,
        )
        .await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let stage =
            DelegatedSessionStage::new(PathBuf::from("/tmp"), KbblClient::new(base_url).unwrap());
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: None,
            },
            delegated_config_json("hello world", "/workdir", true),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        let handle = stage.execute(ctx.clone()).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            event,
            ExecutorEvent::StatusChanged {
                status: crate::types::StageStatus::Running,
                ..
            }
        ));

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.external_ref.as_deref(), Some("sid-123"));
        assert_eq!(si.status, crate::types::StageStatus::Running);

        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            requests,
            vec![
                RecordedRequest {
                    method: Method::POST,
                    path: "/sessions".into(),
                    body: Some(json!({
                        "workdir": "/workdir",
                        "name": "delegate",
                        "artifact_id": si_id.0.to_string(),
                        "runtime": "codex",
                        "model": null
                    })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/yolo".into(),
                    body: Some(json!({ "enabled": true })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": "hello world" })),
                },
            ]
        );

        handle.cancel().await.unwrap();
        join.abort();
    }

    #[tokio::test]
    async fn execute_reuses_live_session_when_external_ref_exists() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (_, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello again", "/workdir", false),
            Some("sid-123".into()),
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage =
            DelegatedSessionStage::new(PathBuf::from("/tmp"), KbblClient::new(base_url).unwrap());
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: queries::get_stage_instance_by_id(&pool, &si_id)
                    .await
                    .unwrap()
                    .run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: Some("sid-123".into()),
            },
            delegated_config_json("hello again", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        let _handle = stage.execute(ctx).await.unwrap();
        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.external_ref.as_deref(), Some("sid-123"));

        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            requests,
            vec![RecordedRequest {
                method: Method::GET,
                path: "/sid-123/events?since=-1".into(),
                body: None,
            },]
        );

        join.abort();
    }

    #[tokio::test]
    async fn cancel_best_effort_stops_kbbl_session() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("stop me", "/workdir", false),
            None,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage =
            DelegatedSessionStage::new(PathBuf::from("/tmp"), KbblClient::new(base_url).unwrap());
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: None,
            },
            delegated_config_json("stop me", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        let handle = stage.execute(ctx).await.unwrap();
        handle.cancel().await.unwrap();

        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert!(requests
            .iter()
            .any(|req| req.method == Method::DELETE && req.path == "/sessions/sid-123"));

        join.abort();
    }

    #[tokio::test]
    async fn emit_route_parks_stage_with_artifact_approval_gate_state() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json_with_outputs(
                "hello artifact",
                "/workdir",
                false,
                vec![OutputSlot {
                    name: "out".into(),
                    artifact_type: "text".into(),
                }],
            ),
            None,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new(base_url).unwrap(),
        );
        let artifact_types = make_text_artifact_registry();
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: None,
            },
            delegated_config_json_with_outputs(
                "hello artifact",
                "/workdir",
                false,
                vec![OutputSlot {
                    name: "out".into(),
                    artifact_type: "text".into(),
                }],
            ),
            HashMap::new(),
            tx,
            pool.clone(),
            artifact_types,
        );

        let _handle = stage.execute(ctx).await.unwrap();
        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"draft"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artifact_id = payload["artifact_id"].as_str().unwrap().to_string();
        assert!(!artifact_id.is_empty());

        let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
        assert_eq!(si.status, crate::types::StageStatus::Parked);
        assert_eq!(si.parked_reason.as_deref(), Some("waiting_gate"));
        let meta: DelegatedGateState = serde_json::from_value(si.parked_meta.clone().unwrap())
            .unwrap();
        assert_eq!(meta.executor, DelegatedExecutor::DelegatedSession);
        assert_eq!(meta.kbbl_sid, "sid-123");
        assert_eq!(meta.gate, DelegatedGate::ArtifactApproval);
        assert_eq!(meta.revision_count, 1);
        assert_eq!(meta.artifact_id.0.to_string(), artifact_id);

        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            requests,
            vec![
                RecordedRequest {
                    method: Method::POST,
                    path: "/sessions".into(),
                    body: Some(json!({
                        "workdir": "/workdir",
                        "name": "delegate",
                        "artifact_id": si_id.0.to_string(),
                        "runtime": "codex",
                        "model": null
                    })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": "hello artifact" })),
                },
            ]
        );

        join.abort();
    }

    #[tokio::test]
    async fn resume_feedback_artifact_forwards_body_to_kbbl_input() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello feedback", "/workdir", false),
            None,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new(base_url).unwrap(),
        );
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: None,
            },
            delegated_config_json("hello feedback", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        let handle = stage.execute(ctx).await.unwrap();
        let artifact = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id,
            stage_instance_id: si_id,
            artifact_type: "text".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!({"feedback": "revise the second paragraph"}),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };

        let expected_text = format!(
            "Feedback artifact {} (type text):\n{{\n  \"feedback\": \"revise the second paragraph\"\n}}",
            artifact.id.0
        );
        handle
            .resume(ResumePayload::FeedbackArtifact { artifact })
            .await
            .unwrap();
        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            requests,
            vec![
                RecordedRequest {
                    method: Method::POST,
                    path: "/sessions".into(),
                    body: Some(json!({
                        "workdir": "/workdir",
                        "name": "delegate",
                        "artifact_id": si_id.0.to_string(),
                        "runtime": "codex",
                        "model": null
                    })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": "hello feedback" })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": expected_text })),
                },
            ]
        );

        handle.cancel().await.unwrap();
        join.abort();
    }

    #[tokio::test]
    async fn gate_decisions_progress_and_complete_kbbl_session() {
        let (base_url, capture, join) = spawn_kbbl_mock().await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json_with_outputs(
                "hello gate",
                "/workdir",
                false,
                vec![OutputSlot {
                    name: "out".into(),
                    artifact_type: "text".into(),
                }],
            ),
            None,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new(base_url).unwrap(),
        );
        let artifact_types = make_text_artifact_registry();
        let ctx = StageContext::new(
            crate::types::StageInstanceSummary {
                stage_instance_id: si_id,
                workflow_run_id: run_id,
                stage_key: "delegate".into(),
                status: crate::types::StageStatus::Pending,
                parked_reason: None,
                parked_meta: None,
                terminal_meta: None,
                external_ref: None,
            },
            delegated_config_json_with_outputs(
                "hello gate",
                "/workdir",
                false,
                vec![OutputSlot {
                    name: "out".into(),
                    artifact_type: "text".into(),
                }],
            ),
            HashMap::new(),
            tx,
            pool.clone(),
            artifact_types,
        );

        let handle = stage.execute(ctx).await.unwrap();
        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"draft"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artifact_id = ArtifactId(
            Uuid::parse_str(payload["artifact_id"].as_str().unwrap()).unwrap(),
        );

        handle
            .resume(ResumePayload::GateDecision {
                decision: GateDecision {
                    outcome: GateOutcome::Rerun,
                    comment: Some("needs more detail".into()),
                    feedback: Some("please revise the conclusion".into()),
                },
                against_artifact_id: artifact_id,
            })
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
        let meta: DelegatedGateState = serde_json::from_value(si.parked_meta.clone().unwrap())
            .unwrap();
        assert_eq!(meta.gate, DelegatedGate::ArtifactApproval);
        assert_eq!(meta.revision_count, 2);
        assert_eq!(si.status, crate::types::StageStatus::Running);

        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"revised"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artifact_id = ArtifactId(
            Uuid::parse_str(payload["artifact_id"].as_str().unwrap()).unwrap(),
        );

        handle
            .resume(ResumePayload::GateDecision {
                decision: GateDecision {
                    outcome: GateOutcome::Pass,
                    comment: None,
                    feedback: None,
                },
                against_artifact_id: artifact_id,
            })
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
        let meta: DelegatedGateState = serde_json::from_value(si.parked_meta.clone().unwrap())
            .unwrap();
        assert_eq!(meta.gate, DelegatedGate::MergeConfirmation);
        assert_eq!(si.status, crate::types::StageStatus::Parked);

        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"late"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
        let unchanged_meta: DelegatedGateState =
            serde_json::from_value(si.parked_meta.clone().unwrap()).unwrap();
        assert_eq!(unchanged_meta.gate, DelegatedGate::MergeConfirmation);
        assert_eq!(unchanged_meta.artifact_id, artifact_id);

        handle
            .resume(ResumePayload::GateDecision {
                decision: GateDecision {
                    outcome: GateOutcome::Pass,
                    comment: None,
                    feedback: None,
                },
                against_artifact_id: artifact_id,
            })
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id).await.unwrap();
        assert_eq!(si.status, crate::types::StageStatus::Done);
        assert!(si.parked_meta.is_none());

        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            requests,
            vec![
                RecordedRequest {
                    method: Method::POST,
                    path: "/sessions".into(),
                    body: Some(json!({
                        "workdir": "/workdir",
                        "name": "delegate",
                        "artifact_id": si_id.0.to_string(),
                        "runtime": "codex",
                        "model": null
                    })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": "hello gate" })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: "/sid-123/input".into(),
                    body: Some(json!({ "text": "please revise the conclusion" })),
                },
                RecordedRequest {
                    method: Method::DELETE,
                    path: "/sessions/sid-123".into(),
                    body: None,
                },
            ]
        );

        join.abort();
    }
}
