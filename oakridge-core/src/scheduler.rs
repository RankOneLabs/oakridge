use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use uuid::Uuid;
use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db::queries;
use crate::events::{EventBus, SubstrateEvent};
use crate::executor::{ExecutorEvent, ResumePayload, StageContext, StageHandle};
use crate::registry::{ArtifactTypeRegistry, StageTypeRegistry};
use crate::types::{
    Artifact, RunStatus, StageInstance, StageInstanceId, StageInstanceSummary, StageKey,
    StageStatus, WorkflowDef, WorkflowRunId,
};

// ── Control messages ──────────────────────────────────────────────────────────

pub enum ControlMsg {
    Decision {
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
        reply_tx: oneshot::Sender<Result<(), DecisionError>>,
    },
    Cancel,
}

#[derive(Debug)]
pub enum DecisionError {
    Conflict(String),
    Internal(anyhow::Error),
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecisionError::Conflict(msg) => write!(f, "{}", msg),
            DecisionError::Internal(err) => write!(f, "{}", err),
        }
    }
}

impl std::error::Error for DecisionError {}

// ── RunHandle ─────────────────────────────────────────────────────────────────

struct RunHandle {
    control_tx: mpsc::Sender<ControlMsg>,
    #[allow(dead_code)]
    join: JoinHandle<()>,
}

// ── Per-run scheduler task ────────────────────────────────────────────────────

struct RunTask {
    run_id: WorkflowRunId,
    def: WorkflowDef,
    run_context: Value,
    events_rx: mpsc::Receiver<ExecutorEvent>,
    events_tx: mpsc::Sender<ExecutorEvent>,
    control_rx: mpsc::Receiver<ControlMsg>,
    handles: HashMap<StageInstanceId, Box<dyn StageHandle>>,
    // stage_key -> (stage_instance_id, current status)
    index: HashMap<StageKey, (StageInstanceId, StageStatus)>,
    // (consumer_stage_key, input_slot_name) -> latest artifact
    resolved: HashMap<(StageKey, String), Artifact>,
    db: Arc<SqlitePool>,
    stage_types: Arc<StageTypeRegistry>,
    artifact_types: Arc<ArtifactTypeRegistry>,
    bus: Arc<EventBus>,
    run_map: Arc<Mutex<HashMap<WorkflowRunId, RunHandle>>>,
}

impl RunTask {
    async fn run(mut self) {
        loop {
            tokio::select! {
                msg = self.events_rx.recv() => match msg {
                    Some(ExecutorEvent::ArtifactEmitted { artifact, output_name }) => {
                        self.on_artifact_emitted(artifact, output_name).await;
                    }
                    Some(ExecutorEvent::StatusChanged { instance_id, status, parked_reason, terminal_meta }) => {
                        if self.on_status_changed(instance_id, status, parked_reason, terminal_meta).await {
                            break;
                        }
                    }
                    None => break,
                },
                msg = self.control_rx.recv() => match msg {
                    Some(ControlMsg::Decision { stage_instance_id, payload, reply_tx }) => {
                        let result = self.on_decision(stage_instance_id, payload).await;
                        let _ = reply_tx.send(result);
                    }
                    Some(ControlMsg::Cancel) => {
                        self.on_cancel().await;
                        break;
                    }
                    None => break,
                },
            }
        }
        self.run_map.lock().await.remove(&self.run_id);
        self.bus.cleanup_run(self.run_id);
    }

    async fn prime_source_stages(&mut self) {
        let sources: Vec<StageKey> = self.def.graph.stages.keys()
            .filter(|k| self.all_required_inputs_satisfied(k))
            .cloned()
            .collect();
        for key in sources {
            self.activate_stage(&key).await;
        }
    }

    fn all_required_inputs_satisfied(&self, stage_key: &StageKey) -> bool {
        let node = match self.def.graph.stages.get(stage_key) {
            Some(n) => n,
            None => return false,
        };
        node.inputs.iter()
            .filter(|slot| !slot.optional)
            .all(|slot| self.resolved.contains_key(&(stage_key.clone(), slot.name.clone())))
    }

