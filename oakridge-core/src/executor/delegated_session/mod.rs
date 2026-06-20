pub mod config;
pub mod kbbl_client;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
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

pub struct DelegatedSessionStage {
    pub prompts_dir: PathBuf,
    pub kbbl_client: Arc<KbblClient>,
    live_sessions: Arc<Mutex<HashMap<StageInstanceId, LiveSession>>>,
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
struct LiveSession {
    cancelled: Arc<AtomicBool>,
}

struct DelegatedSessionHandle {
    stage_instance_id: StageInstanceId,
    sid: String,
    kbbl_client: Arc<KbblClient>,
    live_sessions: Arc<Mutex<HashMap<StageInstanceId, LiveSession>>>,
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

    fn insert_live_session(&self, stage_instance_id: StageInstanceId) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live_sessions.lock().unwrap().insert(
            stage_instance_id,
            LiveSession {
                cancelled: cancelled.clone(),
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

        if config.yolo {
            if let Err(err) = self.apply_yolo(&sid).await {
                self.cleanup_live_session(stage_instance_id, &sid, None)
                    .await;
                return Err(err);
            }
        }

        if created_session {
            if let Err(err) = self
                .send_initial_prompt(&sid, &config.rendered_prompt)
                .await
            {
                self.cleanup_live_session(stage_instance_id, &sid, None)
                    .await;
                return Err(err);
            }
        }

        let cancelled = self.insert_live_session(stage_instance_id);

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

        if let Err(err) = ctx.set_status(StageStatus::Running, None).await {
            self.cleanup_live_session(stage_instance_id, &sid, Some(&cancelled))
                .await;
            return Err(err);
        }

        Ok(Box::new(DelegatedSessionHandle {
            stage_instance_id,
            sid,
            kbbl_client: self.kbbl_client.clone(),
            live_sessions: self.live_sessions.clone(),
        }))
    }
}

#[async_trait]
impl StageHandle for DelegatedSessionHandle {
    async fn resume(&self, _payload: crate::executor::ResumePayload) -> anyhow::Result<()> {
        anyhow::bail!("delegated_session does not accept resume payloads")
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

fn latest_event_id(events: &[kbbl_client::SessionEvent]) -> Option<i64> {
    events.iter().map(|event| event.id as i64).max().or(None)
}

fn failure_reason_from_events(sid: &str, events: &[kbbl_client::SessionEvent]) -> Option<String> {
    events
        .iter()
        .find_map(|event| match event.event_type.as_str() {
            "runtime-error" => Some(format!("kbbl session {} emitted runtime-error", sid)),
            "subprocess_exited" | "session-ended" | "ended" => {
                Some(format!("kbbl session {} ended unexpectedly", sid))
            }
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::executor::ExecutorEvent;
    use crate::registry::ArtifactTypeRegistry;
    use crate::types::{
        RunStatus, StageInstance, StageKey, WorkflowDef, WorkflowDefId, WorkflowGraph, WorkflowRun,
        WorkflowRunId,
    };
    use axum::{
        extract::{OriginalUri, State},
        http::{Method, StatusCode},
        response::IntoResponse,
        routing::{delete, get, post},
        Json, Router,
    };
    use serde_json::json;
    use std::collections::VecDeque;
    use tokio::net::TcpListener;
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

    #[test]
    fn delegated_session_stage_id_is_stable() {
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        assert_eq!(stage.id(), "delegated_session");
    }

    #[test]
    fn latest_event_id_ignores_empty_batches() {
        assert_eq!(latest_event_id(&[]), None);
    }

    #[test]
    fn failure_reason_treats_subprocess_exit_as_terminal_failure() {
        let events = vec![kbbl_client::SessionEvent {
            id: 7,
            event_type: "subprocess_exited".into(),
            ts: "2026-01-01T00:00:00Z".into(),
            payload: json!({}),
        }];

        let reason = failure_reason_from_events("sid-123", &events).unwrap();
        assert!(reason.contains("sid-123"));
        assert!(reason.contains("ended unexpectedly"));
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
}
