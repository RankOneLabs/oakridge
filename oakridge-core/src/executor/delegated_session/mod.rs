pub mod config;
pub mod kbbl_client;
pub mod routes;

use std::collections::{HashMap, HashSet};
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

use crate::executor::prompt_config::{
    load_template, render_template, resolve_binding, resolve_optional_binding, SlotBinding,
};
use crate::db::queries;
use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, InputSlot, OutputSlot, ResolvedInput, StageInstanceId, StageStatus};
use crate::types::{UnitStatus};

use config::{
    validate_effort, Bindable, DelegatedSessionConfig, DelegatedSessionDefConfig, FanOut,
    FanOutPromptPlan, WorktreeIdentity,
};
use kbbl_client::{
    AckResponse, CreateSessionRequest, DelegatedExternalRef, EventsSinceResponse, KbblClient,
    SendInputRequest, SessionSnapshot, SetYoloRequest,
};

const STAGE_INSTANCE_ID_SENTINEL: &str = "{{STAGE_INSTANCE_ID}}";

/// unit_id used when no fan_out config is present: single implicit unit.
const IMPLICIT_UNIT_ID: &str = "0";

/// A completely validated unit, ready to be persisted before session admission.
/// Keeping this separate from `SessionUnit` prevents partially valid graph data
/// from reaching the database.
#[derive(Debug, Clone, PartialEq)]
struct MaterializedFanOutUnit {
    unit_id: String,
    params: Value,
    depends_on: Vec<String>,
    rendered_prompt: String,
    worktree: Option<WorktreeIdentity>,
}

fn substitute_unit_template(template: &str, unit_id: &str, stage_instance_id: StageInstanceId) -> String {
    template
        .replace("{{UNIT_ID}}", unit_id)
        .replace(STAGE_INSTANCE_ID_SENTINEL, &stage_instance_id.0.to_string())
}

/// Validate and render the entire fan-out DAG without side effects.  This must
/// finish successfully before unit rows are written or kbbl sessions are made.
fn materialize_fan_out_units(
    config: &DelegatedSessionConfig,
    fan_out: &FanOut,
    stage_instance_id: StageInstanceId,
) -> anyhow::Result<Vec<MaterializedFanOutUnit>> {
    let over = config
        .resolved_fan_out_over
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("fan_out resolved input is missing from stage config"))?;
    let items = over
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("fan_out.over must resolve to a JSON array"))?;
    let prompt_plan = config
        .fan_out_prompt_plan
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("fan_out prompt plan is missing from stage config"))?;

    let mut units = Vec::with_capacity(items.len());
    let mut unit_ids = HashSet::with_capacity(items.len());
    for item in items {
        let unit_id = item
            .pointer(&fan_out.unit_id_path)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow::anyhow!("fan_out unit_id at '{}' must be a non-empty string", fan_out.unit_id_path))?
            .to_owned();
        if !unit_ids.insert(unit_id.clone()) {
            anyhow::bail!("fan_out unit_id '{}' is duplicated", unit_id);
        }

        let depends_on = match &fan_out.depends_on_path {
            None => Vec::new(),
            Some(path) => item
                .pointer(path)
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("fan_out depends_on at '{}' must be an array", path))?
                .iter()
                .map(|value| {
                    value.as_str().filter(|id| !id.is_empty()).map(str::to_owned).ok_or_else(|| {
                        anyhow::anyhow!("fan_out dependency for unit '{}' must be a non-empty string", unit_id)
                    })
                })
                .collect::<anyhow::Result<Vec<_>>>()?,
        };

        let mut seen_dependencies = HashSet::<String>::new();
        for dependency in &depends_on {
            if dependency == &unit_id {
                anyhow::bail!("fan_out unit '{}' cannot depend on itself", unit_id);
            }
            if !seen_dependencies.insert(dependency.clone()) {
                anyhow::bail!("fan_out unit '{}' repeats dependency '{}'", unit_id, dependency);
            }
        }

        let mut slot_values = prompt_plan.base_slot_values.clone();
        for (slot_name, binding) in &fan_out.item_bindings {
            slot_values.insert(
                slot_name.clone(),
                resolve_binding(binding, &HashMap::new(), &Value::Null, Some(item))?,
            );
        }
        slot_values.insert("UNIT_ID".into(), unit_id.clone());
        slot_values.insert("STAGE_INSTANCE_ID".into(), stage_instance_id.0.to_string());
        let rendered_prompt = render_template(&prompt_plan.raw_template, &slot_values)?;

        let worktree = match &fan_out.worktree {
            Some(template) => Some(WorktreeIdentity {
                branch_name: substitute_unit_template(&template.branch_name, &unit_id, stage_instance_id),
                worktree_subdir: substitute_unit_template(&template.worktree_subdir, &unit_id, stage_instance_id),
                base_ref: template.base_ref.as_ref().map(|base| substitute_unit_template(base, &unit_id, stage_instance_id)),
            }),
            None => config.worktree.clone(),
        };
        units.push(MaterializedFanOutUnit {
            unit_id,
            params: item.clone(),
            depends_on,
            rendered_prompt,
            worktree,
        });
    }

    for unit in &units {
        for dependency in &unit.depends_on {
            if !unit_ids.contains(dependency) {
                anyhow::bail!("fan_out unit '{}' depends on unknown unit '{}'", unit.unit_id, dependency);
            }
        }
    }
    // Kahn's algorithm: a closed graph that cannot consume all nodes has a cycle.
    let mut remaining: HashMap<&str, usize> = units
        .iter()
        .map(|unit| (unit.unit_id.as_str(), unit.depends_on.len()))
        .collect();
    let mut ready: Vec<&str> = remaining
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut consumed = 0usize;
    while let Some(done) = ready.pop() {
        consumed += 1;
        for unit in &units {
            if unit.depends_on.iter().any(|dependency| dependency == done) {
                let count = remaining.get_mut(unit.unit_id.as_str()).expect("known unit");
                *count -= 1;
                if *count == 0 {
                    ready.push(unit.unit_id.as_str());
                }
            }
        }
    }
    if consumed != units.len() {
        anyhow::bail!("fan_out dependency graph contains a cycle");
    }
    Ok(units)
}

/// Number of consecutive retryable poll errors before the observer gives up.
const MAX_OBSERVER_POLL_ERRORS: u32 = 5;
/// Poll interval and backoff constants are shortened under test to keep suites fast.
#[cfg(not(test))]
const OBSERVER_POLL_INTERVAL_MS: u64 = 5000;
#[cfg(test)]
const OBSERVER_POLL_INTERVAL_MS: u64 = 20;
/// Base backoff in milliseconds for the first retry; doubles each attempt (capped at 4×).
#[cfg(not(test))]
const OBSERVER_BACKOFF_BASE_MS: u64 = 500;
#[cfg(test)]
const OBSERVER_BACKOFF_BASE_MS: u64 = 5;
/// Retry interval for waiting_for_kbbl reattachment attempts.
#[cfg(not(test))]
const WAITING_FOR_KBBL_RETRY_MS: u64 = 5000;
#[cfg(test)]
const WAITING_FOR_KBBL_RETRY_MS: u64 = 20;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
}

impl DelegatedGateState {
    pub fn artifact_approval(
        kbbl_sid: String,
        artifact_id: crate::types::ArtifactId,
        revision_count: u32,
        worktree_path: Option<String>,
        worktree_branch: Option<String>,
        worktree_base_ref: Option<String>,
        pr_url: Option<String>,
    ) -> Self {
        Self {
            executor: DelegatedExecutor::DelegatedSession,
            kbbl_sid,
            gate: DelegatedGate::ArtifactApproval,
            artifact_id,
            revision_count,
            worktree_path,
            worktree_branch,
            worktree_base_ref,
            pr_url,
        }
    }
}