    async fn activate_stage(&mut self, stage_key: &StageKey) {
        if self.index.contains_key(stage_key) {
            return;
        }
        let node = match self.def.graph.stages.get(stage_key) {
            Some(n) => n.clone(),
            None => return,
        };

        let si_id = StageInstanceId(Uuid::new_v4());

        let st = match self.stage_types.get(&node.stage_type) {
            Some(st) => st,
            None => {
                tracing::error!(stage_key, stage_type = node.stage_type, "stage type not registered");
                self.fail_activation(
                    stage_key,
                    si_id,
                    Some(serde_json::json!({"error": "stage type not registered", "stage_type": node.stage_type})),
                )
                .await;
                return;
            }
        };

        let inputs: HashMap<String, Artifact> = node.inputs.iter()
            .filter_map(|slot| {
                self.resolved.get(&(stage_key.clone(), slot.name.clone()))
                    .map(|a| (slot.name.clone(), a.clone()))
            })
            .collect();

        let config = match st.build_config(&node.config, &inputs, &node.outputs, si_id, &self.run_context).await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(stage_key, "build_config failed: {}", e);
                self.fail_activation(
                    stage_key,
                    si_id,
                    Some(serde_json::json!({"error": e.to_string()})),
                )
                .await;
                return;
            }
        };
        let now = Utc::now();
        let si = StageInstance {
            id: si_id,
            run_id: self.run_id,
            stage_key: stage_key.clone(),
            stage_type: node.stage_type.clone(),
            status: StageStatus::Pending,
            config: config.clone(),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: None,
            ended_at: None,
            created_at: now,
            updated_at: now,
        };
        if let Err(e) = queries::insert_stage_instance(&self.db, &si).await {
            tracing::error!(stage_key, "insert_stage_instance failed: {}", e);
            self.fail_activation(
                stage_key,
                si_id,
                Some(serde_json::json!({"error": e.to_string()})),
            )
            .await;
            return;
        }
        self.index.insert(stage_key.clone(), (si_id, StageStatus::Pending));

        let ctx = StageContext::new(
            StageInstanceSummary::from(&si),
            config,
            inputs,
            self.events_tx.clone(),
            self.db.clone(),
            self.artifact_types.clone(),
        );
        match st.execute(ctx).await {
            Ok(handle) => { self.handles.insert(si_id, handle); }
            Err(e) => {
                tracing::error!(stage_key, "execute failed: {}", e);
                // Mark Failed so quiescence fires and the run is terminated.
                if let Some((_, ref mut s)) = self.index.get_mut(stage_key) {
                    *s = StageStatus::Failed;
                }
                let _ = queries::update_stage_instance_status_with_terminal_meta(
                    &self.db,
                    &si_id,
                    StageStatus::Failed,
                    None,
                    Some(serde_json::json!({"error": e.to_string()})),
                    None,
                    Some(Utc::now()),
                )
                .await;
                let _ = self.events_tx.send(ExecutorEvent::StatusChanged {
                    instance_id: si_id,
                    status: StageStatus::Failed,
                    parked_reason: None,
                    terminal_meta: None,
                }).await;
            }
        }
    }

    /// Mark a stage that could not be launched (unregistered type, build_config
    /// failure, or insert failure) as Failed in-memory and emit a StatusChanged so
    /// the run reaches quiescence as Failed instead of hanging in Running forever.
    async fn fail_activation(
        &mut self,
        stage_key: &StageKey,
        si_id: StageInstanceId,
        terminal_meta: Option<Value>,
    ) {
        self.index.insert(stage_key.clone(), (si_id, StageStatus::Failed));
        let _ = self.events_tx.send(ExecutorEvent::StatusChanged {
            instance_id: si_id,
            status: StageStatus::Failed,
            parked_reason: None,
            terminal_meta,
        }).await;
    }

    async fn on_artifact_emitted(&mut self, artifact: Artifact, output_name: String) {
        self.bus.publish(self.run_id, SubstrateEvent::ArtifactEmitted {
            artifact_id: artifact.id,
            artifact_type: artifact.artifact_type.clone(),
            producer_stage_id: artifact.stage_instance_id,
            parent_artifact_id: artifact.parent_artifact_id,
        });

        let producer_key = self.index.iter()
            .find(|(_, (id, _))| *id == artifact.stage_instance_id)
            .map(|(k, _)| k.clone());
        let producer_key = match producer_key {
            Some(k) => k,
            None => return,
        };

        let edges: Vec<_> = self.def.graph.edges.iter()
            .filter(|e| e.from.stage == producer_key && e.from.slot == output_name)
            .cloned()
            .collect();

        for edge in edges {
            let consumer_key = edge.to.stage.clone();
            let slot_name = edge.to.slot.clone();
            self.resolved.insert((consumer_key.clone(), slot_name), artifact.clone());

            if let Some((si_id, status)) = self.index.get(&consumer_key).cloned() {
                // Pending stages have a handle but haven't emitted Running yet; treat
                // them as live so feedback artifacts are not silently dropped.
                if matches!(status, StageStatus::Pending | StageStatus::Running | StageStatus::Parked) {
                    if let Some(handle) = self.handles.get(&si_id) {
                        let _ = handle.resume(ResumePayload::FeedbackArtifact {
                            artifact: artifact.clone(),
                        }).await;
                        self.bus.publish(self.run_id, SubstrateEvent::StageResumed {
                            stage_instance_id: si_id,
                            resume_kind: "feedback_artifact".to_string(),
                        });
                    }
                    continue;
                }
                // Done/Failed: consumer is in index but terminal — don't re-activate.
                continue;
            }

            if self.all_required_inputs_satisfied(&consumer_key) {
                self.activate_stage(&consumer_key).await;
            }
        }
    }

    /// Returns true when the run has reached a terminal state.
    async fn on_status_changed(
        &mut self,
        instance_id: StageInstanceId,
        status: StageStatus,
        parked_reason: Option<String>,
        terminal_meta: Option<Value>,
    ) -> bool {
        for (_, (id, s)) in self.index.iter_mut() {
            if *id == instance_id {
                *s = status;
                break;
            }
        }
        if matches!(status, StageStatus::Done | StageStatus::Failed) {
            self.handles.remove(&instance_id);
        }

        self.bus.publish(self.run_id, SubstrateEvent::StageStatusChanged {
            stage_instance_id: instance_id,
            status,
            parked_reason,
            terminal_meta,
        });

        // quiescence: no stage is pending|running|parked
        let active = self.index.values()
            .any(|(_, s)| matches!(s, StageStatus::Pending | StageStatus::Running | StageStatus::Parked));
        if active || self.index.is_empty() {
            return false;
        }

        let final_status = if self.index.values().any(|(_, s)| matches!(s, StageStatus::Failed)) {
            RunStatus::Failed
        } else {
            RunStatus::Done
        };

        let _ = queries::update_workflow_run_status(&self.db, &self.run_id, final_status).await;
        self.bus.publish(self.run_id, SubstrateEvent::RunStatusChanged {
            run_id: self.run_id,
            status: final_status,
        });
        true
    }

    async fn on_decision(
        &mut self,
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
    ) -> Result<(), DecisionError> {
        let resume_kind = match &payload {
            ResumePayload::GateDecision { .. } => "gate_decision",
            ResumePayload::FeedbackArtifact { .. } => "feedback_artifact",
            ResumePayload::Executor { .. } => "executor",
        };
        let current = queries::get_stage_instance_by_id(&self.db, &stage_instance_id)
            .await
            .map_err(|e| match e {
                crate::Error::NotFound { .. } => DecisionError::Conflict(format!(
                    "stage instance {} not found",
                    stage_instance_id.0
                )),
                other => DecisionError::Internal(anyhow::Error::new(other)),
            })?;

        if current.run_id != self.run_id {
            return Err(DecisionError::Conflict(format!(
                "stage instance {} does not belong to run {}",
                stage_instance_id.0,
                self.run_id.0
            )));
        }

        if !matches!(current.status, StageStatus::Parked) {
            return Err(DecisionError::Conflict(format!(
                "stage instance {} is not parked (status: {:?})",
                stage_instance_id.0, current.status
            )));
        }

        let (stage_key, indexed_id, status) = match self.index.get(&current.stage_key) {
            Some((indexed_id, status)) => (current.stage_key.clone(), *indexed_id, *status),
            None => {
                return Err(DecisionError::Conflict(format!(
                    "stage instance {} is not known to this run",
                    stage_instance_id.0
                )));
            }
        };

        if indexed_id != stage_instance_id {
            return Err(DecisionError::Conflict(format!(
                "stage instance {} is stale for stage {}; active instance is {}",
                stage_instance_id.0,
                stage_key,
                indexed_id.0
            )));
        }

        if !matches!(status, StageStatus::Parked) {
            return Err(DecisionError::Conflict(format!(
                "stage instance {} is not parked (status: {:?})",
                stage_instance_id.0, status
            )));
        }

        let handle = match self.handles.get(&stage_instance_id) {
            Some(handle) => handle,
            None => {
                return Err(DecisionError::Conflict(format!(
                    "stage instance {} has no active handle",
                    stage_instance_id.0
                )));
            }
        };

        handle.resume(payload).await.map_err(|e| DecisionError::Internal(e.into()))?;

        let after_resume = queries::get_stage_instance_by_id(&self.db, &stage_instance_id)
            .await
            .map_err(|e| match e {
                crate::Error::NotFound { .. } => DecisionError::Conflict(format!(
                    "stage instance {} not found after resume",
                    stage_instance_id.0
                )),
                other => DecisionError::Internal(anyhow::Error::new(other)),
            })?;

        // Delegated sessions use a two-step gate: artifact approval keeps the
        // stage parked until the explicit merge-confirmation decision arrives.
        let keep_parked_for_merge_confirmation = after_resume
            .stage_type
            == "delegated_session"
            && after_resume
                .parked_meta
                .as_ref()
                .and_then(|meta| serde_json::from_value::<
                    crate::executor::delegated_session::DelegatedGateState,
                >(meta.clone()).ok())
                .map(|gate_state| {
                    matches!(
                        gate_state.gate,
                        crate::executor::delegated_session::DelegatedGate::MergeConfirmation
                    )
                })
                .unwrap_or(false);

        if matches!(after_resume.status, StageStatus::Parked) && !keep_parked_for_merge_confirmation {
            let started_at = after_resume.started_at.or(Some(Utc::now()));
            let updated = queries::update_stage_instance_status_if_current_status_with_terminal_meta(
                &self.db,
                &stage_instance_id,
                StageStatus::Parked,
                StageStatus::Running,
                None,
                None,
                started_at,
                None,
            )
            .await
            .map_err(|e| DecisionError::Internal(anyhow::Error::new(e)))?;

            if updated {
                if let Some((_, s)) = self.index.get_mut(&stage_key) {
                    *s = StageStatus::Running;
                }
                self.bus.publish(self.run_id, SubstrateEvent::StageStatusChanged {
                    stage_instance_id,
                    status: StageStatus::Running,
                    parked_reason: None,
                    terminal_meta: None,
                });
            }
        }

        self.bus.publish(self.run_id, SubstrateEvent::StageResumed {
            stage_instance_id,
            resume_kind: resume_kind.to_string(),
        });
        Ok(())
    }

    async fn on_cancel(&mut self) {
        for handle in self.handles.values() {
            let _ = handle.cancel().await;
        }
        self.handles.clear();
        let _ = queries::update_workflow_run_status(&self.db, &self.run_id, RunStatus::Failed).await;
        self.bus.publish(self.run_id, SubstrateEvent::RunStatusChanged {
            run_id: self.run_id,
            status: RunStatus::Failed,
        });
    }
}

