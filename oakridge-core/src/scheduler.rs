use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::db::queries;
use crate::events::{EventBus, SubstrateEvent};
use crate::executor::{ExecutorEvent, ResumePayload, StageContext, StageHandle};
use crate::registry::{ArtifactTypeRegistry, StageTypeRegistry};
use crate::types::{
    Artifact, ResolvedInput, RunStatus, StageInstance, StageInstanceId, StageInstanceSummary, StageKey,
    StageStatus, StageTypeId, WorkflowDef, WorkflowRunId,
};
use crate::executor::delegated_session::config::{DelegatedSessionConfig, DelegatedSessionDefConfig};
use crate::executor::prompt_config::SlotBinding;

// ── Control messages ──────────────────────────────────────────────────────────

pub enum ControlMsg {
    Decision {
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
        reply_tx: oneshot::Sender<Result<(), DecisionError>>,
    },
    Cancel,
    /// Park a specific Running stage as stuck_timeout. The RunTask cancels the
    /// stage handle (if present), records cancellation_delivered in parked_meta,
    /// parks the stage in DB with a CAS, updates its in-memory index, and
    /// publishes a StageStatusChanged event so quiescence fires.
    ParkStuckStage {
        stage_instance_id: StageInstanceId,
        /// Partial parked_meta template; cancellation_delivered is added by RunTask.
        parked_meta_template: serde_json::Value,
        reply_tx: oneshot::Sender<bool>,
    },
    RetryStuckStage {
        stage_instance_id: StageInstanceId,
        unit_id: Option<String>,
        reply_tx: oneshot::Sender<Result<(), DecisionError>>,
    },
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
    // (consumer_stage_key, input_slot_name) -> {unit_id -> latest artifact}
    // N=1 implicit unit uses unit_id="0"; N>1 fan-out populates one entry per unit.
    resolved: HashMap<(StageKey, String), std::collections::BTreeMap<String, Artifact>>,
    db: Arc<SqlitePool>,
    stage_types: Arc<StageTypeRegistry>,
    artifact_types: Arc<ArtifactTypeRegistry>,
    bus: Arc<EventBus>,
    run_map: Arc<Mutex<HashMap<WorkflowRunId, RunHandle>>>,
}