fn revision_count_from_meta(meta: Option<&Value>) -> u32 {
    meta.and_then(|meta| serde_json::from_value::<DelegatedGateState>(meta.clone()).ok())
        .map(|state| state.revision_count)
        .unwrap_or(1)
}

fn validate_delegated_def(def: &DelegatedSessionDefConfig) -> anyhow::Result<()> {
    if !def.pre_authorized_tools.is_empty() {
        anyhow::bail!(
            "pre_authorized_tools is not supported: per-tool approval is managed by the kbbl PWA (Phase 2). Remove pre_authorized_tools from the workflow definition or set it to an empty array."
        );
    }

    // Only validate effort when it is a literal string; bound effort is deferred
    // to build_config time when the resolved value is available.
    if let Some(Bindable::Literal(ref e)) = def.effort {
        if !validate_effort(e) {
            anyhow::bail!(
                "invalid effort {:?}: must be one of [minimal, low, medium, high]",
                e
            );
        }
    }

    Ok(())
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
    /// unit_id is stored here for future N>1 fan-out routing; not yet read on the N=1 path.
    #[allow(dead_code)]
    pub unit_id: String,
    pub sid: String,
    pub config: DelegatedSessionConfig,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub worktree_base_ref: Option<String>,
}

pub(crate) type LiveSessions = Arc<Mutex<HashMap<(StageInstanceId, String), LiveSession>>>;

struct DelegatedSessionHandle {
    stage_instance_id: StageInstanceId,
    unit_id: String,
    sid: String,
    kbbl_client: Arc<KbblClient>,
    live_sessions: LiveSessions,
}

impl DelegatedSessionStage {
    async fn create_session(
        &self,
        config: &DelegatedSessionConfig,
        ctx: &StageContext,
        unit_id: &str,
    ) -> anyhow::Result<SessionSnapshot> {
        let snapshot = self
            .kbbl_client
            .create_session(CreateSessionRequest {
                workdir: config.workdir.display().to_string(),
                name: config.session_name.clone(),
                artifact_id: ctx.stage_instance_id.0.to_string(),
                runtime: config.runtime.clone(),
                model: config.model.clone(),
                effort: config.effort.clone(),
                worktree: config.worktree.clone(),
            })
            .await?;

        let ext_ref = DelegatedExternalRef {
            sid: snapshot.sid.clone(),
            worktree_path: snapshot.worktree_path.clone(),
            worktree_branch: snapshot.worktree_branch.clone(),
            worktree_base_ref: snapshot.worktree_base_ref.clone(),
        };
        let ext_ref_json = serde_json::to_string(&ext_ref)?;

        if let Err(err) = ctx.set_external_ref(Some(ext_ref_json)).await {
            // Session not yet in live_sessions map; just stop kbbl.
            self.cleanup_live_session(ctx.stage_instance_id, unit_id, &snapshot.sid, None)
                .await;
            return Err(err);
        }
        Ok(snapshot)
    }

    async fn probe_live_session(&self, sid: &str) -> anyhow::Result<Option<i64>> {
        let response = self.kbbl_client.read_events_since(sid, -1).await?;
        self.ensure_observable(sid, &response)?;
        Ok(latest_event_id(&response.events))
    }

    /// Like `probe_live_session` but classifies transport errors as retryable vs terminal,
    /// so the caller can park as `waiting_for_kbbl` instead of propagating an error.
    async fn probe_session_for_recovery(&self, sid: &str) -> ProbeOutcome {
        match self.kbbl_client.read_events_since(sid, -1).await {
            Ok(response) => {
                if response.session_id != sid {
                    return ProbeOutcome::Terminal(anyhow::anyhow!(
                        "substrate recovery error: kbbl responded for session '{}' instead of '{}'",
                        response.session_id,
                        sid
                    ));
                }
                if let Some(reason) = failure_reason_from_events(sid, &response.events) {
                    return ProbeOutcome::Terminal(anyhow::anyhow!(
                        "substrate recovery error: {}",
                        reason
                    ));
                }
                ProbeOutcome::Reachable(latest_event_id(&response.events))
            }
            Err(e) if is_retryable_observer_error(&e) => ProbeOutcome::Retryable,
            Err(e) => ProbeOutcome::Terminal(e.into()),
        }
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
        unit_id: String,
        ctx: StageContext,
        sid: String,
        config: DelegatedSessionConfig,
        worktree_path: Option<String>,
        worktree_branch: Option<String>,
        worktree_base_ref: Option<String>,
    ) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live_sessions.lock().unwrap().insert(
            (stage_instance_id, unit_id.clone()),
            LiveSession {
                cancelled: cancelled.clone(),
                ctx,
                unit_id,
                sid,
                config,
                worktree_path,
                worktree_branch,
                worktree_base_ref,
            },
        );
        cancelled
    }

    async fn cleanup_live_session(
        &self,
        stage_instance_id: StageInstanceId,
        unit_id: &str,
        sid: &str,
        cancelled: Option<&Arc<AtomicBool>>,
    ) {
        if let Some(cancelled) = cancelled {
            cancelled.store(true, Ordering::SeqCst);
        }
        self.live_sessions
            .lock()
            .unwrap()
            .remove(&(stage_instance_id, unit_id.to_owned()));
        if let Err(err) = self.kbbl_client.stop_session(sid).await {
            warn!(stage_instance_id = %stage_instance_id.0, sid, "best-effort kbbl stop failed: {}", err);
        }
    }

    fn spawn_observer(
        &self,
        ctx: StageContext,
        stage_instance_id: StageInstanceId,
        unit_id: String,
        sid: String,
        cancelled: Arc<AtomicBool>,
        last_seen: i64,
    ) {
        let client = self.kbbl_client.clone();
        let live_sessions = self.live_sessions.clone();
        tokio::spawn(async move {
            observer_loop(
                &ctx,
                stage_instance_id,
                &unit_id,
                &sid,
                &cancelled,
                last_seen,
                &client,
                &live_sessions,
            )
            .await;
        });
    }

    fn spawn_waiting_for_kbbl(
        &self,
        ctx: StageContext,
        stage_instance_id: StageInstanceId,
        unit_id: String,
        sid: String,
        cancelled: Arc<AtomicBool>,
        pre_park_status: StageStatus,
        pre_park_parked_reason: Option<String>,
        pre_park_parked_meta: Option<Value>,
        worktree_path: Option<String>,
        worktree_branch: Option<String>,
        worktree_base_ref: Option<String>,
    ) {
        let client = self.kbbl_client.clone();
        let live_sessions = self.live_sessions.clone();
        tokio::spawn(async move {
            // Phase 1: retry until kbbl is reachable.
            let last_seen = loop {
                sleep(Duration::from_millis(WAITING_FOR_KBBL_RETRY_MS)).await;
                if cancelled.load(Ordering::SeqCst) {
                    return;
                }
                match client.read_events_since(&sid, -1).await {
                    Ok(response) => {
                        if response.session_id != sid {
                            if !cancelled.load(Ordering::SeqCst) {
                                let _ = ctx.set_status_with_terminal_meta(
                                    StageStatus::Failed,
                                    None,
                                    Some(serde_json::json!({"reason": format!("kbbl session {} became unavailable", sid)})),
                                ).await;
                                live_sessions.lock().unwrap().remove(&(stage_instance_id, unit_id.clone()));
                            }
                            return;
                        }
                        if let Some(reason) = failure_reason_from_events(&sid, &response.events) {
                            if !cancelled.load(Ordering::SeqCst) {
                                let _ = ctx
                                    .set_status_with_terminal_meta(
                                        StageStatus::Failed,
                                        None,
                                        Some(serde_json::json!({"reason": reason})),
                                    )
                                    .await;
                                live_sessions.lock().unwrap().remove(&(stage_instance_id, unit_id.clone()));
                            }
                            return;
                        }
                        break latest_event_id(&response.events).unwrap_or(-1);
                    }
                    Err(e) if is_retryable_observer_error(&e) => continue,
                    Err(e) => {
                        if !cancelled.load(Ordering::SeqCst) {
                            let _ = ctx
                                .set_status_with_terminal_meta(
                                    StageStatus::Failed,
                                    None,
                                    Some(serde_json::json!({"reason": e.to_string()})),
                                )
                                .await;
                            live_sessions.lock().unwrap().remove(&(stage_instance_id, unit_id.clone()));
                        }
                        return;
                    }
                }
            };

            if cancelled.load(Ordering::SeqCst) {
                return;
            }

            // Phase 2: kbbl is reachable — restore pre-park state and register in live_sessions.
            if matches!(pre_park_status, StageStatus::Parked) {
                let _ = ctx
                    .set_status(StageStatus::Parked, pre_park_parked_reason)
                    .await;
                let _ = ctx.set_parked_meta(pre_park_parked_meta).await;
            } else {
                let _ = ctx.set_status(StageStatus::Running, None).await;
                let _ = ctx.set_parked_meta(None).await;
            }

            let config: DelegatedSessionConfig = match serde_json::from_value(ctx.config.clone()) {
                Ok(c) => c,
                Err(e) => {
                    let _ = ctx
                        .set_status_with_terminal_meta(
                            StageStatus::Failed,
                            None,
                            Some(serde_json::json!({"reason": e.to_string()})),
                        )
                        .await;
                    return;
                }
            };
            if cancelled.load(Ordering::SeqCst) {
                return;
            }
            live_sessions.lock().unwrap().insert(
                (stage_instance_id, unit_id.clone()),
                LiveSession {
                    cancelled: cancelled.clone(),
                    ctx: ctx.clone(),
                    unit_id: unit_id.clone(),
                    sid: sid.clone(),
                    config,
                    worktree_path,
                    worktree_branch,
                    worktree_base_ref,
                },
            );

            // Phase 3: observe normally. observer_loop handles live_sessions removal.
            observer_loop(
                &ctx,
                stage_instance_id,
                &unit_id,
                &sid,
                &cancelled,
                last_seen,
                &client,
                &live_sessions,
            )
            .await;
        });
    }
}