// ── Coordinator ───────────────────────────────────────────────────────────────

pub struct Coordinator {
    db: Arc<SqlitePool>,
    stage_types: Arc<StageTypeRegistry>,
    artifact_types: Arc<ArtifactTypeRegistry>,
    bus: Arc<EventBus>,
    runs: Arc<Mutex<HashMap<WorkflowRunId, RunHandle>>>,
}

impl Coordinator {
    pub fn new(
        db: Arc<SqlitePool>,
        stage_types: Arc<StageTypeRegistry>,
        artifact_types: Arc<ArtifactTypeRegistry>,
        bus: Arc<EventBus>,
    ) -> Self {
        Self { db, stage_types, artifact_types, bus, runs: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn start_run(&self, run_id: WorkflowRunId) -> anyhow::Result<()> {
        // Ignore a duplicate start for an already-scheduled run; a second RunTask
        // would race the first and corrupt shared run state.
        if self.runs.lock().await.contains_key(&run_id) {
            return Ok(());
        }

        let run = queries::get_workflow_run_by_id(&self.db, &run_id).await?;
        let def = queries::get_workflow_def_by_id(&self.db, &run.workflow_def_id).await?;

        // A graph with no stages emits no events, so a spawned RunTask would hang in
        // Running forever with no handle to reap it. Short-circuit to Done.
        if def.graph.stages.is_empty() {
            queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Done).await?;
            self.bus.publish(run_id, SubstrateEvent::RunStatusChanged {
                run_id,
                status: RunStatus::Done,
            });
            return Ok(());
        }

        // Transition run to Running before the scheduler begins executing stages.
        queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Running).await?;
        self.bus.publish(run_id, SubstrateEvent::RunStatusChanged {
            run_id,
            status: RunStatus::Running,
        });

        let (events_tx, events_rx) = mpsc::channel(256);
        let (control_tx, control_rx) = mpsc::channel(64);

        let task = RunTask {
            run_id,
            run_context: run.context,
            def,
            events_rx,
            events_tx,
            control_rx,
            handles: HashMap::new(),
            index: HashMap::new(),
            resolved: HashMap::new(),
            db: self.db.clone(),
            stage_types: self.stage_types.clone(),
            artifact_types: self.artifact_types.clone(),
            bus: self.bus.clone(),
            run_map: self.runs.clone(),
        };

        // Acquire the map lock before spawning so self-reaping cannot race ahead
        // of handle registration.
        let mut runs = self.runs.lock().await;
        if runs.contains_key(&run_id) {
            return Ok(());
        }
        let join = tokio::spawn(async move {
            let mut t = task;
            t.prime_source_stages().await;
            t.run().await;
        });
        runs.insert(run_id, RunHandle { control_tx, join });
        Ok(())
    }