/// Keys a resolved entry by the producer stage and its persisted unit label.
/// Labels are only unique within a producer, while collection fan-in needs to
/// retain artifacts from every producer without collisions. N=1 keeps its
/// conventional label of `0` within that producer namespace.
fn resolved_unit_id(producer_stage: &str, artifact: &Artifact) -> String {
    format!(
        "{}:{}",
        producer_stage,
        artifact.label.as_deref().unwrap_or("0")
    )
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
                    Some(ControlMsg::ParkStuckStage { stage_instance_id, parked_meta_template, reply_tx }) => {
                        let terminal = self.on_park_stuck(stage_instance_id, parked_meta_template).await;
                        let _ = reply_tx.send(true);
                        if terminal {
                            break;
                        }
                    }
                    Some(ControlMsg::RetryStuckStage { stage_instance_id, unit_id, reply_tx }) => {
                        self.on_retry_stuck(stage_instance_id, unit_id, reply_tx).await;
                    }
                    None => break,
                },
            }
        }
        self.run_map.lock().await.remove(&self.run_id);
        self.bus.cleanup_run(self.run_id);
    }

    async fn prime_source_stages(&mut self) {
        let sources: Vec<StageKey> = self
            .def
            .graph
            .stages
            .keys()
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
        node.inputs
            .iter()
            .filter(|slot| !slot.optional)
            .all(|slot| {
                if self.input_waits_for_producer_completion(stage_key, slot) {
                    return self.producer_stages_are_done(stage_key, &slot.name);
                }
                self.resolved
                    .get(&(stage_key.clone(), slot.name.clone()))
                    .map(|inner| !inner.is_empty())
                    .unwrap_or(false)
            })
    }

    fn input_waits_for_producer_completion(
        &self,
        stage_key: &StageKey,
        slot: &crate::types::InputSlot,
    ) -> bool {
        slot.collect || self.is_fan_out_over_slot(stage_key, &slot.name)
    }

    fn is_fan_out_over_slot(&self, stage_key: &StageKey, slot_name: &str) -> bool {
        let Some(node) = self.def.graph.stages.get(stage_key) else {
            return false;
        };
        if node.stage_type != "delegated_session" {
            return false;
        }
        let Ok(config) = serde_json::from_value::<DelegatedSessionDefConfig>(node.config.clone()) else {
            return false;
        };
        matches!(
            config.fan_out.map(|fan_out| fan_out.over),
            Some(SlotBinding::Input { input_name, .. }) if input_name == slot_name
        )
    }

    fn producer_stages_are_done(&self, consumer_key: &StageKey, slot_name: &str) -> bool {
        let producers: Vec<&StageKey> = self
            .def
            .graph
            .edges
            .iter()
            .filter(|edge| edge.to.stage == *consumer_key && edge.to.slot == slot_name)
            .map(|edge| &edge.from.stage)
            .collect();
        !producers.is_empty() && producers.iter().all(|producer| {
            self.index
                .get(*producer)
                .map(|(_, status)| *status == StageStatus::Done)
                .unwrap_or(false)
        })
    }

    fn resolved_inputs(
        &self,
        stage_key: &StageKey,
        node: &crate::types::StageNodeDef,
    ) -> Result<HashMap<String, ResolvedInput>, String> {
        let mut inputs = HashMap::new();
        for slot in &node.inputs {
            let values = self
                .resolved
                .get(&(stage_key.clone(), slot.name.clone()))
                .cloned()
                .unwrap_or_default();
            if slot.collect || self.is_fan_out_over_slot(stage_key, &slot.name) {
                if values.is_empty() && !slot.optional {
                    return Err(format!(
                        "required collection input '{}' has no producer artifacts",
                        slot.name
                    ));
                }
                inputs.insert(slot.name.clone(), ResolvedInput::Collection(values));
            } else if values.len() == 1 {
                let artifact = values.into_values().next().expect("one resolved input");
                inputs.insert(slot.name.clone(), ResolvedInput::Single(artifact));
            } else if values.len() > 1 {
                return Err(format!(
                    "input '{}' has {} producer units but is not collect:true",
                    slot.name,
                    values.len()
                ));
            }
        }
        Ok(inputs)
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
                tracing::error!(
                    stage_key,
                    stage_type = node.stage_type,
                    "stage type not registered"
                );
                self.fail_activation(
                    stage_key,
                    si_id,
                    node.stage_type.clone(),
                    node.config.clone(),
                    Some(serde_json::json!({"error": "stage type not registered", "stage_type": node.stage_type})),
                )
                .await;
                return;
            }
        };

        let inputs = match self.resolved_inputs(stage_key, &node) {
            Ok(inputs) => inputs,
            Err(error) => {
                self.fail_activation(
                    stage_key,
                    si_id,
                    node.stage_type.clone(),
                    node.config.clone(),
                    Some(serde_json::json!({"error": error})),
                ).await;
                return;
            }
        };

        let config = match st
            .build_config(
                &node.config,
                &inputs,
                &node.outputs,
                si_id,
                &self.run_context,
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(stage_key, "build_config failed: {}", e);
                self.fail_activation(
                    stage_key,
                    si_id,
                    node.stage_type.clone(),
                    node.config.clone(),
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
                si.stage_type.clone(),
                si.config.clone(),
                Some(serde_json::json!({"error": e.to_string()})),
            )
            .await;
            return;
        }
        self.index
            .insert(stage_key.clone(), (si_id, StageStatus::Pending));

        let ctx = StageContext::new(
            StageInstanceSummary::from(&si),
            config,
            inputs,
            self.events_tx.clone(),
            self.db.clone(),
            self.artifact_types.clone(),
        );
        match st.execute(ctx).await {
            Ok(handle) => {
                self.handles.insert(si_id, handle);
            }
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
                let _ = self
                    .events_tx
                    .send(ExecutorEvent::StatusChanged {
                        instance_id: si_id,
                        status: StageStatus::Failed,
                        parked_reason: None,
                        terminal_meta: Some(serde_json::json!({"error": e.to_string()})),
                    })
                    .await;
            }
        }
    }

    /// Mark a stage that could not be launched (unregistered type, build_config
    /// failure, or insert failure) as Failed in-memory and emit a StatusChanged so
    /// the run reaches quiescence as Failed instead of hanging in Running forever.
    ///
    /// Also persists a minimal Failed stage_instance row (with terminal_meta set)
    /// before emitting, so a consumer of the event can fetch the instance and read
    /// terminal_meta — the primary terminal diagnostic surface. Best-effort: when
    /// the activation failure *is* the insert failure, this persist may fail too, so
    /// we log and still emit the event.
    async fn fail_activation(
        &mut self,
        stage_key: &StageKey,
        si_id: StageInstanceId,
        stage_type: StageTypeId,
        config: Value,
        terminal_meta: Option<Value>,
    ) {
        self.index
            .insert(stage_key.clone(), (si_id, StageStatus::Failed));
        let now = Utc::now();
        let si = StageInstance {
            id: si_id,
            run_id: self.run_id,
            stage_key: stage_key.clone(),
            stage_type,
            status: StageStatus::Failed,
            config,
            parked_reason: None,
            parked_meta: None,
            terminal_meta: terminal_meta.clone(),
            external_ref: None,
            started_at: None,
            ended_at: Some(now),
            created_at: now,
            updated_at: now,
        };
        if let Err(e) = queries::insert_stage_instance(&self.db, &si).await {
            tracing::error!(
                stage_key,
                "fail_activation: persist Failed stage_instance failed: {}",
                e
            );
        }
        let _ = self
            .events_tx
            .send(ExecutorEvent::StatusChanged {
                instance_id: si_id,
                status: StageStatus::Failed,
                parked_reason: None,
                terminal_meta,
            })
            .await;
    }

    async fn on_artifact_emitted(&mut self, artifact: Artifact, output_name: String) {
        self.bus.publish(
            self.run_id,
            SubstrateEvent::ArtifactEmitted {
                artifact_id: artifact.id,
                artifact_type: artifact.artifact_type.clone(),
                producer_stage_id: artifact.stage_instance_id,
                parent_artifact_id: artifact.parent_artifact_id,
            },
        );

        let producer_key = self
            .index
            .iter()
            .find(|(_, (id, _))| *id == artifact.stage_instance_id)
            .map(|(k, _)| k.clone());
        let producer_key = match producer_key {
            Some(k) => k,
            None => return,
        };

        let producer_node = match self.def.graph.stages.get(&producer_key) {
            Some(node) => node,
            None => return,
        };
        if producer_node.stage_type == "delegated_session" {
            return;
        }

        self.propagate_artifact(producer_key, artifact, output_name)
            .await;
    }

    async fn propagate_artifact(
        &mut self,
        producer_key: StageKey,
        artifact: Artifact,
        output_name: String,
    ) {
        let edges: Vec<_> = self
            .def
            .graph
            .edges
            .iter()
            .filter(|e| e.from.stage == producer_key && e.from.slot == output_name)
            .cloned()
            .collect();

        for edge in edges {
            let consumer_key = edge.to.stage.clone();
            let slot_name = edge.to.slot.clone();
            let unit_id = resolved_unit_id(&producer_key, &artifact);
            self.resolved
                .entry((consumer_key.clone(), slot_name))
                .or_default()
                .insert(unit_id, artifact.clone());

            if let Some((si_id, status)) = self.index.get(&consumer_key).cloned() {
                // Pending stages have a handle but haven't emitted Running yet; treat
                // them as live so feedback artifacts are not silently dropped.
                if matches!(
                    status,
                    StageStatus::Pending | StageStatus::Running | StageStatus::Parked
                ) {
                    if let Some(handle) = self.handles.get(&si_id) {
                        let _ = handle
                            .resume(ResumePayload::FeedbackArtifact {
                                artifact: artifact.clone(),
                            })
                            .await;
                        self.bus.publish(
                            self.run_id,
                            SubstrateEvent::StageResumed {
                                stage_instance_id: si_id,
                                resume_kind: "feedback_artifact".to_string(),
                            },
                        );
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

    async fn release_completed_delegated_outputs(
        &mut self,
        stage_key: StageKey,
        stage_instance_id: StageInstanceId,
    ) {
        let node = match self.def.graph.stages.get(&stage_key) {
            Some(node) if node.stage_type == "delegated_session" => node.clone(),
            _ => return,
        };
        let artifacts = match queries::list_artifacts_for_run(&self.db, &self.run_id, None).await {
            Ok(artifacts) => artifacts,
            Err(err) => {
                tracing::error!(
                    stage_key,
                    stage_instance_id = %stage_instance_id.0,
                    "failed to list artifacts for completed delegated stage: {}",
                    err
                );
                return;
            }
        };
        let known_outputs: std::collections::HashMap<String, String> = node
            .outputs
            .iter()
            .map(|slot| (slot.name.clone(), slot.artifact_type.clone()))
            .collect();
        let mut latest_by_output_and_unit: std::collections::HashMap<(String, String), Artifact> =
            std::collections::HashMap::new();
        for artifact in artifacts
            .into_iter()
            .filter(|artifact| artifact.stage_instance_id == stage_instance_id)
        {
            let Some(output_name) = artifact.output_name.clone() else {
                continue;
            };
            if known_outputs.get(&output_name) != Some(&artifact.artifact_type) {
                continue;
            }
            let unit_id = resolved_unit_id(&stage_key, &artifact);
            let key = (output_name.clone(), unit_id);
            let should_use = latest_by_output_and_unit
                .get(&key)
                .map(|current| {
                    artifact.version > current.version
                        || (artifact.version == current.version
                            && artifact.created_at > current.created_at)
                })
                .unwrap_or(true);
            if should_use {
                latest_by_output_and_unit.insert(key, artifact);
            }
        }

        for ((output_name, _unit_id), artifact) in latest_by_output_and_unit {
            self.propagate_artifact(stage_key.clone(), artifact, output_name)
                .await;
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
        if matches!(status, StageStatus::Done) {
            let completed_stage_key = self
                .index
                .iter()
                .find(|(_, (id, _))| *id == instance_id)
                .map(|(stage_key, _)| stage_key.clone());
            if let Some(stage_key) = completed_stage_key {
                self.release_completed_delegated_outputs(stage_key, instance_id)
                    .await;
            }
        }

        self.bus.publish(
            self.run_id,
            SubstrateEvent::StageStatusChanged {
                stage_instance_id: instance_id,
                status,
                parked_reason,
                terminal_meta,
            },
        );

        // quiescence: no stage is pending|running|parked
        let active = self.index.values().any(|(_, s)| {
            matches!(
                s,
                StageStatus::Pending | StageStatus::Running | StageStatus::Parked
            )
        });
        if active || self.index.is_empty() {
            return false;
        }

        let final_status = if self
            .index
            .values()
            .any(|(_, s)| matches!(s, StageStatus::Failed))
        {
            RunStatus::Failed
        } else {
            RunStatus::Done
        };

        let _ = queries::update_workflow_run_status(&self.db, &self.run_id, final_status).await;
        self.bus.publish(
            self.run_id,
            SubstrateEvent::RunStatusChanged {
                run_id: self.run_id,
                status: final_status,
            },
        );
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
                stage_instance_id.0, self.run_id.0
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
                stage_instance_id.0, stage_key, indexed_id.0
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

        handle
            .resume(payload)
            .await
            .map_err(|e| DecisionError::Internal(e.into()))?;

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
        let keep_parked_for_merge_confirmation = after_resume.stage_type == "delegated_session"
            && (serde_json::from_value::<DelegatedSessionDefConfig>(
                self.def.graph.stages.get(&stage_key).map(|node| node.config.clone()).unwrap_or(Value::Null),
            ).ok().and_then(|config| config.fan_out).is_some()
                || after_resume
                    .parked_meta
                    .as_ref()
                    .and_then(|meta| {
                        serde_json::from_value::<
                        crate::executor::delegated_session::DelegatedGateState,
                    >(meta.clone()).ok()
                    })
                    .map(|gate_state| matches!(gate_state.gate, crate::executor::delegated_session::DelegatedGate::MergeConfirmation))
                    .unwrap_or(false));

        if matches!(after_resume.status, StageStatus::Parked) && !keep_parked_for_merge_confirmation
        {
            let started_at = after_resume.started_at.or(Some(Utc::now()));
            let updated =
                queries::update_stage_instance_status_if_current_status_with_terminal_meta(
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
                self.bus.publish(
                    self.run_id,
                    SubstrateEvent::StageStatusChanged {
                        stage_instance_id,
                        status: StageStatus::Running,
                        parked_reason: None,
                        terminal_meta: None,
                    },
                );
            }
        }

        self.bus.publish(
            self.run_id,
            SubstrateEvent::StageResumed {
                stage_instance_id,
                resume_kind: resume_kind.to_string(),
            },
        );
        Ok(())
    }

    async fn on_cancel(&mut self) {
        for handle in self.handles.values() {
            let _ = handle.cancel().await;
        }
        self.handles.clear();
        let _ =
            queries::update_workflow_run_status(&self.db, &self.run_id, RunStatus::Failed).await;
        self.bus.publish(
            self.run_id,
            SubstrateEvent::RunStatusChanged {
                run_id: self.run_id,
                status: RunStatus::Failed,
            },
        );
    }

    /// Park a specific Running stage as stuck_timeout. Cancels its handle (if
    /// present), writes a CAS park to DB, updates the in-memory index, and
    /// publishes events. Returns true when the run has reached quiescence.
    async fn on_park_stuck(
        &mut self,
        stage_instance_id: StageInstanceId,
        parked_meta_template: serde_json::Value,
    ) -> bool {
        // Cancel the live handle if present; record whether it was delivered.
        let cancellation_delivered = if let Some(handle) = self.handles.remove(&stage_instance_id) {
            handle.cancel().await.is_ok()
        } else {
            false
        };

        // Augment the template with the cancellation outcome.
        let mut parked_meta = parked_meta_template;
        if let Some(obj) = parked_meta.as_object_mut() {
            obj.insert(
                "cancellation_delivered".into(),
                serde_json::Value::Bool(cancellation_delivered),
            );
        }

        // CAS-park in DB: only proceeds if still Running.
        let parked =
            queries::park_stage_instance_as_stuck(&self.db, &stage_instance_id, &parked_meta)
                .await
                .unwrap_or(false);

        if !parked {
            return false;
        }

        // Update in-memory index.
        for (_, (id, s)) in self.index.iter_mut() {
            if *id == stage_instance_id {
                *s = StageStatus::Parked;
                break;
            }
        }

        self.bus.publish(
            self.run_id,
            SubstrateEvent::StageStatusChanged {
                stage_instance_id,
                status: StageStatus::Parked,
                parked_reason: Some("stuck_timeout".to_string()),
                terminal_meta: None,
            },
        );

        // Check quiescence: no stage is pending|running.
        let active = self.index.values().any(|(_, s)| {
            matches!(
                s,
                StageStatus::Pending | StageStatus::Running | StageStatus::Parked
            )
        });
        if active || self.index.is_empty() {
            return false;
        }

        let final_status = if self
            .index
            .values()
            .any(|(_, s)| matches!(s, StageStatus::Failed))
        {
            RunStatus::Failed
        } else {
            RunStatus::Done
        };

        let _ = queries::update_workflow_run_status(&self.db, &self.run_id, final_status).await;
        self.bus.publish(
            self.run_id,
            SubstrateEvent::RunStatusChanged {
                run_id: self.run_id,
                status: final_status,
            },
        );
        true
    }

    async fn on_retry_stuck(
        &mut self,
        stage_instance_id: StageInstanceId,
        unit_id: Option<String>,
        reply_tx: oneshot::Sender<Result<(), DecisionError>>,
    ) {
        let mut reply_tx = Some(reply_tx);
        macro_rules! reject_retry {
            ($err:expr) => {{
                if let Some(tx) = reply_tx.take() {
                    let _ = tx.send(Err($err));
                }
                return;
            }};
        }
        let current = match queries::get_stage_instance_by_id(&self.db, &stage_instance_id).await {
            Ok(current) => current,
            Err(e) => reject_retry!(match e {
                crate::Error::NotFound { .. } => DecisionError::Conflict(format!(
                    "stage instance {} not found",
                    stage_instance_id.0
                )),
                other => DecisionError::Internal(anyhow::Error::new(other)),
            }),
        };

        if current.run_id != self.run_id {
            reject_retry!(DecisionError::Conflict(format!(
                "stage instance {} does not belong to run {}",
                stage_instance_id.0, self.run_id.0
            )));
        }
        if let Some(unit_id) = unit_id {
            let handle = match self.handles.get(&stage_instance_id) {
                Some(handle) => handle,
                None => reject_retry!(DecisionError::Conflict(format!(
                    "stage instance {} has no active delegated-session handle",
                    stage_instance_id.0
                ))),
            };
            let result = handle.retry_stuck(Some(unit_id)).await
                .map_err(|err| DecisionError::Conflict(err.to_string()));
            if let Some(tx) = reply_tx.take() {
                let _ = tx.send(result);
            }
            return;
        }
        if !matches!(current.status, StageStatus::Parked)
            || current.parked_reason.as_deref() != Some("stuck_timeout")
        {
            reject_retry!(DecisionError::Conflict(format!(
                "stage instance {} is not parked as stuck_timeout (status: {:?}, parked_reason: {:?})",
                stage_instance_id.0, current.status, current.parked_reason
            )));
        }

        let (indexed_id, indexed_status) = match self.index.get(&current.stage_key).copied() {
            Some(indexed) => indexed,
            None => {
                reject_retry!(DecisionError::Conflict(format!(
                    "stage instance {} is not known to this run",
                    stage_instance_id.0
                )));
            }
        };
        if indexed_id != stage_instance_id {
            reject_retry!(DecisionError::Conflict(format!(
                "stage instance {} is stale for stage {}; active instance is {}",
                stage_instance_id.0, current.stage_key, indexed_id.0
            )));
        }
        if !matches!(indexed_status, StageStatus::Parked) {
            reject_retry!(DecisionError::Conflict(format!(
                "stage instance {} is not parked in scheduler memory (status: {:?})",
                stage_instance_id.0, indexed_status
            )));
        }

        if let Some(handle) = self.handles.remove(&stage_instance_id) {
            let _ = handle.cancel().await;
        }

        let node = match self.def.graph.stages.get(&current.stage_key).cloned() {
            Some(node) => node,
            None => reject_retry!(DecisionError::Conflict(format!(
                "stage '{}' is missing from workflow graph",
                current.stage_key
            ))),
        };
        let st = match self.stage_types.get(&node.stage_type) {
            Some(st) => st,
            None => reject_retry!(DecisionError::Conflict(format!(
                "stage type '{}' is not registered",
                node.stage_type
            ))),
        };

        let updated = match queries::retry_stuck_stage_instance(
            &self.db,
            &stage_instance_id,
            current.started_at,
        )
        .await
        {
            Ok(updated) => updated,
            Err(e) => reject_retry!(DecisionError::Internal(anyhow::Error::new(e))),
        };
        if !updated {
            reject_retry!(DecisionError::Conflict(format!(
                "stage instance {} was no longer stuck-parked when retry was applied",
                stage_instance_id.0
            )));
        }

        let refreshed = match queries::get_stage_instance_by_id(&self.db, &stage_instance_id).await
        {
            Ok(refreshed) => refreshed,
            Err(e) => reject_retry!(DecisionError::Internal(anyhow::Error::new(e))),
        };
        let inputs = match self.resolved_inputs(&current.stage_key, &node) {
            Ok(inputs) => inputs,
            Err(error) => reject_retry!(DecisionError::Conflict(error)),
        };
        let ctx = StageContext::new(
            StageInstanceSummary::from(&refreshed),
            refreshed.config.clone(),
            inputs,
            self.events_tx.clone(),
            self.db.clone(),
            self.artifact_types.clone(),
        );
        if let Some(tx) = reply_tx.take() {
            let _ = tx.send(Ok(()));
        }

        match st.execute(ctx).await {
            Ok(handle) => {
                self.handles.insert(stage_instance_id, handle);
                if let Some((_, status)) = self.index.get_mut(&current.stage_key) {
                    *status = StageStatus::Running;
                }
                self.bus.publish(
                    self.run_id,
                    SubstrateEvent::StageStatusChanged {
                        stage_instance_id,
                        status: StageStatus::Running,
                        parked_reason: None,
                        terminal_meta: None,
                    },
                );
            }
            Err(err) => {
                if let Some((_, status)) = self.index.get_mut(&current.stage_key) {
                    *status = StageStatus::Failed;
                }
                let terminal_meta = serde_json::json!({
                    "kind": "retry_stuck_execute_failed",
                    "error": err.to_string(),
                });
                let _ = queries::update_stage_instance_status_with_terminal_meta(
                    &self.db,
                    &stage_instance_id,
                    StageStatus::Failed,
                    None,
                    Some(terminal_meta.clone()),
                    refreshed.started_at,
                    Some(Utc::now()),
                )
                .await;
                let _ = self
                    .events_tx
                    .send(ExecutorEvent::StatusChanged {
                        instance_id: stage_instance_id,
                        status: StageStatus::Failed,
                        parked_reason: None,
                        terminal_meta: Some(terminal_meta),
                    })
                    .await;
            }
        }
    }
}

// ── Coordinator ───────────────────────────────────────────────────────────────

pub struct Coordinator {
    db: Arc<SqlitePool>,
    stage_types: Arc<StageTypeRegistry>,
    artifact_types: Arc<ArtifactTypeRegistry>,
    bus: Arc<EventBus>,
    runs: Arc<Mutex<HashMap<WorkflowRunId, RunHandle>>>,
    stage_timeout: Duration,
    sweep_interval: Duration,
}

impl Coordinator {
    pub fn new(
        db: Arc<SqlitePool>,
        stage_types: Arc<StageTypeRegistry>,
        artifact_types: Arc<ArtifactTypeRegistry>,
        bus: Arc<EventBus>,
    ) -> Self {
        Self {
            db,
            stage_types,
            artifact_types,
            bus,
            runs: Arc::new(Mutex::new(HashMap::new())),
            stage_timeout: Duration::from_secs(3600),
            sweep_interval: Duration::from_secs(60),
        }
    }

    /// Override the default liveness thresholds. Call before recover()/start_run().
    pub fn with_liveness_config(
        mut self,
        stage_timeout: Duration,
        sweep_interval: Duration,
    ) -> Self {
        self.stage_timeout = stage_timeout;
        self.sweep_interval = sweep_interval;
        self
    }

    /// Spawn a background task that periodically sweeps for stuck Running stages
    /// and parks them as stuck_timeout. Caller retains the JoinHandle for
    /// graceful shutdown; dropping it aborts the task.
    pub fn spawn_stuck_sweeper(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(coordinator.sweep_interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if let Err(e) = coordinator.sweep_stuck_stages().await {
                    tracing::error!("stuck-stage sweep failed: {}", e);
                }
            }
        })
    }

    pub async fn sweep_stuck_stages(&self) -> anyhow::Result<()> {
        let timeout_chrono = chrono::Duration::from_std(self.stage_timeout)
            .unwrap_or(chrono::Duration::seconds(3600));
        let cutoff = Utc::now() - timeout_chrono;

        let stuck = queries::list_running_stage_instances_older_than(&self.db, cutoff).await?;
        if stuck.is_empty() {
            return Ok(());
        }

        let timed_out_at = Utc::now();

        for si in stuck {
            let parked_meta_template = serde_json::json!({
                "kind": "stuck_timeout",
                "timed_out_at": timed_out_at.to_rfc3339(),
                "timeout_seconds": self.stage_timeout.as_secs(),
                "last_update_at": si.updated_at.to_rfc3339(),
                "stage_type": si.stage_type,
                "stage_key": si.stage_key,
                "external_ref": si.external_ref,
                "recovery_hint": "call POST /stage_instances/:id/retry_stuck to reactivate",
            });

            // Try to route through the live RunTask (preserves in-memory consistency).
            let control_tx = {
                let runs = self.runs.lock().await;
                runs.get(&si.run_id).map(|h| h.control_tx.clone())
            };

            if let Some(tx) = control_tx {
                let (reply_tx, reply_rx) = oneshot::channel();
                if tx
                    .send(ControlMsg::ParkStuckStage {
                        stage_instance_id: si.id,
                        parked_meta_template: parked_meta_template.clone(),
                        reply_tx,
                    })
                    .await
                    .is_ok()
                {
                    // Wait briefly for acknowledgement; on timeout fall through to
                    // direct DB path.
                    if tokio::time::timeout(Duration::from_secs(3), reply_rx)
                        .await
                        .is_ok()
                    {
                        continue;
                    }
                }
            }

            // No live task (or timed out): park directly in DB. If a live
            // RunTask exists but fails to acknowledge before the timeout, this
            // fallback favors operator visibility but can leave that task's
            // in-memory index stale until recovery/restart; retry may reject
            // while the old task still believes the stage is Running.
            let mut parked_meta = parked_meta_template;
            if let Some(obj) = parked_meta.as_object_mut() {
                obj.insert(
                    "cancellation_delivered".into(),
                    serde_json::Value::Bool(false),
                );
            }
            let parked =
                queries::park_stage_instance_as_stuck(&self.db, &si.id, &parked_meta).await?;
            if parked {
                self.bus.publish(
                    si.run_id,
                    SubstrateEvent::StageStatusChanged {
                        stage_instance_id: si.id,
                        status: StageStatus::Parked,
                        parked_reason: Some("stuck_timeout".to_string()),
                        terminal_meta: None,
                    },
                );
            }
        }
        Ok(())
    }

    /// Transition a stuck-parked stage back to Running so its stage type can
    /// re-execute it. Returns Err(DecisionError::Conflict) when the stage is
    /// not currently parked as stuck_timeout or the run is terminal.
    async fn recover_run_task_for_retry(&self, run_id: WorkflowRunId) -> anyhow::Result<()> {
        {
            let runs = self.runs.lock().await;
            if runs.contains_key(&run_id) {
                return Ok(());
            }
        }

        let run = queries::get_workflow_run_by_id(&self.db, &run_id).await?;
        let def = queries::get_workflow_def_by_id(&self.db, &run.workflow_def_id).await?;
        let instances = queries::list_stage_instances_for_run(&self.db, &run_id).await?;
        let artifacts = queries::list_artifacts_for_run(&self.db, &run_id, None).await?;

        let mut resolved: HashMap<(StageKey, String), std::collections::BTreeMap<String, Artifact>> = HashMap::new();
        for artifact in &artifacts {
            let producer_key = instances
                .iter()
                .find(|si| si.id == artifact.stage_instance_id)
                .map(|si| si.stage_key.clone());
            let Some(producer_key) = producer_key else {
                continue;
            };
            let Some(producer_node) = def.graph.stages.get(&producer_key) else {
                continue;
            };
            let output_name = match &artifact.output_name {
                Some(name) => Some(name.clone()),
                None => producer_node
                    .outputs
                    .iter()
                    .find(|slot| slot.artifact_type == artifact.artifact_type)
                    .map(|slot| slot.name.clone()),
            };
            let Some(output_name) = output_name else {
                continue;
            };
            for edge in &def.graph.edges {
                if edge.from.stage == producer_key && edge.from.slot == output_name {
                    let key = (edge.to.stage.clone(), edge.to.slot.clone());
                    let inner = resolved.entry(key).or_default();
                    let unit_id = resolved_unit_id(&producer_key, artifact);
                    let should_use = inner
                        .get(&unit_id)
                        .map(|current| artifact.created_at > current.created_at)
                        .unwrap_or(true);
                    if should_use {
                        inner.insert(unit_id, artifact.clone());
                    }
                }
            }
        }

        let index = instances
            .iter()
            .map(|si| (si.stage_key.clone(), (si.id, si.status)))
            .collect();
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
            index,
            resolved,
            db: self.db.clone(),
            stage_types: self.stage_types.clone(),
            artifact_types: self.artifact_types.clone(),
            bus: self.bus.clone(),
            run_map: self.runs.clone(),
        };

        let mut runs = self.runs.lock().await;
        if runs.contains_key(&run_id) {
            return Ok(());
        }
        let join = tokio::spawn(async move { task.run().await });
        runs.insert(run_id, RunHandle { control_tx, join });
        Ok(())
    }

    pub async fn retry_stuck_stage(
        &self,
        stage_instance_id: StageInstanceId,
        unit_id: Option<String>,
    ) -> Result<(), DecisionError> {
        let si = queries::get_stage_instance_by_id(&self.db, &stage_instance_id)
            .await
            .map_err(|e| match e {
                crate::Error::NotFound { .. } => DecisionError::Conflict(format!(
                    "stage instance {} not found",
                    stage_instance_id.0
                )),
                other => DecisionError::Internal(anyhow::Error::new(other)),
            })?;

        let run = queries::get_workflow_run_by_id(&self.db, &si.run_id)
            .await
            .map_err(|e| DecisionError::Internal(anyhow::Error::new(e)))?;

        if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
            return Err(DecisionError::Conflict(format!(
                "run {} is terminal (status: {:?}); cannot retry stuck stage",
                si.run_id.0, run.status
            )));
        }

        if let Some(unit_id) = unit_id.as_deref() {
            if si.stage_type != "delegated_session" {
                return Err(DecisionError::Conflict(format!(
                    "stage instance {} is not a delegated_session stage",
                    stage_instance_id.0
                )));
            }
            let config: DelegatedSessionConfig = serde_json::from_value(si.config.clone())
                .map_err(|err| DecisionError::Internal(anyhow::Error::new(err)))?;
            if config.fan_out.is_none() {
                return Err(DecisionError::Conflict(format!(
                    "stage instance {} does not have configured fan_out",
                    stage_instance_id.0
                )));
            }
            let unit = queries::get_session_unit(&self.db, &stage_instance_id, unit_id)
                .await
                .map_err(|err| match err {
                    crate::Error::NotFound { .. } => DecisionError::Conflict(format!(
                        "unit '{}' does not exist for stage instance {}", unit_id, stage_instance_id.0
                    )),
                    other => DecisionError::Internal(anyhow::Error::new(other)),
                })?;
            let ended_without_emit = unit.terminal_meta.as_ref()
                .and_then(|meta| meta.get("kind"))
                .and_then(serde_json::Value::as_str)
                == Some("session_ended_without_emit");
            if !matches!(unit.status, crate::types::UnitStatus::Failed) && !ended_without_emit {
                return Err(DecisionError::Conflict(format!(
                    "unit '{}' is not retryable (status: {:?})", unit_id, unit.status
                )));
            }
        } else if si.stage_type == "delegated_session" {
            let config: Result<DelegatedSessionConfig, _> = serde_json::from_value(si.config.clone());
            if config.as_ref().ok().and_then(|config| config.fan_out.as_ref()).is_some()
                && queries::list_session_units_for_stage(&self.db, &stage_instance_id).await
                    .map_err(|err| DecisionError::Internal(anyhow::Error::new(err)))?.len() > 1
            {
                return Err(DecisionError::Conflict(format!(
                    "stage instance {} has multiple units; select a unit_id to retry",
                    stage_instance_id.0
                )));
            }
        }

        if unit_id.is_none() && (!matches!(si.status, StageStatus::Parked)
            || si.parked_reason.as_deref() != Some("stuck_timeout")
        ) {
            return Err(DecisionError::Conflict(format!(
                "stage instance {} is not parked as stuck_timeout (status: {:?}, parked_reason: {:?})",
                stage_instance_id.0, si.status, si.parked_reason
            )));
        }

        let mut tx = {
            let runs = self.runs.lock().await;
            runs.get(&si.run_id).map(|handle| handle.control_tx.clone())
        };
        if tx.is_none() {
            self.recover_run_task_for_retry(si.run_id)
                .await
                .map_err(DecisionError::Internal)?;
            tx = {
                let runs = self.runs.lock().await;
                runs.get(&si.run_id).map(|handle| handle.control_tx.clone())
            };
        }
        let tx = tx.ok_or_else(|| {
            DecisionError::Conflict(format!(
                "run {} is not active; cannot retry stuck stage",
                si.run_id.0
            ))
        })?;

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(ControlMsg::RetryStuckStage {
            stage_instance_id,
            unit_id,
            reply_tx,
        })
        .await
        .map_err(|_| {
            DecisionError::Conflict(format!("control channel closed for run {}", si.run_id.0))
        })?;

        match timeout(Duration::from_secs(5), reply_rx).await {
            Err(_) => Err(DecisionError::Internal(anyhow::anyhow!(
                "scheduler task did not acknowledge stuck retry for run {} in time",
                si.run_id.0
            ))),
            Ok(Err(_)) => Err(DecisionError::Conflict(format!(
                "scheduler task ended before acknowledging stuck retry for run {}",
                si.run_id.0
            ))),
            Ok(Ok(result)) => result,
        }
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
            self.bus.publish(
                run_id,
                SubstrateEvent::RunStatusChanged {
                    run_id,
                    status: RunStatus::Done,
                },
            );
            return Ok(());
        }

        // Transition run to Running before the scheduler begins executing stages.
        queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Running).await?;
        self.bus.publish(
            run_id,
            SubstrateEvent::RunStatusChanged {
                run_id,
                status: RunStatus::Running,
            },
        );

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
            runs.get(&run_id)
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
        .map_err(|_| {
            DecisionError::Conflict(format!("control channel closed for run {}", run_id.0))
        })?;

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

    /// Cancel a run. Bulk-transitions all non-terminal stage instances to Failed
    /// with `terminal_meta.kind = "cancelled"`, stops active external processes
    /// (via ControlMsg::Cancel), and returns the count of stages that were
    /// transitioned. Returns 0 if the run is already terminal.
    pub async fn cancel_run(&self, run_id: WorkflowRunId) -> anyhow::Result<u64> {
        let run = queries::get_workflow_run_by_id(&self.db, &run_id).await?;

        if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
            return Ok(0);
        }

        let cancellation_meta = serde_json::json!({
            "kind": "cancelled",
            "reason": "run cancelled by operator"
        });
        let cancellable_stages: Vec<_> = queries::list_stage_instances_for_run(&self.db, &run_id)
            .await?
            .into_iter()
            .filter(|stage| {
                matches!(
                    stage.status,
                    StageStatus::Pending | StageStatus::Running | StageStatus::Parked
                )
            })
            .collect();

        // Persist cancellation terminal state for all non-terminal stages first so
        // the HTTP response can include the count and recovery treats them as terminal.
        let stages_cancelled = queries::cancel_non_terminal_stage_instances_for_run(
            &self.db,
            &run_id,
            &cancellation_meta,
        )
        .await?;
        for stage in cancellable_stages {
            self.bus.publish(
                run_id,
                SubstrateEvent::StageStatusChanged {
                    stage_instance_id: stage.id,
                    status: StageStatus::Failed,
                    parked_reason: None,
                    terminal_meta: Some(cancellation_meta.clone()),
                },
            );
        }

        // Deliver Cancel to the live run task to stop external processes
        // (kbbl sessions, child process groups). If the channel is already
        // closed the run task is gone; fall through to the direct DB update.
        let sent = {
            let runs = self.runs.lock().await;
            runs.get(&run_id).map(|h| h.control_tx.clone())
        };
        let task_alive = match sent {
            Some(tx) => tx.send(ControlMsg::Cancel).await.is_ok(),
            None => false,
        };

        if !task_alive {
            // No live run task (or channel closed). The task may have self-reaped
            // after reaching Done between the initial read and this branch, so the
            // direct failure write must be conditional.
            if queries::update_workflow_run_status_if_non_terminal(
                &self.db,
                &run_id,
                RunStatus::Failed,
            )
            .await
            .unwrap_or(false)
            {
                self.bus.publish(
                    run_id,
                    SubstrateEvent::RunStatusChanged {
                        run_id,
                        status: RunStatus::Failed,
                    },
                );
            }
        }

        Ok(stages_cancelled)
    }

    pub async fn deliver_decision(
        &self,
        run_id: WorkflowRunId,
        stage_instance_id: StageInstanceId,
        payload: ResumePayload,
    ) -> Result<(), DecisionError> {
        self.resume_parked_stage_if_active(run_id, stage_instance_id, payload)
            .await
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
                self.bus.publish(
                    run_id,
                    SubstrateEvent::RunStatusChanged {
                        run_id,
                        status: RunStatus::Done,
                    },
                );
                self.bus.cleanup_run(run_id);
                continue;
            }

            if matches!(run.status, RunStatus::Pending) {
                queries::update_workflow_run_status(&self.db, &run_id, RunStatus::Running).await?;
                self.bus.publish(
                    run_id,
                    SubstrateEvent::RunStatusChanged {
                        run_id,
                        status: RunStatus::Running,
                    },
                );
            }

            let instances = queries::list_stage_instances_for_run(&self.db, &run_id).await?;
            let artifacts = queries::list_artifacts_for_run(&self.db, &run_id, None).await?;

            let mut resolved: HashMap<(StageKey, String), std::collections::BTreeMap<String, Artifact>> = HashMap::new();
            for artifact in &artifacts {
                let producer_key = instances
                    .iter()
                    .find(|si| si.id == artifact.stage_instance_id)
                    .map(|si| si.stage_key.clone());
                let producer_key = match producer_key {
                    Some(k) => k,
                    None => continue,
                };

                let producer_node = match def.graph.stages.get(&producer_key) {
                    Some(n) => n,
                    None => continue,
                };

                // Resolve the output slot name: use the persisted value when available
                // (set by the executor since migration 0002); fall back to type-matching
                // for pre-migration artifacts where output_name is NULL.
                let output_name: Option<String> = match &artifact.output_name {
                    Some(name) => Some(name.clone()),
                    None => producer_node
                        .outputs
                        .iter()
                        .find(|o| o.artifact_type == artifact.artifact_type)
                        .map(|o| o.name.clone()),
                };
                let output_name = match output_name {
                    Some(n) => n,
                    None => continue,
                };

                for edge in &def.graph.edges {
                    if edge.from.stage == producer_key && edge.from.slot == output_name {
                        let key = (edge.to.stage.clone(), edge.to.slot.clone());
                        let inner = resolved.entry(key).or_default();
                        let unit_id = resolved_unit_id(&producer_key, artifact);
                        let should_use = inner
                            .get(&unit_id)
                            .map(|e| artifact.created_at > e.created_at)
                            .unwrap_or(true);
                        if should_use {
                            inner.insert(unit_id, artifact.clone());
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
            let non_terminal: Vec<StageInstance> = instances
                .into_iter()
                .filter(|si| {
                    matches!(
                        si.status,
                        StageStatus::Pending | StageStatus::Running | StageStatus::Parked
                    )
                })
                .collect();

            for si in non_terminal {
                let node = match def.graph.stages.get(&si.stage_key) {
                    Some(n) => n.clone(),
                    None => {
                        tracing::error!(
                            stage_key = si.stage_key,
                            "recovery: stage_key not found in workflow graph — failing stage"
                        );
                        let terminal_meta = serde_json::json!({
                            "kind": "recovery_missing_stage_key",
                            "stage_key": si.stage_key,
                        });
                        if let Some((_, ref mut s)) = task.index.get_mut(&si.stage_key) {
                            *s = StageStatus::Failed;
                        }
                        match queries::update_stage_instance_status_with_terminal_meta(
                            &self.db,
                            &si.id,
                            StageStatus::Failed,
                            None,
                            Some(terminal_meta.clone()),
                            si.started_at,
                            Some(Utc::now()),
                        )
                        .await
                        {
                            Ok(_) => {
                                self.bus.publish(
                                    run_id,
                                    SubstrateEvent::StageStatusChanged {
                                        stage_instance_id: si.id,
                                        status: StageStatus::Failed,
                                        parked_reason: None,
                                        terminal_meta: Some(terminal_meta),
                                    },
                                );
                            }
                            Err(err) => {
                                tracing::error!(
                                    stage_instance_id = %si.id.0,
                                    stage_key = si.stage_key,
                                    "recovery: failed to persist missing_stage_key failure: {}",
                                    err
                                );
                            }
                        }
                        continue;
                    }
                };
                let st = match self.stage_types.get(&node.stage_type) {
                    Some(st) => st,
                    None => {
                        tracing::error!(
                            stage_key = si.stage_key,
                            stage_type = node.stage_type,
                            "recovery: stage_type not registered — failing stage"
                        );
                        let terminal_meta = serde_json::json!({
                            "kind": "recovery_unregistered_stage_type",
                            "stage_key": si.stage_key,
                            "stage_type": node.stage_type,
                        });
                        if let Some((_, ref mut s)) = task.index.get_mut(&si.stage_key) {
                            *s = StageStatus::Failed;
                        }
                        match queries::update_stage_instance_status_with_terminal_meta(
                            &self.db,
                            &si.id,
                            StageStatus::Failed,
                            None,
                            Some(terminal_meta.clone()),
                            si.started_at,
                            Some(Utc::now()),
                        )
                        .await
                        {
                            Ok(_) => {
                                self.bus.publish(
                                    run_id,
                                    SubstrateEvent::StageStatusChanged {
                                        stage_instance_id: si.id,
                                        status: StageStatus::Failed,
                                        parked_reason: None,
                                        terminal_meta: Some(terminal_meta),
                                    },
                                );
                            }
                            Err(err) => {
                                tracing::error!(
                                    stage_instance_id = %si.id.0,
                                    stage_key = si.stage_key,
                                    "recovery: failed to persist unregistered_stage_type failure: {}",
                                    err
                                );
                            }
                        }
                        continue;
                    }
                };
                let inputs = match task.resolved_inputs(&si.stage_key, &node) {
                    Ok(inputs) => inputs,
                    Err(error) => {
                        tracing::error!(stage_key = si.stage_key, "recovery input resolution failed: {}", error);
                        continue;
                    }
                };
                let ctx = StageContext::new(
                    StageInstanceSummary::from(&si),
                    si.config.clone(),
                    inputs,
                    events_tx.clone(),
                    self.db.clone(),
                    self.artifact_types.clone(),
                );
                match st.execute(ctx).await {
                    Ok(handle) => {
                        task.handles.insert(si.id, handle);
                    }
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
                            // Preserve the persisted start time: the UPDATE writes
                            // started_at unconditionally, so None would wipe it for
                            // recovered Parked/Running instances.
                            si.started_at,
                            Some(Utc::now()),
                        )
                        .await;
                        let _ = events_tx
                            .send(ExecutorEvent::StatusChanged {
                                instance_id: si.id,
                                status: StageStatus::Failed,
                                parked_reason: None,
                                terminal_meta: Some(serde_json::json!({"error": e.to_string()})),
                            })
                            .await;
                    }
                }
            }

            task.prime_source_stages().await;

            // Evaluate quiescence before entering the event loop.
            //
            // Case 1: all stages already terminal and no handles → no event will
            // ever arrive to drive the run to completion; settle immediately.
            //
            // Case 2: non-terminal stages exist but no handles were registered →
            // their execute() calls were skipped (unknown stage type, missing
            // graph node), leaving them in a state where no progress is possible.
            // Failing immediately surfaces a diagnosable terminal state instead of
            // an operator-invisible hang in Running.
            let active_count = task
                .index
                .values()
                .filter(|(_, s)| {
                    matches!(
                        *s,
                        StageStatus::Pending | StageStatus::Running | StageStatus::Parked
                    )
                })
                .count();

            if !task.index.is_empty() && task.handles.is_empty() {
                let final_status = if active_count > 0 {
                    // Non-terminal stages with no handles: fail so the run is
                    // diagnosable rather than hanging in Running indefinitely.
                    let now = Utc::now();
                    for (stage_key, (si_id, status)) in &task.index {
                        if matches!(
                            *status,
                            StageStatus::Pending | StageStatus::Running | StageStatus::Parked
                        ) {
                            let terminal_meta = serde_json::json!({"error": "recovery: no live handle for non-terminal stage"});
                            // Preserve existing started_at so recovery doesn't wipe timing data.
                            let existing_started_at =
                                queries::get_stage_instance_by_id(&self.db, si_id)
                                    .await
                                    .ok()
                                    .and_then(|si| si.started_at);
                            let _ = queries::update_stage_instance_status_with_terminal_meta(
                                &self.db,
                                si_id,
                                StageStatus::Failed,
                                None,
                                Some(terminal_meta.clone()),
                                existing_started_at,
                                Some(now),
                            )
                            .await;
                            self.bus.publish(
                                run_id,
                                SubstrateEvent::StageStatusChanged {
                                    stage_instance_id: *si_id,
                                    status: StageStatus::Failed,
                                    parked_reason: None,
                                    terminal_meta: Some(terminal_meta),
                                },
                            );
                            tracing::warn!(
                                run_id = %run_id.0,
                                stage_key = %stage_key,
                                "recovery quiescence: failing idle non-terminal stage with no handle"
                            );
                        }
                    }
                    RunStatus::Failed
                } else if task
                    .index
                    .values()
                    .any(|(_, s)| matches!(*s, StageStatus::Failed))
                {
                    RunStatus::Failed
                } else {
                    RunStatus::Done
                };

                let _ = queries::update_workflow_run_status(&self.db, &run_id, final_status).await;
                self.bus.publish(
                    run_id,
                    SubstrateEvent::RunStatusChanged {
                        run_id,
                        status: final_status,
                    },
                );
                self.bus.cleanup_run(run_id);
                continue;
            }

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
    use crate::events::{BackfillScope, EventBus, SeqEvent, SubstrateEvent};
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
        Arc::new(
            crate::db::init_pool(&format!("sqlite:{}", path))
                .await
                .unwrap(),
        )
    }

    fn make_artifact_registry() -> Arc<ArtifactTypeRegistry> {
        let mut reg = ArtifactTypeRegistry::new();
        reg.register(ArtifactTypeDef {
            id: "any".into(),
            validate: |_| Ok(()),
            component_id: "v".into(),
            capabilities: Default::default(),
            anchor_schema: None,
            review_items_extractor: None,
        });
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
        async fn cancel(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct ScriptedStageType {
        type_id: String,
        ctx_tx: mpsc::Sender<(StageContext, mpsc::Receiver<ResumePayload>)>,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for ScriptedStageType {
        fn id(&self) -> &str {
            &self.type_id
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _inputs: &HashMap<String, ResolvedInput>,
            _output_slots: &[crate::types::OutputSlot],
            _stage_instance_id: crate::types::StageInstanceId,
            _run_context: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            let (resume_tx, resume_rx) = mpsc::channel(8);
            let _ = self.ctx_tx.send((ctx, resume_rx)).await;
            Ok(Box::new(DummyHandle { resume_tx }))
        }
    }

    fn scripted(
        type_id: &str,
    ) -> (
        Arc<ScriptedStageType>,
        mpsc::Receiver<(StageContext, mpsc::Receiver<ResumePayload>)>,
    ) {
        let (tx, rx) = mpsc::channel(8);
        (
            Arc::new(ScriptedStageType {
                type_id: type_id.to_string(),
                ctx_tx: tx,
            }),
            rx,
        )
    }

    struct SlowExecuteStageType {
        type_id: String,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for SlowExecuteStageType {
        fn id(&self) -> &str {
            &self.type_id
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _inputs: &HashMap<String, ResolvedInput>,
            _output_slots: &[crate::types::OutputSlot],
            _stage_instance_id: crate::types::StageInstanceId,
            _run_context: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let (resume_tx, _resume_rx) = mpsc::channel(1);
            Ok(Box::new(DummyHandle { resume_tx }))
        }
    }

    struct FailingExecuteStageType {
        type_id: String,
    }

    #[async_trait]
    impl crate::registry::stage_type::StageType for FailingExecuteStageType {
        fn id(&self) -> &str {
            &self.type_id
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _inputs: &HashMap<String, ResolvedInput>,
            _output_slots: &[crate::types::OutputSlot],
            _stage_instance_id: crate::types::StageInstanceId,
            _run_context: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            Err(anyhow::anyhow!("retry execute failed"))
        }
    }

    fn timeout_dur() -> std::time::Duration {
        std::time::Duration::from_secs(5)
    }

    async fn wait_run_done(pool: &SqlitePool, run_id: WorkflowRunId) {
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let run = queries::get_workflow_run_by_id(pool, &run_id)
                .await
                .unwrap();
            if matches!(run.status, RunStatus::Done | RunStatus::Failed) {
                return;
            }
        }
        panic!("run did not reach terminal status");
    }

    async fn seed_stuck_retry_stage(
        pool: &SqlitePool,
        stage_type: &str,
    ) -> (WorkflowRun, StageInstance) {
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: stage_type.into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
                    m
                },
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
            stage_key: "A".into(),
            stage_type: stage_type.into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("stuck_timeout".into()),
            parked_meta: Some(json!({
                "kind": "stuck_timeout",
                "timed_out_at": "2026-01-02T00:00:00Z",
                "timeout_seconds": 3600,
                "cancellation_delivered": false,
            })),
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(pool, &si).await.unwrap();
        (run, si)
    }

    async fn wait_stage_status_event(
        rx: &mut tokio::sync::broadcast::Receiver<SeqEvent>,
        stage_instance_id: StageInstanceId,
        expected_status: StageStatus,
    ) {
        tokio::time::timeout(timeout_dur(), async {
            loop {
                let ev = rx.recv().await.unwrap();
                if let SubstrateEvent::StageStatusChanged {
                    stage_instance_id: observed_id,
                    status,
                    ..
                } = ev.event
                {
                    if observed_id == stage_instance_id && status == expected_status {
                        return;
                    }
                }
            }
        })
        .await
        .unwrap();
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({ "mode": "fresh" }),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![OutputSlot {
                                name: "out".into(),
                                artifact_type: "any".into(),
                            }],
                        },
                    );
                    m.insert(
                        "B".into(),
                        StageNodeDef {
                            stage_type: "st_b".into(),
                            config: json!({}),
                            inputs: vec![InputSlot {
                                name: "in".into(),
                                artifact_type: "any".into(),
                                optional: false,
                                collect: false,
                            }],
                            outputs: vec![],
                        },
                    );
                    m
                },
                edges: vec![Edge {
                    from: EdgeEndpoint {
                        stage: "A".into(),
                        slot: "out".into(),
                    },
                    to: EdgeEndpoint {
                        stage: "B".into(),
                        slot: "in".into(),
                    },
                }],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        let mut global_rx = bus.subscribe_global();

        coord.start_run(run_id).await.unwrap();

        let (ctx_a, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"v": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        let (ctx_b, _) = tokio::time::timeout(timeout_dur(), b_rx.recv())
            .await
            .unwrap()
            .unwrap();
        ctx_b.set_status(StageStatus::Running, None).await.unwrap();
        ctx_b.set_status(StageStatus::Done, None).await.unwrap();

        // Drain bus events, find RunStatusChanged Done
        let mut saw_run_done = false;
        for _ in 0..30 {
            match tokio::time::timeout(timeout_dur(), global_rx.recv()).await {
                Ok(Ok(ev)) => {
                    if matches!(
                        ev.event,
                        SubstrateEvent::RunStatusChanged {
                            status: RunStatus::Done,
                            ..
                        }
                    ) {
                        saw_run_done = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(saw_run_done, "run must publish RunStatusChanged Done");

        let run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
        assert_eq!(run.status, RunStatus::Done);

        // Global ring persists after run cleanup; verify events were published.
        let (events, _) = bus.backfill(BackfillScope::Global, 0);
        assert!(
            !events.is_empty(),
            "global backfill must contain events from the run"
        );
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![InputSlot {
                                name: "in_a".into(),
                                artifact_type: "any".into(),
                                optional: true,
                                collect: false,
                            }],
                            outputs: vec![OutputSlot {
                                name: "out_a".into(),
                                artifact_type: "any".into(),
                            }],
                        },
                    );
                    m.insert(
                        "B".into(),
                        StageNodeDef {
                            stage_type: "st_b".into(),
                            config: json!({}),
                            inputs: vec![InputSlot {
                                name: "in_b".into(),
                                artifact_type: "any".into(),
                                optional: false,
                                collect: false,
                            }],
                            outputs: vec![OutputSlot {
                                name: "out_b".into(),
                                artifact_type: "any".into(),
                            }],
                        },
                    );
                    m
                },
                edges: vec![
                    Edge {
                        from: EdgeEndpoint {
                            stage: "A".into(),
                            slot: "out_a".into(),
                        },
                        to: EdgeEndpoint {
                            stage: "B".into(),
                            slot: "in_b".into(),
                        },
                    },
                    Edge {
                        from: EdgeEndpoint {
                            stage: "B".into(),
                            slot: "out_b".into(),
                        },
                        to: EdgeEndpoint {
                            stage: "A".into(),
                            slot: "in_a".into(),
                        },
                    },
                ],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        // A is source (optional in_a satisfied trivially)
        let (ctx_a, mut resume_rx_a) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a
            .emit(EmitArgs {
                output_name: "out_a".into(),
                artifact_type: "any".into(),
                body: json!({"round": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();

        // B activates after receiving A's artifact
        let (ctx_b, _) = tokio::time::timeout(timeout_dur(), b_rx.recv())
            .await
            .unwrap()
            .unwrap();
        ctx_b.set_status(StageStatus::Running, None).await.unwrap();
        ctx_b
            .emit(EmitArgs {
                output_name: "out_b".into(),
                artifact_type: "any".into(),
                body: json!({"round": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();

        // B's emit triggers FeedbackArtifact to A (A is still Running)
        let fb = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(fb, ResumePayload::FeedbackArtifact { .. }),
            "expected FeedbackArtifact on A"
        );

        // stop condition: both mark Done
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();
        ctx_b.set_status(StageStatus::Done, None).await.unwrap();

        // B was not activated again (no second execute call)
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(b_rx.try_recv().is_err(), "B must not be spawned again");

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
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

        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(reg),
            artifact_reg.clone(),
            bus.clone(),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![OutputSlot {
                                name: "out".into(),
                                artifact_type: "any".into(),
                            }],
                        },
                    );
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };

        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        let (ctx_a, mut resume_rx_a) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();

        let mut run_rx = bus.subscribe_run(run_id);
        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        let artifact = ctx_a
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"content": "review"}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        ctx_a
            .set_status(StageStatus::Parked, Some("waiting_gate".into()))
            .await
            .unwrap();

        let si_id = ctx_a.stage_instance_id;
        wait_stage_status_event(&mut run_rx, si_id, StageStatus::Parked).await;

        // inject gate decision
        coord
            .deliver_decision(
                run_id,
                si_id,
                ResumePayload::GateDecision {
                    decision: GateDecision {
                        outcome: GateOutcome::Pass,
                        comment: None,
                        feedback: None,
                    },
                    against_artifact_id: artifact.id,
                },
            )
            .await
            .unwrap();

        let resume = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));

        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
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

        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(reg),
            artifact_reg.clone(),
            bus.clone(),
        );

        // Seed DB directly (simulating a crashed run)
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            ctx_a.stage_instance_id, si.id,
            "recovered stage must use existing instance id"
        );

        // inject decision
        coord
            .deliver_decision(
                run.id,
                si.id,
                ResumePayload::GateDecision {
                    decision: GateDecision {
                        outcome: GateOutcome::Pass,
                        comment: None,
                        feedback: None,
                    },
                    against_artifact_id: artifact.id,
                },
            )
            .await
            .unwrap();

        let resume = tokio::time::timeout(timeout_dur(), resume_rx_a.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(resume, ResumePayload::GateDecision { .. }));

        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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

        let run_after = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(
            run_after.status,
            RunStatus::Running,
            "recovered pending run must be promoted to Running"
        );

        let first_event = tokio::time::timeout(timeout_dur(), global_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            first_event.event,
            SubstrateEvent::RunStatusChanged {
                status: RunStatus::Running,
                ..
            }
        ));

        let stage_instances = queries::list_stage_instances_for_run(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(
            stage_instances.len(),
            1,
            "recover must prime the missing source stage once"
        );

        let (ctx_a, _) = tokio::time::timeout(timeout_dur(), a_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stage_instances[0].stage_key, "A");
        assert_eq!(ctx_a.stage_instance_id, stage_instances[0].id);

        ctx_a.set_status(StageStatus::Running, None).await.unwrap();
        ctx_a.set_status(StageStatus::Done, None).await.unwrap();

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
                    m.insert(
                        "B".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
        queries::insert_stage_instance(&pool, &persisted_a)
            .await
            .unwrap();

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
        assert!(
            ids.contains(&persisted_a.id),
            "recover must reuse the persisted stage instance"
        );
        assert_eq!(ids.len(), 2);
        assert_ne!(
            ids[0], ids[1],
            "recover must prime exactly one missing stage instance"
        );

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

        let stage_instances = queries::list_stage_instances_for_run(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(
            stage_instances.len(),
            2,
            "recover must not duplicate persisted stage instances"
        );

        for ctx in contexts {
            ctx.set_status(StageStatus::Running, None).await.unwrap();
            ctx.set_status(StageStatus::Done, None).await.unwrap();
        }

        wait_run_done(&pool, run.id).await;
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(run_final.status, RunStatus::Done);
    }

    // ── (g) empty graph short-circuits to Done ────────────────────────────────

    #[tokio::test]
    async fn empty_graph_run_short_circuits_to_done() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus,
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: HashMap::new(),
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        let run_id = insert_run_for_def(&pool, &def).await;

        // start_run handles an empty graph synchronously, so the run is terminal on return.
        coord.start_run(run_id).await.unwrap();

        let run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
        assert_eq!(
            run.status,
            RunStatus::Done,
            "empty-graph run must short-circuit to Done, not hang"
        );
    }

    // ── (h) unregistered stage type fails the run ─────────────────────────────

    #[tokio::test]
    async fn unregistered_stage_type_fails_run() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        // Register no stage types: the source stage's type is unresolved at activation.
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus,
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "missing_type".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        let run_id = insert_run_for_def(&pool, &def).await;
        coord.start_run(run_id).await.unwrap();

        wait_run_done(&pool, run_id).await;
        let run = queries::get_workflow_run_by_id(&pool, &run_id)
            .await
            .unwrap();
        assert_eq!(
            run.status,
            RunStatus::Failed,
            "unregistered stage type must fail the run, not hang in Running"
        );
    }

    // ── (i) recovery quiescence: all-terminal stages settle without entering the event loop

    #[tokio::test]
    async fn recovery_all_terminal_stages_settle_immediately() {
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
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "st_a".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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

        // Seed a Done stage_instance — simulates a run that completed but whose
        // RunStatus was never written (e.g. crashed just after the last stage
        // transitioned but before on_status_changed wrote RunStatus::Done).
        let si = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "A".into(),
            stage_type: "st_a".into(),
            status: StageStatus::Done,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: Some(fixed_dt()),
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        let mut global_rx = bus.subscribe_global();
        coord.recover().await.unwrap();

        // Stage type must NOT be re-executed (Done stages are terminal).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            a_rx.try_recv().is_err(),
            "Done stage must not be re-executed during recovery"
        );

        // Run must be settled to Done without requiring any external event.
        let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(
            run_final.status,
            RunStatus::Done,
            "all-terminal recovered run must settle to Done"
        );

        // Confirm RunStatusChanged Done was published.
        let mut saw_done = false;
        for _ in 0..20 {
            match tokio::time::timeout(timeout_dur(), global_rx.recv()).await {
                Ok(Ok(ev)) => {
                    if matches!(
                        ev.event,
                        SubstrateEvent::RunStatusChanged {
                            status: RunStatus::Done,
                            ..
                        }
                    ) {
                        saw_done = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(
            saw_done,
            "recovery must publish RunStatusChanged Done for all-terminal run"
        );
    }

    // ── (j) recovery quiescence: all-Failed stages settle as Failed ──────────

    #[tokio::test]
    async fn recovery_all_failed_stages_settle_as_failed() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        // Register no stage types so any re-activation also fails, but here the
        // stage is already Failed so it won't be re-activated.
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus.clone(),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "missing_type".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "missing_type".into(),
            status: StageStatus::Failed,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: Some(json!({"error": "stage type not registered"})),
            external_ref: None,
            started_at: None,
            ended_at: Some(fixed_dt()),
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        coord.recover().await.unwrap();

        let run_final = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(
            run_final.status,
            RunStatus::Failed,
            "all-Failed recovered run must settle to Failed"
        );
    }

    #[tokio::test]
    async fn recovery_idle_non_terminal_stage_publishes_failed_stage_event() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus.clone(),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "missing_type".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "missing_type".into(),
            status: StageStatus::Pending,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: None,
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        let mut global_rx = bus.subscribe_global();
        coord.recover().await.unwrap();

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(persisted.status, StageStatus::Failed);

        let mut saw_stage_failed = false;
        let mut saw_run_failed = false;
        for _ in 0..20 {
            match tokio::time::timeout(timeout_dur(), global_rx.recv()).await {
                Ok(Ok(ev)) => match ev.event {
                    SubstrateEvent::StageStatusChanged {
                        stage_instance_id,
                        status,
                        terminal_meta,
                        ..
                    } if stage_instance_id == si.id && status == StageStatus::Failed => {
                        let meta = terminal_meta.expect("terminal_meta must be set");
                        assert_eq!(
                            meta.get("kind").and_then(|v| v.as_str()),
                            Some("recovery_unregistered_stage_type"),
                            "terminal_meta.kind must be recovery_unregistered_stage_type"
                        );
                        saw_stage_failed = true;
                    }
                    SubstrateEvent::RunStatusChanged {
                        status: RunStatus::Failed,
                        ..
                    } => {
                        saw_run_failed = true;
                    }
                    _ => {}
                },
                _ => break,
            }
            if saw_stage_failed && saw_run_failed {
                break;
            }
        }
        assert!(
            saw_stage_failed,
            "recovery must publish StageStatusChanged Failed"
        );
        assert!(
            saw_run_failed,
            "recovery must publish RunStatusChanged Failed"
        );
    }

    // ── (k) sweeper: parks a running stage whose updated_at is stale ──────────

    #[tokio::test]
    async fn sweep_parks_stuck_running_stage() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        // 1-second timeout so fixed_dt() (2026-01-01) is well past the cutoff.
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus.clone(),
        )
        .with_liveness_config(
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(60),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "noop".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "noop".into(),
            status: StageStatus::Running,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(), // stale: 2026-01-01, well before cutoff
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        coord.sweep_stuck_stages().await.unwrap();

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(
            persisted.status,
            StageStatus::Parked,
            "sweep must park a stuck running stage"
        );
        assert_eq!(
            persisted.parked_reason.as_deref(),
            Some("stuck_timeout"),
            "parked_reason must be stuck_timeout"
        );
        assert!(
            persisted.parked_meta.is_some(),
            "parked_meta must be populated"
        );
        let meta = persisted.parked_meta.unwrap();
        assert_eq!(
            meta.get("kind").and_then(|v| v.as_str()),
            Some("stuck_timeout")
        );
    }

    // ── (l) sweeper: leaves a recently-updated running stage alone ────────────

    #[tokio::test]
    async fn sweep_skips_recent_running_stage() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let bus = EventBus::new();
        // 7200-second timeout; updated_at = now will not be past the cutoff.
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            bus.clone(),
        )
        .with_liveness_config(
            std::time::Duration::from_secs(7200),
            std::time::Duration::from_secs(60),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "noop".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "noop".into(),
            status: StageStatus::Running,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: Utc::now(), // just now — within the 2h timeout
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        coord.sweep_stuck_stages().await.unwrap();

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(
            persisted.status,
            StageStatus::Running,
            "sweep must leave a recently-updated stage as Running"
        );
        assert!(persisted.parked_reason.is_none());
    }

    // ── (m) retry_stuck_stage transitions Parked(stuck_timeout) → Running ─────

    #[tokio::test]
    async fn retry_stuck_stage_transitions_to_running() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let (stage, mut ctx_rx) = scripted("retry_stage");
        let mut stage_reg = StageTypeRegistry::new();
        stage_reg.register(stage);
        let bus = EventBus::new();
        let coord = Coordinator::new(pool.clone(), Arc::new(stage_reg), artifact_reg, bus.clone());

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "retry_stage".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "retry_stage".into(),
            status: StageStatus::Parked,
            config: json!({}),
            parked_reason: Some("stuck_timeout".into()),
            parked_meta: Some(json!({
                "kind": "stuck_timeout",
                "timed_out_at": "2026-01-02T00:00:00Z",
                "timeout_seconds": 3600,
                "cancellation_delivered": false,
            })),
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        coord.retry_stuck_stage(si.id, None).await.unwrap();
        let (retry_ctx, _resume_rx) = tokio::time::timeout(timeout_dur(), ctx_rx.recv())
            .await
            .unwrap()
            .expect("retry must re-execute the stage type");
        assert_eq!(retry_ctx.stage_instance_id, si.id);
        assert_eq!(
            retry_ctx.stage_instance_summary().status,
            StageStatus::Running
        );

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(
            persisted.status,
            StageStatus::Running,
            "retry must transition stuck-parked stage to Running"
        );
        assert!(
            persisted.parked_reason.is_none(),
            "parked_reason must be cleared after retry"
        );
        assert!(
            persisted.parked_meta.is_none(),
            "parked_meta must be cleared after retry"
        );
    }

    #[tokio::test]
    async fn retry_stuck_stage_acknowledges_before_slow_execute_finishes() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let mut stage_reg = StageTypeRegistry::new();
        stage_reg.register(Arc::new(SlowExecuteStageType {
            type_id: "slow_retry".into(),
        }));
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(stage_reg),
            artifact_reg,
            EventBus::new(),
        );
        let (run, si) = seed_stuck_retry_stage(&pool, "slow_retry").await;

        let accepted = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            coord.retry_stuck_stage(si.id, None),
        )
        .await
        .expect("retry should be acknowledged before slow execute completes");
        accepted.unwrap();

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(persisted.status, StageStatus::Running);
        let _ = coord.cancel_run(run.id).await;
    }

    #[tokio::test]
    async fn retry_stuck_stage_execute_failure_recomputes_run_status() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let mut stage_reg = StageTypeRegistry::new();
        stage_reg.register(Arc::new(FailingExecuteStageType {
            type_id: "failing_retry".into(),
        }));
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(stage_reg),
            artifact_reg,
            EventBus::new(),
        );
        let (run, si) = seed_stuck_retry_stage(&pool, "failing_retry").await;

        coord.retry_stuck_stage(si.id, None).await.unwrap();
        wait_run_done(&pool, run.id).await;

        let persisted = queries::get_stage_instance_by_id(&pool, &si.id)
            .await
            .unwrap();
        assert_eq!(persisted.status, StageStatus::Failed);
        assert_eq!(
            persisted
                .terminal_meta
                .as_ref()
                .and_then(|meta| meta.get("kind"))
                .and_then(|kind| kind.as_str()),
            Some("retry_stuck_execute_failed")
        );
        let run_after = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Failed);
    }

    // ── (n) retry_stuck_stage rejects non-stuck-parked stage ─────────────────

    #[tokio::test]
    async fn retry_stuck_stage_rejects_running_stage() {
        let pool = make_pool().await;
        let artifact_reg = make_artifact_registry();
        let coord = Coordinator::new(
            pool.clone(),
            Arc::new(StageTypeRegistry::new()),
            artifact_reg,
            EventBus::new(),
        );

        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "A".into(),
                        StageNodeDef {
                            stage_type: "noop".into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
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
            stage_type: "noop".into(),
            status: StageStatus::Running, // not stuck-parked
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(&pool, &si).await.unwrap();

        let err = coord.retry_stuck_stage(si.id, None).await.unwrap_err();
        assert!(
            matches!(err, DecisionError::Conflict(_)),
            "retry must reject a non-stuck-parked stage with Conflict"
        );
    }
}