/// Returns true for transport errors and 5xx responses that should be retried.
/// 4xx and definitive terminal responses (e.g. session-not-found 404) are not retryable.
fn is_retryable_observer_error(err: &kbbl_client::KbblClientError) -> bool {
    use kbbl_client::KbblClientError;
    match err {
        KbblClientError::Request(e) => e.is_connect() || e.is_timeout() || e.is_request(),
        KbblClientError::Rejected { status, .. } => status.is_server_error(),
        _ => false,
    }
}

/// Result of probing a live kbbl session during recovery.
enum ProbeOutcome {
    /// kbbl is reachable and the session is observable; carries the last event id.
    Reachable(Option<i64>),
    /// kbbl returned a retryable error (connect failure, timeout, or 5xx).
    Retryable,
    /// The session is terminally gone or already failed; the stage should fail.
    Terminal(anyhow::Error),
}

/// Returns true if `events` contains a clean subprocess exit (code 0).
fn has_clean_exit(events: &[kbbl_client::SessionEvent]) -> bool {
    events.iter().any(|e| {
        e.event_type == "subprocess_exited"
            && e.payload.get("code").and_then(|c| c.as_i64()) == Some(0)
    })
}

/// Core observer polling loop, shared by the normal and waiting_for_kbbl paths.
///
/// Removes `stage_instance_id` from `live_sessions` on all exit paths EXCEPT
/// when a clean subprocess exit (code 0) is observed while the stage is already
/// Parked at a gate. In that case the gate is still pending and the live session
/// must remain so the resume route can reach it; the observer just stops polling.
async fn observer_loop(
    ctx: &StageContext,
    stage_instance_id: StageInstanceId,
    unit_id: &str,
    sid: &str,
    cancelled: &Arc<AtomicBool>,
    mut last_seen: i64,
    client: &Arc<KbblClient>,
    live_sessions: &LiveSessions,
) {
    let mut poll_error_count: u32 = 0;
    loop {
        sleep(Duration::from_millis(OBSERVER_POLL_INTERVAL_MS)).await;
        if cancelled.load(Ordering::SeqCst) {
            break;
        }

        match client.read_events_since(sid, last_seen).await {
            Ok(response) => {
                poll_error_count = 0;
                if response.session_id != sid {
                    if !cancelled.load(Ordering::SeqCst) {
                        let _ = ctx.set_status_with_terminal_meta(
                            StageStatus::Failed,
                            None,
                            Some(serde_json::json!({"reason": format!("kbbl session {} became unavailable", sid)})),
                        ).await;
                    }
                    break;
                }

                if let Some(reason) = failure_reason_from_events(sid, &response.events) {
                    if !cancelled.load(Ordering::SeqCst) {
                        let _ = ctx
                            .set_status_with_terminal_meta(
                                StageStatus::Failed,
                                None,
                                Some(serde_json::json!({"reason": reason.clone()})),
                            )
                            .await;
                    }
                    break;
                }

                if has_clean_exit(&response.events) && !cancelled.load(Ordering::SeqCst) {
                    // Session exited cleanly. If the stage is still Running (no artifact
                    // emitted yet), park it as session_ended_without_emit so the operator
                    // can see the clean exit and decide what to do next.
                    // If the stage is already Parked (artifact emitted, waiting at gate),
                    // the clean exit is expected — stop observing but keep the live session
                    // entry intact so the pending gate decision can still be delivered.
                    // Read from DB rather than the in-memory cache, which can be stale when
                    // the scheduler has written a Parked status that has not yet propagated.
                    let persisted = ctx.persisted_status().await.unwrap_or(StageStatus::Running);
                    if matches!(persisted, StageStatus::Running) {
                        let _ = ctx
                            .set_status(
                                StageStatus::Parked,
                                Some("session_ended_without_emit".to_string()),
                            )
                            .await;
                        let _ = ctx
                            .set_parked_meta(Some(
                                serde_json::json!({"kind": "session_ended_without_emit"}),
                            ))
                            .await;
                        break;
                    } else if matches!(persisted, StageStatus::Parked) {
                        // Parked at gate: stop observing without removing from live_sessions.
                        return;
                    } else {
                        break;
                    }
                }

                if let Some(new_last_seen) = latest_event_id(&response.events) {
                    last_seen = new_last_seen;
                }
            }
            Err(err) => {
                if is_retryable_observer_error(&err) {
                    poll_error_count += 1;
                    if poll_error_count < MAX_OBSERVER_POLL_ERRORS {
                        let backoff_ms =
                            OBSERVER_BACKOFF_BASE_MS * (1u64 << (poll_error_count - 1).min(2));
                        sleep(Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                    // Budget exhausted: try to stop the kbbl session so it
                    // doesn't continue running unobserved, then fail the stage.
                    if !cancelled.load(Ordering::SeqCst) {
                        let stop_result = client.stop_session(sid).await;
                        let stop_ok = matches!(&stop_result, Ok(r) if r.ok);
                        let error_class = match &err {
                            kbbl_client::KbblClientError::Rejected { .. } => "server_error",
                            _ => "transport",
                        };
                        let _ = ctx.set_status_with_terminal_meta(
                            StageStatus::Failed,
                            None,
                            Some(serde_json::json!({
                                "reason": format!(
                                    "observer poll budget exhausted after {} errors for kbbl session {}",
                                    MAX_OBSERVER_POLL_ERRORS, sid
                                ),
                                "last_error_class": error_class,
                                "last_error": err.to_string(),
                                "poll_error_count": poll_error_count,
                                "stop_outcome": if stop_ok { "stopped" } else { "stop_failed" }
                            })),
                        ).await;
                    }
                } else if !cancelled.load(Ordering::SeqCst) {
                    let _ = ctx.set_status_with_terminal_meta(
                        StageStatus::Failed,
                        None,
                        Some(serde_json::json!({"reason": format!("kbbl session {} became unavailable: {}", sid, err)})),
                    ).await;
                }
                break;
            }
        }
    }
    live_sessions.lock().unwrap().remove(&(stage_instance_id, unit_id.to_owned()));
}

struct WaitingForKbblHandle {
    stage_instance_id: StageInstanceId,
    unit_id: String,
    sid: String,
    kbbl_client: Arc<KbblClient>,
    live_sessions: LiveSessions,
    cancelled: Arc<AtomicBool>,
}

#[async_trait]
impl StageHandle for WaitingForKbblHandle {
    async fn resume(&self, payload: crate::executor::ResumePayload) -> anyhow::Result<()> {
        // If the retry task has already reattached (kbbl came back), delegate to the
        // live session exactly as DelegatedSessionHandle would.
        let session = self
            .live_sessions
            .lock()
            .unwrap()
            .get(&(self.stage_instance_id, self.unit_id.clone()))
            .cloned();
        if session.is_some() {
            let delegate = DelegatedSessionHandle {
                stage_instance_id: self.stage_instance_id,
                unit_id: self.unit_id.clone(),
                sid: self.sid.clone(),
                kbbl_client: self.kbbl_client.clone(),
                live_sessions: self.live_sessions.clone(),
            };
            return delegate.resume(payload).await;
        }
        anyhow::bail!("cannot resume a stage that is waiting for kbbl to become available")
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        self.live_sessions
            .lock()
            .unwrap()
            .remove(&(self.stage_instance_id, self.unit_id.clone()));
        let _ = self.kbbl_client.stop_session(&self.sid).await;
        Ok(())
    }
}

#[async_trait]
impl StageType for DelegatedSessionStage {
    fn id(&self) -> &str {
        "delegated_session"
    }

    fn validate_def_config(
        &self,
        def_config: &Value,
        input_slots: &[InputSlot],
        output_slots: &[OutputSlot],
    ) -> anyhow::Result<()> {
        let def: DelegatedSessionDefConfig = serde_json::from_value(def_config.clone())?;
        load_template(&self.prompts_dir, &def.prompt_template_path)?;
        validate_delegated_def(&def)?;

        // A configured gate_output must name a declared output slot. Otherwise the
        // emit handler treats every emit as auxiliary and never parks the unit,
        // leaving the stage stuck in Running with no gate to resume. Fail fast at
        // def validation instead of deadlocking a live run.
        if let Some(gate_output) = &def.gate_output {
            if !output_slots.iter().any(|slot| &slot.name == gate_output) {
                anyhow::bail!(
                    "gate_output '{}' does not match any declared output slot",
                    gate_output
                );
            }
        }

        let input_names: std::collections::HashSet<&str> =
            input_slots.iter().map(|slot| slot.name.as_str()).collect();
        for (slot_name, binding) in &def.slot_bindings {
            if let SlotBinding::Input { input_name, .. } = binding {
                if !input_names.contains(input_name.as_str()) {
                    anyhow::bail!(
                        "slot binding '{}' references unknown input '{}'",
                        slot_name,
                        input_name
                    );
                }
            }
        }
        if let SlotBinding::Input { input_name, .. } = &def.workdir {
            if !input_names.contains(input_name.as_str()) {
                anyhow::bail!("workdir binding references unknown input '{}'", input_name);
            }
        }

        Ok(())
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, ResolvedInput>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: DelegatedSessionDefConfig = serde_json::from_value(def_config.clone())?;
        let template = load_template(&self.prompts_dir, &def.prompt_template_path)?;

        let mut slot_values: HashMap<String, String> = HashMap::new();
        for (slot_name, binding) in &def.slot_bindings {
            if !matches!(binding, SlotBinding::Item { .. }) {
                slot_values.insert(
                    slot_name.clone(),
                    resolve_binding(binding, inputs, run_context, None)?,
                );
            }
        }
        slot_values.insert(
            "STAGE_INSTANCE_ID".to_owned(),
            stage_instance_id.0.to_string(),
        );
        validate_delegated_def(&def)?;

        let mut render_values = slot_values.clone();
        for (slot_name, binding) in &def.slot_bindings {
            if matches!(binding, SlotBinding::Item { .. }) {
                render_values.insert(slot_name.clone(), format!("{{{{{slot_name}}}}}"));
            }
        }
        let rendered_prompt = render_template(&template, &render_values)?;
        let fan_out_prompt_plan = def.fan_out.as_ref().map(|_| FanOutPromptPlan {
            raw_template: template.clone(),
            base_slot_values: slot_values.clone(),
        });
        let resolved_fan_out_over = def
            .fan_out
            .as_ref()
            .map(|fan_out| {
                let value = resolve_binding(&fan_out.over, inputs, run_context, None)?;
                serde_json::from_str::<Value>(&value).map_err(|err| {
                    anyhow::anyhow!("fan_out.over did not resolve to JSON: {}", err)
                })
            })
            .transpose()?;
        let sid_str = stage_instance_id.0.to_string();
        let workdir_str = resolve_binding(&def.workdir, inputs, run_context, None)?
            .replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str);

        let model = match def.model {
            None => None,
            Some(Bindable::Literal(s)) => Some(s),
            Some(Bindable::Bound(ref binding)) => {
                resolve_optional_binding(binding, run_context)?
            }
        };

        let effort = match def.effort {
            None => None,
            Some(Bindable::Literal(s)) => Some(s),
            Some(Bindable::Bound(ref binding)) => {
                let resolved = resolve_optional_binding(binding, run_context)?;
                if let Some(ref e) = resolved {
                    if !validate_effort(e) {
                        anyhow::bail!(
                            "invalid effort {:?} resolved from binding: must be one of [minimal, low, medium, high]",
                            e
                        );
                    }
                }
                resolved
            }
        };

        let config = DelegatedSessionConfig {
            runtime: def.runtime,
            rendered_prompt,
            fan_out_prompt_plan,
            resolved_fan_out_over,
            workdir: PathBuf::from(workdir_str),
            session_name: def
                .session_name
                .replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str),
            model,
            effort,
            worktree: def.worktree,
            pre_authorized_tools: def.pre_authorized_tools,
            yolo: def.yolo,
            output_slots: output_slots.to_vec(),
            // Thread fan_out through to the built config so execute() can detect
            // N>1 and reject until Phase 2b implements the per-unit scheduler.
            fan_out: def.fan_out,
            // Carry gate_output designation to built config so the emit handler
            // knows which slot triggers parking vs. just storing an artifact.
            gate_output: def.gate_output,
        };

        Ok(serde_json::to_value(config)?)
    }

    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let config: DelegatedSessionConfig = serde_json::from_value(ctx.config.clone())?;

        // N>1 fan-out execution stub: reject early with a clear message.
        // The substrate (stage_session_units table, per-unit emit route /:id/units/:unit_id/emit/:name,
        // composite gate id, FanOut config struct) is in place (Phase 2a). The per-unit session
        // scheduler, intra-stage DAG, and worktree-per-unit launch are Phase 2b.
        if config.fan_out.is_some() {
            anyhow::bail!(
                "fan_out multi-unit execution is not yet implemented; \
                 the substrate (stage_session_units schema, per-unit emit route, composite gate id) \
                 is in place but the N>1 session scheduler and per-unit launch are pending (Phase 2b)"
            );
        }

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
        // N=1 implicit unit: no fan_out config → always unit_id="0".
        let unit_id = IMPLICIT_UNIT_ID.to_owned();
        let mut created_session = false;

        let mut recovery_last_seen = -1;
        let mut live_worktree_path: Option<String> = None;
        let mut live_worktree_branch: Option<String> = None;
        let mut live_worktree_base_ref: Option<String> = None;

        let sid = match summary.external_ref.clone() {
            Some(ext_ref_str) => {
                let ext_ref = DelegatedExternalRef::parse(&ext_ref_str);
                live_worktree_path = ext_ref.worktree_path.clone();
                live_worktree_branch = ext_ref.worktree_branch.clone();
                live_worktree_base_ref = ext_ref.worktree_base_ref.clone();
                let existing_sid = ext_ref.sid.clone();
                match self.probe_session_for_recovery(&existing_sid).await {
                    ProbeOutcome::Reachable(maybe_last_seen) => {
                        if let Some(last_seen) = maybe_last_seen {
                            recovery_last_seen = last_seen;
                        }
                    }
                    ProbeOutcome::Retryable => {
                        // kbbl is temporarily unreachable — park the stage and spawn a
                        // retry task that reattaches when kbbl becomes available.
                        ctx.set_status(StageStatus::Parked, Some("waiting_for_kbbl".to_string()))
                            .await?;
                        ctx.set_parked_meta(Some(serde_json::json!({"kind": "waiting_for_kbbl"})))
                            .await?;
                        let cancelled = Arc::new(AtomicBool::new(false));
                        self.spawn_waiting_for_kbbl(
                            ctx.clone(),
                            stage_instance_id,
                            unit_id.clone(),
                            existing_sid.clone(),
                            cancelled.clone(),
                            summary.status,
                            summary.parked_reason.clone(),
                            summary.parked_meta.clone(),
                            live_worktree_path,
                            live_worktree_branch,
                            live_worktree_base_ref,
                        );
                        return Ok(Box::new(WaitingForKbblHandle {
                            stage_instance_id,
                            unit_id,
                            sid: existing_sid,
                            kbbl_client: self.kbbl_client.clone(),
                            live_sessions: self.live_sessions.clone(),
                            cancelled,
                        }));
                    }
                    ProbeOutcome::Terminal(e) => return Err(e),
                }
                existing_sid
            }
            None => {
                created_session = true;
                let snapshot = self.create_session(&config, &ctx, &unit_id).await?;
                live_worktree_path = snapshot.worktree_path.clone();
                live_worktree_branch = snapshot.worktree_branch.clone();
                live_worktree_base_ref = snapshot.worktree_base_ref.clone();
                snapshot.sid
            }
        };

        // Upsert the implicit unit row (N=1 path). This is idempotent: re-execute
        // after a crash will hit the upsert and update the row in place.
        let now = chrono::Utc::now();
        let unit_external_ref = {
            let ext = DelegatedExternalRef {
                sid: sid.clone(),
                worktree_path: live_worktree_path.clone(),
                worktree_branch: live_worktree_branch.clone(),
                worktree_base_ref: live_worktree_base_ref.clone(),
            };
            serde_json::to_string(&ext).ok()
        };
        if let Err(err) = queries::upsert_session_unit(
            ctx.pool(),
            &crate::types::SessionUnit {
                stage_instance_id,
                unit_id: unit_id.clone(),
                params: None,
                depends_on: vec![],
                external_ref: unit_external_ref,
                worktree_branch: live_worktree_branch.clone(),
                worktree_path: live_worktree_path.clone(),
                worktree_base_ref: live_worktree_base_ref.clone(),
                // On recovery of a gate-parked stage, mirror the recovered parked
                // state onto the unit row instead of hardcoding Running/None — else
                // the per-unit read-model reports a running unit with no gate while
                // the stage is parked.
                status: if recovered_parked {
                    UnitStatus::Parked
                } else {
                    UnitStatus::Running
                },
                gate_state: if recovered_parked {
                    summary.parked_meta.clone()
                } else {
                    None
                },
                artifact_id: None,
                terminal_meta: None,
                created_at: now,
                updated_at: now,
            },
        )
        .await
        {
            tracing::warn!(
                stage_instance_id = %stage_instance_id.0,
                unit_id = %unit_id,
                error = %err,
                "upsert_session_unit failed; unit state may be inconsistent with stage"
            );
        }

        let cancelled = self.insert_live_session(
            stage_instance_id,
            unit_id.clone(),
            ctx.clone(),
            sid.clone(),
            config.clone(),
            live_worktree_path,
            live_worktree_branch,
            live_worktree_base_ref,
        );

        if !recovered_parked {
            if let Err(err) = ctx.set_status(StageStatus::Running, None).await {
                self.cleanup_live_session(stage_instance_id, &unit_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        if config.yolo {
            if let Err(err) = self.apply_yolo(&sid).await {
                self.cleanup_live_session(stage_instance_id, &unit_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        if created_session {
            if let Err(err) = self
                .send_initial_prompt(&sid, &config.rendered_prompt)
                .await
            {
                self.cleanup_live_session(stage_instance_id, &unit_id, &sid, Some(&cancelled))
                    .await;
                return Err(err);
            }
        }

        self.spawn_observer(
            ctx.clone(),
            stage_instance_id,
            unit_id.clone(),
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
            unit_id,
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

    fn gate_flow(&self) -> crate::registry::stage_type::GateFlowDescriptor {
        use crate::registry::stage_type::{GateFlowDescriptor, GateStep};
        GateFlowDescriptor {
            steps: vec![
                GateStep { gate_type: "artifact_approval".into() },
                GateStep { gate_type: "merge_confirmation".into() },
            ],
            requires_zero_open_review_items: true,
        }
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
                anyhow::bail!("delegated approval forwarding is not enabled until K1 exists")
            }
        }
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        let cancelled = {
            let mut live_sessions = self.live_sessions.lock().unwrap();
            live_sessions
                .remove(&(self.stage_instance_id, self.unit_id.clone()))
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
            .get(&(self.stage_instance_id, self.unit_id.clone()))
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
        let pretty_body = serde_json::to_string_pretty(&artifact.body)
            .unwrap_or_else(|_| artifact.body.to_string());
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
                // Gate coupling: reject approval while open review items remain.
                // The artifact emitted by this stage IS the chain root (revision_id),
                // so gate_state.artifact_id.0.to_string() == revision_id for all items.
                let revision_id = gate_state.artifact_id.0.to_string();
                let open_count = queries::count_open_review_items_for_artifact(
                    session.ctx.pool(),
                    &revision_id,
                )
                .await
                .map_err(|e| anyhow::anyhow!("gate coupling check failed: {e}"))?;
                if open_count > 0 {
                    anyhow::bail!(
                        "cannot approve: {open_count} review item(s) are still open"
                    );
                }
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
                    .remove(&(self.stage_instance_id, self.unit_id.clone()));
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

    fn fan_out_config(over: Value, depends_on_path: Option<&str>) -> DelegatedSessionConfig {
        DelegatedSessionConfig {
            runtime: config::DelegatedRuntime::Codex,
            rendered_prompt: "legacy prompt".into(),
            fan_out_prompt_plan: Some(FanOutPromptPlan {
                raw_template: "unit={{UNIT_ID}} stage={{STAGE_INSTANCE_ID}} item={{ITEM}} base={{BASE}}".into(),
                base_slot_values: HashMap::from([("BASE".into(), "base-value".into())]),
            }),
            resolved_fan_out_over: Some(over),
            workdir: PathBuf::from("/work"),
            session_name: "session".into(),
            model: None,
            effort: None,
            worktree: None,
            pre_authorized_tools: vec![],
            yolo: false,
            output_slots: vec![],
            fan_out: Some(FanOut {
                over: SlotBinding::Literal { value: "[]".into() },
                unit_id_path: "/id".into(),
                depends_on_path: depends_on_path.map(str::to_owned),
                max_parallel: 2,
                item_bindings: HashMap::from([(
                    "ITEM".into(),
                    SlotBinding::Item { path: "/name".into() },
                )]),
                worktree: Some(config::WorktreeTemplate {
                    branch_name: "run/{{STAGE_INSTANCE_ID}}/{{UNIT_ID}}".into(),
                    worktree_subdir: "units/{{UNIT_ID}}".into(),
                    base_ref: Some("base/{{STAGE_INSTANCE_ID}}".into()),
                }),
            }),
            gate_output: None,
        }
    }

    fn make_text_artifact_registry() -> Arc<ArtifactTypeRegistry> {
        let mut registry = ArtifactTypeRegistry::new();
        registry.register(ArtifactTypeDef {
            id: "text".into(),
            validate: |_| Ok(()),
            component_id: "text-viewer".into(),
            capabilities: Default::default(),
            anchor_schema: None,
            review_items_extractor: None,
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
            worktree_path: Some("/work/wt/abc".into()),
            worktree_branch: Some("cohort/e/1-foo".into()),
            worktree_base_ref: Some("abc123".into()),
            pr_url: None,
        };

        let value = serde_json::to_value(&state).unwrap();
        let back: DelegatedGateState = serde_json::from_value(value).unwrap();
        assert_eq!(state, back);
    }

    #[test]
    fn materialize_fan_out_renders_prompt_and_worktree_per_unit() {
        let stage_id = StageInstanceId(Uuid::new_v4());
        let config = fan_out_config(json!([
            {"id": "a", "name": "alpha", "depends_on": []},
            {"id": "b", "name": "beta", "depends_on": ["a"]}
        ]), Some("/depends_on"));
        let units = materialize_fan_out_units(&config, config.fan_out.as_ref().unwrap(), stage_id).unwrap();

        assert_eq!(units.len(), 2);
        assert_eq!(units[1].depends_on, vec!["a"]);
        assert_eq!(units[0].rendered_prompt, format!("unit=a stage={} item=alpha base=base-value", stage_id.0));
        assert_eq!(units[1].worktree.as_ref().unwrap().branch_name, format!("run/{}/b", stage_id.0));
        assert_eq!(units[1].worktree.as_ref().unwrap().worktree_subdir, "units/b");
    }

    #[test]
    fn materialize_fan_out_rejects_invalid_identity_and_dependencies() {
        let stage_id = StageInstanceId(Uuid::new_v4());
        for (over, expected) in [
            (json!([{"id": "", "depends_on": []}]), "non-empty string"),
            (json!([{"id": "a", "name": "a", "depends_on": []}, {"id": "a", "name": "b", "depends_on": []}]), "duplicated"),
            (json!([{"id": "a", "name": "a", "depends_on": ["missing"]}]), "unknown"),
            (json!([{"id": "a", "name": "a", "depends_on": ["a"]}]), "itself"),
            (json!([{"id": "a", "name": "a", "depends_on": ["b", "b"]}, {"id": "b", "name": "b", "depends_on": []}]), "repeats"),
        ] {
            let config = fan_out_config(over, Some("/depends_on"));
            let err = materialize_fan_out_units(&config, config.fan_out.as_ref().unwrap(), stage_id).unwrap_err();
            assert!(err.to_string().contains(expected), "unexpected error: {err}");
        }
    }

    #[test]
    fn materialize_fan_out_rejects_cycles_and_non_array_values() {
        let stage_id = StageInstanceId(Uuid::new_v4());
        let cycle = fan_out_config(json!([
            {"id": "a", "name": "a", "depends_on": ["b"]},
            {"id": "b", "name": "b", "depends_on": ["a"]}
        ]), Some("/depends_on"));
        assert!(materialize_fan_out_units(&cycle, cycle.fan_out.as_ref().unwrap(), stage_id)
            .unwrap_err().to_string().contains("cycle"));

        let scalar = fan_out_config(json!({"id": "not-an-array"}), None);
        assert!(materialize_fan_out_units(&scalar, scalar.fan_out.as_ref().unwrap(), stage_id)
            .unwrap_err().to_string().contains("JSON array"));
    }

    #[test]
    fn delegated_gate_state_omits_null_worktree_fields() {
        let state = DelegatedGateState {
            executor: DelegatedExecutor::DelegatedSession,
            kbbl_sid: "sid-000".into(),
            gate: DelegatedGate::MergeConfirmation,
            artifact_id: crate::types::ArtifactId(Uuid::new_v4()),
            revision_count: 1,
            worktree_path: None,
            worktree_branch: None,
            worktree_base_ref: None,
            pr_url: None,
        };
        let value = serde_json::to_value(&state).unwrap();
        assert!(value.get("worktree_path").is_none());
        assert!(value.get("worktree_branch").is_none());
        assert!(value.get("worktree_base_ref").is_none());
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
            "pre_authorized_tools": [],
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
        assert_eq!(cfg.fan_out_prompt_plan, None);
        assert_eq!(
            cfg.workdir,
            PathBuf::from("/work/00000000-0000-0000-0000-000000000042")
        );
        assert_eq!(
            cfg.session_name,
            "session-00000000-0000-0000-0000-000000000042"
        );
        assert_eq!(cfg.output_slots, output_slots);
        assert!(cfg.pre_authorized_tools.is_empty());
        assert!(cfg.yolo);
    }

    #[tokio::test]
    async fn build_config_persists_fan_out_prompt_source_and_keeps_item_binding() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fanout.md"), "Base {{BASE}} item {{ITEM}}").unwrap();
        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        let config = stage
            .build_config(
                &json!({
                    "runtime": "codex",
                    "prompt_template_path": "fanout.md",
                    "slot_bindings": {
                        "BASE": {"from": "literal", "value": "ready"},
                        "ITEM": {"from": "item", "path": "/name"}
                    },
                    "workdir": {"from": "literal", "value": "/work"},
                    "session_name": "fanout",
                    "fan_out": {
                        "over": {"from": "literal", "value": "[]"},
                        "unit_id_path": "/id"
                    }
                }),
                &HashMap::new(),
                &[],
                StageInstanceId(uuid::Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap();
        let config: DelegatedSessionConfig = serde_json::from_value(config).unwrap();
        assert_eq!(config.rendered_prompt, "Base ready item {{ITEM}}");
        let plan = config.fan_out_prompt_plan.unwrap();
        assert_eq!(plan.raw_template, "Base {{BASE}} item {{ITEM}}");
        assert_eq!(plan.base_slot_values.get("BASE"), Some(&"ready".to_owned()));
        assert!(!plan.base_slot_values.contains_key("ITEM"));
    }

    fn gate_output_def_config(prompts_dir: &std::path::Path, gate_output: &str) -> Value {
        std::fs::write(prompts_dir.join("delegated.md"), "Task {{STAGE_INSTANCE_ID}}").unwrap();
        json!({
            "runtime": "codex",
            "prompt_template_path": "delegated.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/work"},
            "session_name": "s",
            "pre_authorized_tools": [],
            "yolo": false,
            "gate_output": gate_output
        })
    }

    #[test]
    fn validate_def_config_rejects_gate_output_without_matching_slot() {
        let dir = tempfile::tempdir().unwrap();
        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        let def_config = gate_output_def_config(dir.path(), "nonexistent");
        let output_slots = vec![OutputSlot {
            name: "build_result".into(),
            artifact_type: "text".into(),
        }];

        let err = stage
            .validate_def_config(&def_config, &[], &output_slots)
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("gate_output") && msg.contains("nonexistent"),
            "expected gate_output mismatch error, got: {msg}"
        );
    }

    #[test]
    fn validate_def_config_accepts_gate_output_matching_slot() {
        let dir = tempfile::tempdir().unwrap();
        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        let def_config = gate_output_def_config(dir.path(), "build_result");
        let output_slots = vec![OutputSlot {
            name: "build_result".into(),
            artifact_type: "text".into(),
        }];

        assert!(stage
            .validate_def_config(&def_config, &[], &output_slots)
            .is_ok());
    }

    #[tokio::test]
    async fn build_config_rejects_nonempty_pre_authorized_tools() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("t.md"), "hello").unwrap();

        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );

        let def_config = json!({
            "runtime": "codex",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/work"},
            "session_name": "s",
            "pre_authorized_tools": ["Bash", "Edit"],
            "yolo": false
        });
        let stage_instance_id =
            StageInstanceId(uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000099").unwrap());

        let err = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &[],
                stage_instance_id,
                &json!({}),
            )
            .await
            .unwrap_err();

        let msg = err.to_string();
        assert!(
            msg.contains("pre_authorized_tools is not supported"),
            "expected rejection message, got: {msg}"
        );
        assert!(
            msg.contains("Phase 2"),
            "expected Phase 2 reference in message, got: {msg}"
        );
    }

    #[tokio::test]
    async fn execute_rejects_fan_out_config_not_yet_implemented() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            // Provide a fan_out in the built config — execute must reject it immediately.
            json!({
                "runtime": "codex",
                "rendered_prompt": "do the thing",
                "workdir": "/w",
                "session_name": "s",
                "pre_authorized_tools": [],
                "yolo": false,
                "output_slots": [],
                "fan_out": {
                    "over": {"from": "literal", "value": "[]"},
                    "unit_id_path": "/id"
                }
            }),
            None,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new("http://127.0.0.1:1/").unwrap(), // unreachable — must not be called
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
            json!({
                "runtime": "codex",
                "rendered_prompt": "do the thing",
                "workdir": "/w",
                "session_name": "s",
                "pre_authorized_tools": [],
                "yolo": false,
                "output_slots": [],
                "fan_out": {
                    "over": {"from": "literal", "value": "[]"},
                    "unit_id_path": "/id"
                }
            }),
            HashMap::new(),
            tx,
            pool,
            Arc::new(ArtifactTypeRegistry::new()),
        );

        // execute returns Box<dyn StageHandle> which is not Debug, so we cannot
        // call unwrap_err(); use a manual match instead.
        match stage.execute(ctx).await {
            Err(err) => {
                let msg = err.to_string();
                assert!(
                    msg.contains("fan_out"),
                    "expected 'fan_out' in rejection message, got: {msg}"
                );
                assert!(
                    msg.contains("not yet implemented"),
                    "expected 'not yet implemented' in rejection message, got: {msg}"
                );
            }
            Ok(_) => panic!("execute must fail when fan_out is set (N>1 not yet implemented)"),
        }
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
        // external_ref is now a JSON-serialized DelegatedExternalRef
        let ext_ref = kbbl_client::DelegatedExternalRef::parse(si.external_ref.as_deref().unwrap());
        assert_eq!(ext_ref.sid, "sid-123");
        assert!(ext_ref.worktree_path.is_none());
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
                        "runtime": "codex"
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
        let stage =
            DelegatedSessionStage::new(PathBuf::from("/tmp"), KbblClient::new(base_url).unwrap());
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
            .uri(format!("/{}/units/0/emit/out", si_id.0))
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

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, crate::types::StageStatus::Parked);
        assert_eq!(si.parked_reason.as_deref(), Some("waiting_gate"));
        let meta: DelegatedGateState =
            serde_json::from_value(si.parked_meta.clone().unwrap()).unwrap();
        assert_eq!(meta.executor, DelegatedExecutor::DelegatedSession);
        assert_eq!(meta.kbbl_sid, "sid-123");
        assert_eq!(meta.gate, DelegatedGate::ArtifactApproval);
        assert_eq!(meta.revision_count, 1);
        assert_eq!(meta.artifact_id.0.to_string(), artifact_id);

        // Verify the two requests execute() makes regardless of how many poll requests
        // the background observer has issued since (observer polls are correct behaviour).
        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert!(
            requests.len() >= 2,
            "expected at least CREATE + INPUT requests, got {}",
            requests.len()
        );
        assert_eq!(
            requests[0],
            RecordedRequest {
                method: Method::POST,
                path: "/sessions".into(),
                body: Some(json!({
                    "workdir": "/workdir",
                    "name": "delegate",
                    "artifact_id": si_id.0.to_string(),
                    "runtime": "codex"
                })),
            }
        );
        assert_eq!(
            requests[1],
            RecordedRequest {
                method: Method::POST,
                path: "/sid-123/input".into(),
                body: Some(json!({ "text": "hello artifact" })),
            }
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
                        "runtime": "codex"
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
        let stage =
            DelegatedSessionStage::new(PathBuf::from("/tmp"), KbblClient::new(base_url).unwrap());
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
            .uri(format!("/{}/units/0/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"draft"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artifact_id =
            ArtifactId(Uuid::parse_str(payload["artifact_id"].as_str().unwrap()).unwrap());

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

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        let meta: DelegatedGateState =
            serde_json::from_value(si.parked_meta.clone().unwrap()).unwrap();
        assert_eq!(meta.gate, DelegatedGate::ArtifactApproval);
        assert_eq!(meta.revision_count, 2);
        assert_eq!(si.status, crate::types::StageStatus::Running);

        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/units/0/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"revised"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artifact_id =
            ArtifactId(Uuid::parse_str(payload["artifact_id"].as_str().unwrap()).unwrap());

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

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        let meta: DelegatedGateState =
            serde_json::from_value(si.parked_meta.clone().unwrap()).unwrap();
        assert_eq!(meta.gate, DelegatedGate::MergeConfirmation);
        assert_eq!(si.status, crate::types::StageStatus::Parked);

        let app = stage.http_routes().unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/{}/units/0/emit/out", si_id.0))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"content":"late"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
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

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, crate::types::StageStatus::Done);
        assert!(si.parked_meta.is_none());

        // Filter out observer polls (GET /events) — they are timing-dependent and
        // not what this test is verifying.
        let requests: Vec<_> = capture
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .filter(|r| !(r.method == Method::GET && r.path.contains("/events")))
            .collect();
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
                        "runtime": "codex"
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

    // ── Observer retry tests ─────────────────────────────────────────────────

    /// Build a mock kbbl server whose /events endpoint returns a 503 for the
    /// first `fail_count` calls, then succeeds. Captures all requests.
    async fn spawn_retry_mock(
        fail_count: u32,
    ) -> (
        String,
        Arc<std::sync::atomic::AtomicU32>,
        Arc<Mutex<VecDeque<RecordedRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use axum::http::StatusCode;
        use std::sync::atomic::AtomicU32;

        let call_counter = Arc::new(AtomicU32::new(0));
        let capture = Arc::new(Mutex::new(VecDeque::new()));

        #[derive(Clone)]
        struct RetryState {
            call_counter: Arc<AtomicU32>,
            fail_count: u32,
            capture: Arc<Mutex<VecDeque<RecordedRequest>>>,
        }

        async fn create_handler(
            axum::extract::State(state): axum::extract::State<RetryState>,
            OriginalUri(uri): OriginalUri,
            Json(body): Json<serde_json::Value>,
        ) -> impl IntoResponse {
            state.capture.lock().unwrap().push_back(RecordedRequest {
                method: Method::POST,
                path: uri.path().to_string(),
                body: Some(body),
            });
            (
                StatusCode::CREATED,
                Json(serde_json::json!({ "sid": "sid-retry" })),
            )
        }

        async fn events_handler(
            axum::extract::State(state): axum::extract::State<RetryState>,
            OriginalUri(uri): OriginalUri,
        ) -> impl IntoResponse {
            let n = state
                .call_counter
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state.capture.lock().unwrap().push_back(RecordedRequest {
                method: Method::GET,
                path: uri.to_string(),
                body: None,
            });
            if n < state.fail_count {
                return (StatusCode::SERVICE_UNAVAILABLE, "server busy").into_response();
            }
            Json(serde_json::json!({
                "session_id": "sid-retry",
                "events": []
            }))
            .into_response()
        }

        async fn delete_handler(
            axum::extract::State(state): axum::extract::State<RetryState>,
            OriginalUri(uri): OriginalUri,
        ) -> impl IntoResponse {
            state.capture.lock().unwrap().push_back(RecordedRequest {
                method: Method::DELETE,
                path: uri.path().to_string(),
                body: None,
            });
            Json(serde_json::json!({ "ok": true, "removed": true }))
        }

        async fn input_handler(
            axum::extract::State(state): axum::extract::State<RetryState>,
            OriginalUri(uri): OriginalUri,
            Json(body): Json<serde_json::Value>,
        ) -> impl IntoResponse {
            state.capture.lock().unwrap().push_back(RecordedRequest {
                method: Method::POST,
                path: uri.path().to_string(),
                body: Some(body),
            });
            Json(serde_json::json!({ "ok": true }))
        }

        let state = RetryState {
            call_counter: call_counter.clone(),
            fail_count,
            capture: capture.clone(),
        };

        let app = axum::Router::new()
            .route("/sessions", axum::routing::post(create_handler))
            .route("/:sid/input", axum::routing::post(input_handler))
            .route("/sessions/:sid", axum::routing::delete(delete_handler))
            .route("/:sid/events", axum::routing::get(events_handler))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/"), call_counter, capture, join)
    }

    #[tokio::test]
    async fn observer_one_transient_error_retries_and_stage_stays_running() {
        let (base_url, _counter, _capture, join) = spawn_retry_mock(1).await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello retry", "/workdir", false),
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
            delegated_config_json("hello retry", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        let handle = stage.execute(ctx).await.unwrap();

        // Wait for the Running StatusChanged event.
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

        // Wait long enough for:
        //   poll interval (20ms) + 503 + backoff (5ms) + poll interval (20ms) + 200
        // Using a generous 2s timeout.
        tokio::time::sleep(Duration::from_millis(200)).await;

        // No Failed event must have arrived (transient 503 did NOT kill the stage).
        assert!(
            rx.try_recv().is_err(),
            "stage must not fail on a single transient 503"
        );

        // Stage must still be Running.
        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, crate::types::StageStatus::Running);

        handle.cancel().await.unwrap();
        join.abort();
    }

    #[tokio::test]
    async fn observer_budget_exhaustion_fails_stage_with_terminal_meta() {
        // Return 503 for every events call so budget exhausts.
        let (base_url, _counter, capture, join) =
            spawn_retry_mock(MAX_OBSERVER_POLL_ERRORS + 10).await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello budget", "/workdir", false),
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
            delegated_config_json("hello budget", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        stage.execute(ctx).await.unwrap();

        // Consume Running event.
        tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();

        // Wait for budget to exhaust. With test constants:
        // 5 polls × 20ms + backoffs (5+10+20+40+80=155ms) ≈ 255ms total.
        // Use a generous 5s timeout for the Failed event.
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for Failed event")
            .unwrap();
        match event {
            ExecutorEvent::StatusChanged {
                status,
                terminal_meta,
                ..
            } => {
                assert_eq!(status, crate::types::StageStatus::Failed);
                let meta = terminal_meta.unwrap();
                let count = meta["poll_error_count"].as_u64().unwrap();
                assert_eq!(count, MAX_OBSERVER_POLL_ERRORS as u64);
                assert!(meta["reason"]
                    .as_str()
                    .unwrap()
                    .contains("budget exhausted"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        // stop_session must have been called (DELETE /sessions/sid-retry).
        let requests: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert!(
            requests
                .iter()
                .any(|r| r.method == Method::DELETE && r.path.contains("sid-retry")),
            "stop_session must be called when budget exhausted; requests: {requests:?}"
        );

        join.abort();
    }

    #[tokio::test]
    async fn observer_budget_exhaustion_attempts_stop_session_on_reachable_kbbl() {
        // Same as above but focuses specifically on the stop_session call being
        // made and its outcome recorded in terminal_meta.
        let (base_url, _counter, capture, join) =
            spawn_retry_mock(MAX_OBSERVER_POLL_ERRORS + 10).await;
        let pool = make_pool().await;
        let (run_id, si_id) = setup_stage_instance(
            &pool,
            delegated_config_json("hello stop", "/workdir", false),
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
            delegated_config_json("hello stop", "/workdir", false),
            HashMap::new(),
            tx,
            pool.clone(),
            Arc::new(ArtifactTypeRegistry::new()),
        );

        stage.execute(ctx).await.unwrap();
        // Consume Running event.
        tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for Failed event")
            .unwrap();
        let terminal_meta = match event {
            ExecutorEvent::StatusChanged { terminal_meta, .. } => terminal_meta.unwrap(),
            other => panic!("unexpected event: {other:?}"),
        };

        // stop_outcome must be recorded in terminal_meta.
        let stop_outcome = terminal_meta["stop_outcome"].as_str().unwrap();
        assert!(
            stop_outcome == "stopped" || stop_outcome == "stop_failed",
            "stop_outcome must be 'stopped' or 'stop_failed', got: {stop_outcome}"
        );
        // The mock's DELETE handler returns ok:true, so we expect "stopped".
        assert_eq!(stop_outcome, "stopped");

        // Also confirm the DELETE request landed on the mock.
        let reqs: Vec<_> = capture.lock().unwrap().iter().cloned().collect();
        assert!(
            reqs.iter()
                .any(|r| r.method == Method::DELETE && r.path.contains("sid-retry")),
            "DELETE /sessions/sid-retry must appear in captured requests"
        );

        join.abort();
    }
}