    pub async fn resume_parked_stage_if_active(
        &self,
        run_id: WorkflowRunId,
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
    ) -> Result<(), DecisionError> {
        let run = queries::get_workflow_run_by_id(&self.db, &run_id)
            .await
            .map_err(|e| match e {
                crate::Error::NotFound { .. } => {
                    DecisionError::Conflict(format!("run {} not found", run_id.0))
                }
                other => DecisionError::Internal(anyhow::Error::new(other)),
            })?;
        if !matches!(run.status, RunStatus::Pending | RunStatus::Running) {
            return Err(DecisionError::Conflict(format!(
                "run {} is not active (status: {:?})",
                run_id.0, run.status
            )));
        }

        let tx = {
            let runs = self.runs.lock().await;
            runs
                .get(&run_id)
                .ok_or_else(|| DecisionError::Conflict(format!("run {} not active", run_id.0)))?
                .control_tx
                .clone()
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(ControlMsg::Decision {
            stage_instance_id,
            payload,
            reply_tx,
        })
        .await
        .map_err(|_| DecisionError::Conflict(format!("control channel closed for run {}", run_id.0)))?;

        match timeout(Duration::from_secs(5), reply_rx).await {
            Err(_) => Err(DecisionError::Internal(anyhow::anyhow!(
                "scheduler task did not acknowledge decision for run {} in time",
                run_id.0
            ))),
            Ok(Err(_)) => Err(DecisionError::Conflict(format!(
                "scheduler task ended before acknowledging decision for run {}",
                run_id.0
            ))),
            Ok(Ok(result)) => result,
        }
    }

    pub async fn deliver_decision(
        &self,
        run_id: WorkflowRunId,
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
    ) -> Result<(), DecisionError> {
        self.resume_parked_stage_if_active(run_id, stage_instance_id, payload).await
    }

    /// Recover in-flight runs on boot. Spawns scheduler tasks in recovery mode
    /// (rebuilds index + resolved from DB, re-executes non-terminal stage instances).
    pub async fn recover(&self) -> anyhow::Result<()> {
        let active_runs = queries::list_active_runs(&self.db).await?;
        for run in active_runs {
            let run_id = run.id;
            let def = queries::get_workflow_def_by_id(&self.db, &run.workflow_def_id).await?;

            if def.graph.stages.is_empty() {
                queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Done).await?;
                self.bus.publish(run_id, SubstrateEvent::RunStatusChanged {
                    run_id,
                    status: RunStatus::Done,
                });
                self.bus.cleanup_run(run_id);
                continue;
            }

            if matches!(run.status, RunStatus::Pending) {
                queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Running).await?;
                self.bus.publish(run_id, SubstrateEvent::RunStatusChanged {
                    run_id,
                    status: RunStatus::Running,
                });
            }

            let instances = queries::list_stage_instances_for_run(&self.db, &run_id).await?;
            let artifacts = queries::list_artifacts_for_run(&self.db, &run_id, None).await?;

            let mut resolved: HashMap<(StageKey, String), Artifact> = HashMap::new();
            for artifact in &artifacts {
                let producer_key = instances.iter()
                    .find(|si| si.id == artifact.stage_instance_id)
                    .map(|si| si.stage_key.clone());
                let producer_key = match producer_key { Some(k) => k, None => continue };

                let producer_node = match def.graph.stages.get(&producer_key) {
                    Some(n) => n,
                    None => continue,
                };

                // Resolve the output slot name: use the persisted value when available
                // (set by the executor since migration 0002); fall back to type-matching
                // for pre-migration artifacts where output_name is NULL.
                let output_name: Option<String> = match &artifact.output_name {
                    Some(name) => Some(name.clone()),
                    None => producer_node.outputs.iter()
                        .find(|o| o.artifact_type == artifact.artifact_type)
                        .map(|o| o.name.clone()),
                };
                let output_name = match output_name { Some(n) => n, None => continue };

                for edge in &def.graph.edges {
                    if edge.from.stage == producer_key && edge.from.slot == output_name {
                        let key = (edge.to.stage.clone(), edge.to.slot.clone());
                        let should_use = resolved.get(&key)
                            .map(|e| artifact.created_at > e.created_at)
                            .unwrap_or(true);
                        if should_use {
                            resolved.insert(key, artifact.clone());
                        }
                    }
                }
            }

            let mut index: HashMap<StageKey, (StageInstanceId, StageStatus)> = HashMap::new();
            for si in &instances {
                index.insert(si.stage_key.clone(), (si.id, si.status));
            }

            let (events_tx, events_rx) = mpsc::channel(256);
            let (control_tx, control_rx) = mpsc::channel(64);

            let mut task = RunTask {
                run_id,
                run_context: run.context.clone(),
                def: def.clone(),
                events_rx,
                events_tx: events_tx.clone(),
                control_rx,
                handles: HashMap::new(),
                index,
                resolved,
                db: self.db.clone(),
                stage_types: self.stage_types.clone(),
                artifact_types: self.artifact_types.clone(),
                bus: self.bus.clone(),
                run_map: self.runs.clone(),
            };

            // re-execute non-terminal stage instances; skip Done/Failed
            // Pending is included: a crash between insert_stage_instance and
            // execute left the instance with no handle; re-executing gives it one.
            let non_terminal: Vec<StageInstance> = instances.into_iter()
                .filter(|si| matches!(si.status, StageStatus::Pending | StageStatus::Running | StageStatus::Parked))
                .collect();

            for si in non_terminal {
                let node = match def.graph.stages.get(&si.stage_key) {
                    Some(n) => n.clone(),
                    None => continue,
                };
                let st = match self.stage_types.get(&node.stage_type) {
                    Some(st) => st,
                    None => continue,
                };
                let inputs: HashMap<String, Artifact> = node.inputs.iter()
                    .filter_map(|slot| {
                        task.resolved.get(&(si.stage_key.clone(), slot.name.clone()))
                            .map(|a| (slot.name.clone(), a.clone()))
                    })
                    .collect();
                let ctx = StageContext::new(
                    StageInstanceSummary::from(&si),
                    si.config.clone(),
                    inputs,
                    events_tx.clone(),
                    self.db.clone(),
                    self.artifact_types.clone(),
                );
                match st.execute(ctx).await {
                    Ok(handle) => { task.handles.insert(si.id, handle); }
                    Err(e) => {
                        tracing::error!(stage_key = si.stage_key, "recovery execute failed: {}", e);
                        if let Some((_, ref mut s)) = task.index.get_mut(&si.stage_key) {
                            *s = StageStatus::Failed;
                        }
                        let _ = queries::update_stage_instance_status_with_terminal_meta(
                            &self.db,
                            &si.id,
                            StageStatus::Failed,
                            None,
                            Some(serde_json::json!({"error": e.to_string()})),
                            None,
                            Some(Utc::now()),
                        )
                        .await;
                        let _ = events_tx.send(ExecutorEvent::StatusChanged {
                            instance_id: si.id,
                            status: StageStatus::Failed,
                            parked_reason: None,
                            terminal_meta: Some(serde_json::json!({"error": e.to_string()})),
                        }).await;
                    }
                }
            }

            task.prime_source_stages().await;

            // Acquire the map lock before spawning so self-reaping cannot race
            // ahead of handle registration.
            let mut runs = self.runs.lock().await;
            if runs.contains_key(&run_id) {
                continue;
            }
            let join = tokio::spawn(async move { task.run().await });
            runs.insert(run_id, RunHandle { control_tx, join });
        }
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::events::{BackfillScope, EventBus};
    use crate::executor::{EmitArgs, ResumePayload, StageContext, StageHandle};
    use crate::registry::{ArtifactTypeDef, ArtifactTypeRegistry, StageTypeRegistry};
    use crate::types::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;
    use uuid::Uuid;

    // ── helpers ───────────────────────────────────────────────────────────────

    async fn make_pool() -> Arc<SqlitePool> {
        let path = format!("/tmp/oakridge_sched_test_{}.db", Uuid::new_v4());
        Arc::new(crate::db::init_pool(&format!("sqlite:{}", path)).await.unwrap())
    }

    fn make_artifact_registry() -> Arc<ArtifactTypeRegistry> {
        let mut reg = ArtifactTypeRegistry::new();
        reg.register(ArtifactTypeDef { id: "any".into(), validate: |_| Ok(()), component_id: "v".into() });
        Arc::new(reg)
    }

    fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    async fn insert_run_for_def(pool: &SqlitePool, def: &WorkflowDef) -> WorkflowRunId {
        queries::insert_workflow_def(pool, def).await.unwrap();
        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_workflow_run(pool, &run).await.unwrap();
        run.id
    }

    // ── scripted dummy stage type ─────────────────────────────────────────────

    struct DummyHandle {
        resume_tx: mpsc::Sender<ResumePayload>,
    }

    #[async_trait]
    impl StageHandle for DummyHandle {
        async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()> {
            let _ = self.resume_tx.send(payload).await;
            Ok(())
        }
        async fn cancel(&self) -> anyhow::Result<()> { Ok(()) }
    }

    struct ScriptedStageType {
        type_id: String,
        ctx_tx: mpsc::Sender<(StageContext, mpsc::Receiver<ResumePayload>)>,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for ScriptedStageType {
        fn id(&self) -> &str { &self.type_id }

        async fn build_config(
            &self, def_config: &Value, _inputs: &HashMap<String, Artifact>,
            _output_slots: &[crate::types::OutputSlot], _stage_instance_id: crate::types::StageInstanceId,
            _run_context: &Value,
        ) -> anyhow::Result<Value> { Ok(def_config.clone()) }

        async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            let (resume_tx, resume_rx) = mpsc::channel(8);
            let _ = self.ctx_tx.send((ctx, resume_rx)).await;
            Ok(Box::new(DummyHandle { resume_tx }))
        }
    }

    fn scripted(type_id: &str) -> (
        Arc<ScriptedStageType>,
        mpsc::Receiver<(StageContext, mpsc::Receiver<ResumePayload>)>,
    ) {
        let (tx, rx) = mpsc::channel(8);
        (Arc::new(ScriptedStageType { type_id: type_id.to_string(), ctx_tx: tx }), rx)
    }

    fn timeout_dur() -> std::time::Duration {
        std::time::Duration::from_secs(5)
    }

    async fn wait_run_done(pool: &SqlitePool, run_id: WorkflowRunId) {
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(pool, &run_id).await.unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                return;
            }
        }
        panic!("run did not reach terminal status");
    }

    #[tokio::test]
    async fn fresh_activation_passes_stage_instance_summary_into_context() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let (sa, mut a_rx) = scripted("st_a");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg, EventBus::new());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(),
                        config: json!({ "mode": "fresh" }),
                        inputs: vec![],
                        outputs: vec![],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        let (ctx, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let summary = ctx.stage_instance_summary();
        assert_eq!(summary.stage_instance_id, ctx.stage_instance_id);
        assert_eq!(summary.workflow_run_id, run_id);
        assert_eq!(summary.stage_key, "A");
        assert_eq!(summary.status, StageStatus::Pending);
        assert!(summary.parked_reason.is_none());
        assert!(summary.parked_meta.is_none());
        assert!(summary.external_ref.is_none());
    }

    // ── (a) two-stage end-to-end ──────────────────────────────────────────────

    #[tokio::test]
    async fn two_stage_end_to_end() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let (sb, mut b_rx) = scripted("st_b");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);
        reg.register(sb);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg, bus.clone());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![],
                        outputs: vec![OutputSlot { name: "out".into(), artifact_type: "any".into() }],
                    });
                    m.insert("B".into(), StageNodeDef {
                        stage_type: "st_b".into(), config: json!({}),
                        inputs: vec![InputSlot { name: "in".into(), artifact_type: "any".into(), optional: false }],
                        outputs: vec![],
                    });
                    m
                },
                edges: vec![Edge {
                    from: EdgeEndpoint { stage: "A".into(), slot: "out".into() },
                    to: EdgeEndpoint { stage: "B".into(), slot: "in".into() },
                }],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        let mut global_rx = bus.subscribe_global();

        coord.start_run(run_id).await.unwrap();

        let (ctx_a, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await.unwrap().unwrap();

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a.emit(EmitArgs {
            output_name: "out".into(), artifact_type: "any".into(),
            body: json!({"v": 1}), label: None, parent_artifact_id: None,
        }).await.unwrap();
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        let (ctx_b, _) = tokio::time::timeout(timeout_dur(), b_rx.recv())
            .await.unwrap().unwrap();
        ctx_b.set_status(StageStatus::Running, None).await.unwrap();
        ctx_b.set_status(StageStatus::Done, None).await.unwrap();

        // Drain bus events, find RunStatusChanged Done
        let mut saw_run_done = false;
        for _ in 0..30 {
            match tokio::time::timeout(timeout_dur(), global_rx.recv()).await {
                Ok(Ok(ev)) => {
                    if matches!(ev.event, SubstrateEvent::RunStatusChanged { status: RunStatus::Done, .. }) {
                        saw_run_done = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(saw_run_done, "run must publish RunStatusChanged Done");

        let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(run.status, RunStatus::Done);

        // Global ring persists after run cleanup; verify events were published.
        let (events, _) = bus.backfill(BackfillScope::Global, 0);
        assert!(!events.is_empty(), "global backfill must contain events from the run");
    }

    // ── (b) cycle A->B->A feedback ────────────────────────────────────────────

    #[tokio::test]
    async fn cycle_feedback_no_unbounded_spawning() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let (sb, mut b_rx) = scripted("st_b");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);
        reg.register(sb);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg, bus.clone());

        // A: optional in_a (cycle), out_a -> B.in_b
        // B: required in_b, out_b -> A.in_a
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![InputSlot { name: "in_a".into(), artifact_type: "any".into(), optional: true }],
                        outputs: vec![OutputSlot { name: "out_a".into(), artifact_type: "any".into() }],
                    });
                    m.insert("B".into(), StageNodeDef {
                        stage_type: "st_b".into(), config: json!({}),
                        inputs: vec![InputSlot { name: "in_b".into(), artifact_type: "any".into(), optional: false }],
                        outputs: vec![OutputSlot { name: "out_b".into(), artifact_type: "any".into() }],
                    });
                    m
                },
                edges: vec![
                    Edge {
                        from: EdgeEndpoint { stage: "A".into(), slot: "out_a".into() },
                        to: EdgeEndpoint { stage: "B".into(), slot: "in_b".into() },
                    },
                    Edge {
                        from: EdgeEndpoint { stage: "B".into(), slot: "out_b".into() },
                        to: EdgeEndpoint { stage: "A".into(), slot: "in_a".into() },
                    },
                ],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        // A is source (optional in_a satisfied trivially)
        let (ctx_a, mut resume_rx_a) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await.unwrap().unwrap();

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a.emit(EmitArgs {
            output_name: "out_a".into(), artifact_type: "any".into(),
            body: json!({"round": 1}), label: None, parent_artifact_id: None,
        }).await.unwrap();

        // B activates after receiving A's artifact
        let (ctx_b, _) = tokio::time::timeout(timeout_dur(), b_rx.recv())
            .await.unwrap().unwrap();
        ctx_b.set_status(StageStatus::Running, None).await.unwrap();
        ctx_b.emit(EmitArgs {
            output_name: "out_b".into(), artifact_type: "any".into(),
            body: json!({"round": 1}), label: None, parent_artifact_id: None,
        }).await.unwrap();

        // B's emit triggers FeedbackArtifact to A (A is still Running)
        let fb = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await.unwrap().unwrap();
        assert!(matches!(fb, ResumePayload::FeedbackArtifact { .. }), "expected FeedbackArtifact on A");

        // stop condition: both mark Done
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();
        ctx_b.set_status(StageStatus::Done, None).await.unwrap();

        // B was not activated again (no second execute call)
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(b_rx.try_recv().is_err(), "B must not be spawned again");

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(run.status, RunStatus::Done);
    }

    // ── (c) parked -> gate decision -> Done ───────────────────────────────────

    #[tokio::test]
    async fn parked_stage_resumes_on_gate_decision() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg.clone(), bus.clone());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![], outputs: vec![
                            OutputSlot { name: "out".into(), artifact_type: "any".into() },
                        ],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        let (ctx_a, mut resume_rx_a) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await.unwrap().unwrap();

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        let artifact = ctx_a.emit(EmitArgs {
            output_name: "out".into(), artifact_type: "any".into(),
            body: json!({"content": "review"}), label: None, parent_artifact_id: None,
        }).await.unwrap();
        ctx_a.set_status(StageStatus::Parked, Some("waiting_gate".into())).await.unwrap();

        let si_id = ctx_a.stage_instance_id;

        // inject gate decision
        coord.deliver_decision(run_id, si_id, ResumePayload::GateDecision {
            decision: GateDecision { outcome: GateOutcome::Pass, comment: None, feedback: None },
            against_artifact_id: artifact.id,
        }).await.unwrap();

        let resume = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await.unwrap().unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));

        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(run.status, RunStatus::Done);
    }

    // ── (d) crash recovery ────────────────────────────────────────────────────

    #[tokio::test]
    async fn crash_recovery_reactivates_parked_stage() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg.clone(), bus.clone());

        // Seed DB directly (simulating a crashed run)
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![], outputs: vec![],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        queries::insert_workflow_def(&pool, &def).await.unwrap();

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
        queries::insert_workflow_run(&pool, &run).await.unwrap();

        let si = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "A".into(),
            stage_type: "st_a".into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("waiting_gate".into()),
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        let artifact = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: si.id,
            artifact_type: "any".into(),
            output_name: None,
            label: None,
            body: json!({"seeded": true}),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };
        queries::insert_artifact(&pool, &artifact).await.unwrap();

        // Recover — parked stage should be re-executed
        coord.recover().await.unwrap();

        let (ctx_a, mut resume_rx_a) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await.unwrap().unwrap();
        assert_eq!(ctx_a.stage_instance_id, si.id, "recovered stage must use existing instance id");

        // inject decision
        coord.deliver_decision(run.id, si.id, ResumePayload::GateDecision {
            decision: GateDecision { outcome: GateOutcome::Pass, comment: None, feedback: None },
            against_artifact_id: artifact.id,
        }).await.unwrap();

        let resume = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await.unwrap().unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));

        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run_final.status, RunStatus::Done);
    }

    // ── (e) crash recovery primes missing source stages ───────────────────────

    #[tokio::test]
    async fn crash_recovery_primes_missing_source_stages_and_marks_pending_running() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg, bus.clone());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![], outputs: vec![],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        queries::insert_workflow_def(&pool, &def).await.unwrap();

        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_workflow_run(&pool, &run).await.unwrap();

        let mut global_rx = bus.subscribe_global();

        coord.recover().await.unwrap();

        let run_after = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run_after.status, RunStatus::Running, "recovered pending run must be promoted to Running");

        let first_event = tokio::time::timeout(timeout_dur(), global_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            first_event.event,
            SubstrateEvent::RunStatusChanged { status: RunStatus::Running, .. }
        ));

        let stage_instances = queries::list_stage_instances_for_run(&pool, &run.id).await.unwrap();
        assert_eq!(stage_instances.len(), 1, "recover must prime the missing source stage once");

        let (ctx_a, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stage_instances[0].stage_key, "A");
        assert_eq!(ctx_a.stage_instance_id, stage_instances[0].id);

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run_final.status, RunStatus::Done);
    }

    // ── (f) crash recovery reuses persisted stages and primes gaps ───────────

    #[tokio::test]
    async fn crash_recovery_reuses_persisted_stages_and_primes_missing_sources() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();

        let (sa, mut a_rx) = scripted("st_a");
        let mut reg = StageTypeRegistry::new();
        reg.register(sa);

        let coord = Coordinator::new(pool.clone(), Arc::new(reg), artifact_reg, bus.clone());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![], outputs: vec![],
                    });
                    m.insert("B".into(), StageNodeDef {
                        stage_type: "st_a".into(), config: json!({}),
                        inputs: vec![], outputs: vec![],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        queries::insert_workflow_def(&pool, &def).await.unwrap();

        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_workflow_run(&pool, &run).await.unwrap();

        let persisted_a = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "A".into(),
            stage_type: "st_a".into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("waiting_gate".into()),
            parked_meta: Some(json!({"request_id": "req-1"})),
            terminal_meta: None,
            external_ref: Some("ext-123".into()),
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &persisted_a).await.unwrap();

        coord.recover().await.unwrap();

        let mut contexts = vec![];
        for _ in 0..2 {
            let (ctx, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
                .await
                .unwrap()
                .unwrap();
            contexts.push(ctx);
        }

        let ids: Vec<_> = contexts.iter().map(|ctx| ctx.stage_instance_id).collect();
        assert!(ids.contains(&persisted_a.id), "recover must reuse the persisted stage instance");
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "recover must prime exactly one missing stage instance");

        let recovered = contexts
            .iter()
            .find(|ctx| ctx.stage_instance_id == persisted_a.id)
            .expect("persisted stage instance context must be present");
        let summary = recovered.stage_instance_summary();
        assert_eq!(summary.stage_instance_id, persisted_a.id);
        assert_eq!(summary.workflow_run_id, run.id);
        assert_eq!(summary.stage_key, "A");
        assert_eq!(summary.status, StageStatus::Parked);
        assert_eq!(summary.parked_reason.as_deref(), Some("waiting_gate"));
        assert_eq!(summary.parked_meta, Some(json!({"request_id": "req-1"})));
        assert_eq!(summary.external_ref.as_deref(), Some("ext-123"));

        let stage_instances = queries::list_stage_instances_for_run(&pool, &run.id).await.unwrap();
        assert_eq!(stage_instances.len(), 2, "recover must not duplicate persisted stage instances");

        for ctx in contexts {
            ctx.set_status(StageStatus::Running, None).await.unwrap();
            ctx.set_status(StageStatus::Done, None).await.unwrap();
        }

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run_final.status, RunStatus::Done);
    }

    // ── (g) empty graph short-circuits to Done ────────────────────────────────

    #[tokio::test]
    async fn empty_graph_run_short_circuits_to_done() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        let coord = Coordinator::new(pool.clone(), Arc::new(StageTypeRegistry::new()), artifact_reg, bus);

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph { stages: HashMap::new(), edges: vec![] },
            created_at: fixed_dt(),
        };
        let run_id = insert_run_for_def(&pool, &def).await;

        // start_run handles an empty graph synchronously, so the run is terminal on return.
        coord.start_run(run_id).await.unwrap();

        let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(run.status, RunStatus::Done, "empty-graph run must short-circuit to Done, not hang");
    }

    // ── (h) unregistered stage type fails the run ─────────────────────────────

    #[tokio::test]
    async fn unregistered_stage_type_fails_run() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        // Register no stage types: the source stage's type is unresolved at activation.
        let coord = Coordinator::new(pool.clone(), Arc::new(StageTypeRegistry::new()), artifact_reg, bus);

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert("A".into(), StageNodeDef {
                        stage_type: "missing_type".into(), config: json!({}),
                        inputs: vec![], outputs: vec![],
                    });
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id).await.unwrap();
        assert_eq!(run.status, RunStatus::Failed, "unregistered stage type must fail the run, not hang in Running");
    }
}
