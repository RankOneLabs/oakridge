pub mod delegated_lbc_run;
pub mod delegated_session;
pub mod prompt_config;

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::db::queries;
use crate::registry::ArtifactTypeRegistry;
use crate::types::{
    Artifact, ArtifactId, ArtifactTypeId, GateDecision, StageInstanceId, StageInstanceSummary,
    StageStatus, WorkflowRunId,
};

// ── Event ─────────────────────────────────────────────────────────────────────

/// Event produced by the executor and consumed by the scheduler.
///
/// The scheduler receives these over the mpsc channel held inside `StageContext`.
/// `ExecutorEvent` lives here (not in the scheduler) because `StageContext` owns
/// the sender and must reference the type at construction time.
#[derive(Debug, Clone)]
pub enum ExecutorEvent {
    /// An artifact was emitted and persisted by a stage.
    ///
    /// `output_name` carries the producer's outbound slot so the scheduler can
    /// match edges keyed on `(stage_key, output_name)`.
    ArtifactEmitted {
        /// The persisted artifact.
        artifact: Artifact,
        /// The output slot name on the producing stage.
        output_name: String,
    },
    /// A stage instance transitioned to a new status.
    StatusChanged {
        /// The stage instance whose status changed.
        instance_id: StageInstanceId,
        /// The new status.
        status: StageStatus,
        /// Populated when `status` is `Parked`; describes why the stage is waiting.
        parked_reason: Option<String>,
        /// Structured metadata attached when the stage reaches a terminal status.
        terminal_meta: Option<Value>,
    },
}

// ── EmitArgs ─────────────────────────────────────────────────────────────────

/// Arguments for emitting an artifact from a stage.
#[derive(Debug, Clone)]
pub struct EmitArgs {
    /// The output slot name this artifact is produced on.
    pub output_name: String,
    /// The registered artifact type ID; must be present in the `ArtifactTypeRegistry`.
    pub artifact_type: ArtifactTypeId,
    /// The JSON body of the artifact. Validated against the type's `validate` function.
    pub body: Value,
    /// Optional human-readable label for this artifact.
    pub label: Option<String>,
    /// If this artifact revises a previous one, the ID of its parent.
    pub parent_artifact_id: Option<ArtifactId>,
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(dbe) if dbe.kind() == sqlx::error::ErrorKind::UniqueViolation)
}

const MAX_ARTIFACT_EMIT_RETRIES: usize = 8;

// ── StageContext ──────────────────────────────────────────────────────────────

/// Runtime context injected into a stage when it executes.
///
/// The public data fields let stage implementations read the resolved config and
/// inputs. The private substrate fields are the event channel, DB pool, registry,
/// and cached stage-instance summary; stages interact with them through the
/// context helpers instead of reaching around the scheduler.
#[derive(Clone)]
pub struct StageContext {
    /// Unique identifier for this stage instance.
    pub stage_instance_id: StageInstanceId,
    /// Identifier of the workflow run this stage belongs to.
    pub workflow_run_id: WorkflowRunId,
    /// Resolved config for this stage (output of `StageType::build_config`).
    pub config: Value,
    /// Resolved input artifacts, keyed by input slot name.
    pub inputs: HashMap<String, Artifact>,
    stage_instance: Arc<Mutex<StageInstanceSummary>>,
    events_tx: mpsc::Sender<ExecutorEvent>,
    db: Arc<SqlitePool>,
    registry: Arc<ArtifactTypeRegistry>,
}

impl StageContext {
    fn stage_instance_summary_mut(&self) -> std::sync::MutexGuard<'_, StageInstanceSummary> {
        match self.stage_instance.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Construct a `StageContext`. Called by the scheduler when launching a stage.
    pub fn new(
        stage_instance: StageInstanceSummary,
        config: Value,
        inputs: HashMap<String, Artifact>,
        events_tx: mpsc::Sender<ExecutorEvent>,
        db: Arc<SqlitePool>,
        registry: Arc<ArtifactTypeRegistry>,
    ) -> Self {
        let stage_instance_id = stage_instance.stage_instance_id;
        let workflow_run_id = stage_instance.workflow_run_id;
        Self {
            stage_instance_id,
            workflow_run_id,
            config,
            inputs,
            stage_instance: Arc::new(Mutex::new(stage_instance)),
            events_tx,
            db,
            registry,
        }
    }

    /// Return the cached stage-instance summary visible to the executor.
    ///
    /// This snapshot is updated by `StageContext` helpers. Scheduler-owned writes
    /// can make it temporarily stale relative to the persisted row.
    pub fn stage_instance_summary(&self) -> StageInstanceSummary {
        self.stage_instance_summary_mut().clone()
    }

    /// Read the stage status directly from the database.
    ///
    /// Unlike `stage_instance_summary`, this always reflects the persisted value and
    /// is not subject to scheduler-owned writes that have not yet propagated to the
    /// in-memory cache.
    pub async fn persisted_status(&self) -> anyhow::Result<StageStatus> {
        let si = queries::get_stage_instance_by_id(&self.db, &self.stage_instance_id).await?;
        Ok(si.status)
    }

    /// Emit an artifact.
    ///
    /// Validates the body against the artifact type's schema, persists the artifact
    /// via the db layer, and notifies the scheduler. The event is sent *after* the
    /// persist so the scheduler never receives a reference to an artifact it cannot
    /// read back.
    ///
    /// # Errors
    ///
    /// Returns `Err` if:
    /// - `args.artifact_type` is not registered (`RegistryMiss`)
    /// - `args.body` fails the type's `validate` function (`Validation`)
    /// - The database insert fails
    /// - The scheduler channel is closed
    pub async fn emit(&self, args: EmitArgs) -> anyhow::Result<Artifact> {
        let type_def = self.registry.get(&args.artifact_type).ok_or_else(|| {
            crate::Error::RegistryMiss(format!(
                "artifact type '{}' not registered",
                args.artifact_type
            ))
        })?;

        (type_def.validate)(&args.body)?;

        let EmitArgs {
            output_name,
            artifact_type,
            body,
            label,
            parent_artifact_id,
        } = args;

        enum EmitAttempt {
            Inserted(Artifact),
            Retry,
        }

        let mut attempts = 0usize;
        let artifact = loop {
            // Use a sqlx-managed transaction: rolls back automatically on drop,
            // making this loop safe to cancel between begin and commit.
            let mut txn = self.db.begin().await?;

            let attempt: anyhow::Result<EmitAttempt> = async {
                let version = if let Some(parent_id) = parent_artifact_id {
                    let parent_id_str = parent_id.0.to_string();
                    let parent = sqlx::query("SELECT run_id, version FROM artifact WHERE id = ?")
                        .bind(parent_id_str.clone())
                        .fetch_optional(&mut *txn)
                        .await?
                        .ok_or_else(|| crate::Error::NotFound {
                            entity: "artifact".into(),
                            id: parent_id.0.to_string(),
                        })?;
                    let parent_run_id: String = parent.get("run_id");
                    let parent_version: i64 = parent.get("version");
                    if parent_run_id != self.workflow_run_id.0.to_string() {
                        return Err(anyhow::anyhow!(
                            "parent artifact {} belongs to a different workflow run",
                            parent_id.0
                        ));
                    }
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COALESCE(MAX(version), ?) + 1 FROM artifact WHERE parent_artifact_id = ?",
                    )
                    .bind(parent_version)
                    .bind(parent_id_str)
                    .fetch_one(&mut *txn)
                    .await?
                } else {
                    1
                };

                let artifact = Artifact {
                    id: ArtifactId(Uuid::new_v4()),
                    run_id: self.workflow_run_id,
                    stage_instance_id: self.stage_instance_id,
                    artifact_type: artifact_type.clone(),
                    output_name: Some(output_name.clone()),
                    label: label.clone(),
                    body: body.clone(),
                    version: version as i32,
                    parent_artifact_id,
                    created_at: Utc::now(),
                };

                let insert_result = sqlx::query(
                    "INSERT INTO artifact \
                     (id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, parent_artifact_id, created_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(artifact.id.0.to_string())
                .bind(artifact.run_id.0.to_string())
                .bind(artifact.stage_instance_id.0.to_string())
                .bind(artifact.artifact_type.clone())
                .bind(artifact.output_name.clone())
                .bind(artifact.label.clone())
                .bind(serde_json::to_string(&artifact.body)?)
                .bind(artifact.version as i64)
                .bind(artifact.parent_artifact_id.map(|parent| parent.0.to_string()))
                .bind(artifact.created_at.to_rfc3339())
                .execute(&mut *txn)
                .await;

                match insert_result {
                    Ok(_) => Ok(EmitAttempt::Inserted(artifact)),
                    Err(err) if is_unique_violation(&err) => Ok(EmitAttempt::Retry),
                    Err(err) => Err(err.into()),
                }
            }
            .await;

            match attempt {
                Ok(EmitAttempt::Inserted(artifact)) => {
                    txn.commit().await?;
                    break artifact;
                }
                Ok(EmitAttempt::Retry) => {
                    // Drop txn: sqlx Transaction rolls back on drop.
                    drop(txn);
                    if attempts >= MAX_ARTIFACT_EMIT_RETRIES {
                        return Err(anyhow::anyhow!(
                            "artifact emit exceeded {} retries on unique conflict",
                            MAX_ARTIFACT_EMIT_RETRIES
                        ));
                    }
                    attempts += 1;
                    continue;
                }
                Err(err) => {
                    // Drop txn: sqlx Transaction rolls back on drop.
                    drop(txn);
                    return Err(err);
                }
            }
        };

        self.events_tx
            .send(ExecutorEvent::ArtifactEmitted {
                artifact: artifact.clone(),
                output_name,
            })
            .await
            .map_err(|_| anyhow::anyhow!("executor event channel closed"))?;

        // Bump updated_at to signal liveness after a successful emit.
        // Best-effort: the artifact is already committed and the event sent.
        let _ = queries::touch_stage_instance(&self.db, &self.stage_instance_id).await;

        Ok(artifact)
    }

    /// Bump this stage instance's `updated_at` without changing its status.
    ///
    /// Call periodically from long-running executors that are making progress
    /// but not emitting artifacts or changing status. Signals liveness to the
    /// stuck-stage sweeper and prevents the stage from being parked as timed-out.
    pub async fn heartbeat(&self) -> anyhow::Result<()> {
        queries::touch_stage_instance(&self.db, &self.stage_instance_id).await?;
        Ok(())
    }

    /// Transition this stage instance to a new status.
    ///
    /// Persists the transition (setting `started_at` when transitioning into `Running`
    /// if not already set, and `ended_at` when transitioning into a terminal status)
    /// then notifies the scheduler.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the database update fails or the scheduler channel is closed.
    pub async fn set_status(
        &self,
        status: StageStatus,
        parked_reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.set_status_with_terminal_meta(status, parked_reason, None)
            .await
    }

    /// Transition this stage instance to a new status with structured terminal metadata.
    pub async fn set_status_with_terminal_meta(
        &self,
        status: StageStatus,
        parked_reason: Option<String>,
        terminal_meta: Option<Value>,
    ) -> anyhow::Result<()> {
        let now = Utc::now();
        let is_terminal = matches!(status, StageStatus::Done | StageStatus::Failed);

        let current = queries::get_stage_instance_by_id(&self.db, &self.stage_instance_id).await?;
        if is_cancelled_terminal(&current) {
            return Ok(());
        }

        let started_at = if matches!(status, StageStatus::Running) && current.started_at.is_none() {
            Some(now)
        } else {
            current.started_at
        };

        // Preserve the original completion time: a repeat terminal transition must
        // not clobber the ended_at recorded by the first one.
        let ended_at = if is_terminal {
            current.ended_at.or(Some(now))
        } else {
            current.ended_at
        };

        // parked_reason is only meaningful for the Parked status; drop it for any
        // other transition so a stray reason can't pollute the row or the event.
        let parked_reason = if matches!(status, StageStatus::Parked) {
            parked_reason
        } else {
            None
        };
        let terminal_meta = if is_terminal {
            current.terminal_meta.clone().or(terminal_meta)
        } else {
            None
        };

        queries::update_stage_instance_status_with_terminal_meta(
            &self.db,
            &self.stage_instance_id,
            status,
            parked_reason.clone(),
            terminal_meta.clone(),
            started_at,
            ended_at,
        )
        .await?;

        {
            let mut summary = self.stage_instance_summary_mut();
            summary.status = status;
            summary.parked_reason = parked_reason.clone();
            summary.terminal_meta = terminal_meta.clone();
        }

        self.events_tx
            .send(ExecutorEvent::StatusChanged {
                instance_id: self.stage_instance_id,
                status,
                parked_reason,
                terminal_meta,
            })
            .await
            .map_err(|_| anyhow::anyhow!("executor event channel closed"))?;

        Ok(())
    }

    /// Attach (or clear, with `None`) structured park metadata on this stage
    /// instance. Persisted to `stage_instance.parked_meta` and surfaced on
    /// `GET /stage_instances/:id`, letting a client read executor-specific park
    /// context (e.g. an approval `request_id`). Independent of `set_status` so it
    /// does not touch the status/event path.
    pub async fn set_parked_meta(&self, meta: Option<Value>) -> anyhow::Result<()> {
        queries::set_stage_instance_parked_meta(&self.db, &self.stage_instance_id, meta.clone())
            .await?;
        self.stage_instance_summary_mut().parked_meta = meta;
        Ok(())
    }

    /// Persist the external substrate reference for this stage instance and update
    /// the in-memory summary so subsequent reads observe the new handle.
    pub async fn set_external_ref(&self, external_ref: Option<String>) -> anyhow::Result<()> {
        queries::set_stage_instance_external_ref(
            &self.db,
            &self.stage_instance_id,
            external_ref.clone(),
        )
        .await?;
        self.stage_instance_summary_mut().external_ref = external_ref;
        Ok(())
    }
}

fn is_cancelled_terminal(stage: &crate::types::StageInstance) -> bool {
    matches!(stage.status, StageStatus::Done | StageStatus::Failed)
        && stage
            .terminal_meta
            .as_ref()
            .and_then(|meta| meta.get("kind"))
            .and_then(Value::as_str)
            == Some("cancelled")
}

// ── StageHandle ───────────────────────────────────────────────────────────────

/// A handle to a running stage held by the scheduler.
///
/// The scheduler uses this to resume a parked stage (gate decision or feedback)
/// or to cancel it.
#[async_trait]
pub trait StageHandle: Send + Sync {
    /// Resume a parked stage with the given payload.
    async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()>;

    /// Cancel the stage, releasing any external resources it holds.
    async fn cancel(&self) -> anyhow::Result<()>;
}

// ── ResumePayload ─────────────────────────────────────────────────────────────

/// Payload the scheduler delivers when resuming a parked stage.
///
/// Serializes as `{"kind":"gate_decision",...}`, `{"kind":"feedback_artifact",...}`,
/// or `{"kind":"executor","payload":...}` for scheduler dispatch over HTTP.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResumePayload {
    /// A human gate decision, referencing the artifact that was reviewed.
    GateDecision {
        /// The gate decision (pass / fail / rerun).
        decision: GateDecision,
        /// The artifact the gate was applied against.
        against_artifact_id: ArtifactId,
    },
    /// A feedback artifact injected back into the stage for re-execution.
    FeedbackArtifact {
        /// The feedback artifact.
        artifact: Artifact,
    },
    /// An opaque executor-specific payload routed to the parked stage's handle without
    /// interpretation by the substrate.
    Executor {
        /// Executor-defined payload; the handle decodes its own shape.
        payload: serde_json::Value,
    },
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Barrier};
    use uuid::Uuid;

    use crate::db::queries;
    use crate::registry::{ArtifactTypeDef, ArtifactTypeRegistry, StageTypeRegistry};
    use crate::types::{
        RunStatus, StageInstance, StageKey, StageStatus, WorkflowDef, WorkflowDefId, WorkflowGraph,
        WorkflowRun, WorkflowRunId,
    };

    // ── DB helpers ────────────────────────────────────────────────────────────

    async fn make_pool() -> Arc<SqlitePool> {
        let path = format!("/tmp/oakridge_exec_test_{}.db", Uuid::new_v4());
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

    async fn setup_run(pool: &SqlitePool) -> (WorkflowRunId, StageInstanceId) {
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
            stage_key: StageKey::from("s1"),
            stage_type: "dummy".into(),
            status: StageStatus::Running,
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
        queries::insert_stage_instance(pool, &si).await.unwrap();

        (run.id, si.id)
    }

    // ── Dummy artifact types ──────────────────────────────────────────────────

    fn validate_always_ok(_v: &Value) -> crate::Result<()> {
        Ok(())
    }

    #[derive(serde::Deserialize)]
    struct RequiresField {
        #[allow(dead_code)]
        required_field: String,
    }

    fn validate_requires_field(v: &Value) -> crate::Result<()> {
        serde_json::from_value::<RequiresField>(v.clone())
            .map(|_| ())
            .map_err(Into::into)
    }

    fn make_artifact_registry() -> Arc<ArtifactTypeRegistry> {
        let mut reg = ArtifactTypeRegistry::new();
        reg.register(ArtifactTypeDef {
            id: "any".into(),
            validate: validate_always_ok,
            component_id: "any-viewer".into(),
        });
        reg.register(ArtifactTypeDef {
            id: "strict".into(),
            validate: validate_requires_field,
            component_id: "strict-viewer".into(),
        });
        Arc::new(reg)
    }

    // ── Dummy StageType ───────────────────────────────────────────────────────

    struct DummyHandle;

    #[async_trait]
    impl StageHandle for DummyHandle {
        async fn resume(&self, _payload: ResumePayload) -> anyhow::Result<()> {
            Ok(())
        }
        async fn cancel(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct DummyStageType;

    #[async_trait]
    impl crate::registry::stage_type::StageType for DummyStageType {
        fn id(&self) -> &str {
            "dummy"
        }

        async fn build_config(
            &self,
            def_config: &Value,
            _inputs: &HashMap<String, Artifact>,
            _output_slots: &[crate::types::OutputSlot],
            _stage_instance_id: crate::types::StageInstanceId,
            _run_context: &Value,
        ) -> anyhow::Result<Value> {
            Ok(def_config.clone())
        }

        async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
            Ok(Box::new(DummyHandle))
        }
    }

    // ── Registry dispatch tests ───────────────────────────────────────────────

    #[test]
    fn stage_type_registry_register_and_get() {
        let mut reg = StageTypeRegistry::new();
        let st = Arc::new(DummyStageType);
        reg.register(st.clone());

        let got = reg.get("dummy");
        assert!(got.is_some());
        assert_eq!(got.unwrap().id(), "dummy");
        assert!(reg.get("missing").is_none());
    }

    #[test]
    fn artifact_type_registry_register_and_get() {
        let reg = make_artifact_registry();
        assert!(reg.get("any").is_some());
        assert!(reg.get("strict").is_some());
        assert!(reg.get("unknown").is_none());
    }

    // ── emit tests ────────────────────────────────────────────────────────────

    fn make_ctx(
        pool: Arc<SqlitePool>,
        run_id: WorkflowRunId,
        si_id: StageInstanceId,
        registry: Arc<ArtifactTypeRegistry>,
        tx: mpsc::Sender<ExecutorEvent>,
    ) -> StageContext {
        let summary = StageInstanceSummary {
            stage_instance_id: si_id,
            workflow_run_id: run_id,
            stage_key: "s1".into(),
            status: StageStatus::Running,
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
        };
        StageContext::new(summary, json!({}), HashMap::new(), tx, pool, registry)
    }

    #[tokio::test]
    async fn emit_valid_body_succeeds_and_notifies() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);

        let artifact = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"x": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();

        // Exactly one event sent.
        let event = rx.try_recv().expect("expected one event");
        assert!(rx.try_recv().is_err(), "expected exactly one event");

        match event {
            ExecutorEvent::ArtifactEmitted {
                artifact: ev_artifact,
                output_name,
            } => {
                assert_eq!(output_name, "out");
                assert_eq!(ev_artifact.id, artifact.id);
            }
            other => panic!("unexpected event: {:?}", other),
        }

        // Artifact is readable back via cohort 3's query.
        let fetched = queries::get_artifact_by_id(&pool, &artifact.id)
            .await
            .unwrap();
        assert_eq!(fetched.id, artifact.id);
        assert_eq!(fetched.artifact_type, "any");
        assert_eq!(fetched.body, json!({"x": 1}));
    }

    #[tokio::test]
    async fn emit_missing_type_returns_err() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let ctx = make_ctx(pool, run_id, si_id, registry, tx);
        let result = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "not-registered".into(),
                body: json!({}),
                label: None,
                parent_artifact_id: None,
            })
            .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("registry miss") || msg.contains("not registered"),
            "{}",
            msg
        );
    }

    #[tokio::test]
    async fn emit_invalid_body_returns_err() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool, run_id, si_id, registry, tx);

        // "strict" type requires a `required_field` key.
        let result = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "strict".into(),
                body: json!({"wrong_key": 42}),
                label: None,
                parent_artifact_id: None,
            })
            .await;
        assert!(result.is_err());

        // No event must have been sent on validation failure.
        assert!(
            rx.try_recv().is_err(),
            "no event expected on validation failure"
        );
    }

    // ── emit cancellation safety test ─────────────────────────────────────────

    #[tokio::test]
    async fn dropped_emit_transaction_does_not_poison_pool() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        // Open a transaction that mirrors what emit does internally, do work inside
        // it, then drop it without committing. This simulates StageContext::emit
        // being dropped mid-transaction (e.g. by tokio::spawn + abort).
        {
            let mut txn = pool.begin().await.unwrap();
            let id = Uuid::new_v4().to_string();
            let run_id_str = run_id.0.to_string();
            let si_id_str = si_id.0.to_string();
            let now = Utc::now().to_rfc3339();
            sqlx::query(
                "INSERT INTO artifact (id, run_id, stage_instance_id, artifact_type, \
                 output_name, label, body, version, parent_artifact_id, created_at) \
                 VALUES (?, ?, ?, 'any', 'out', NULL, '{}', 1, NULL, ?)",
            )
            .bind(&id)
            .bind(&run_id_str)
            .bind(&si_id_str)
            .bind(&now)
            .execute(&mut *txn)
            .await
            .unwrap();
            // Drop txn without commit: sqlx Transaction rolls back on drop,
            // returning the connection to the pool in a clean state.
        }

        // The pool must be fully usable: the rolled-back insert is gone and
        // a new emit on the same pool must succeed without a nested-transaction error.
        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        let result = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"after_drop": true}),
                label: None,
                parent_artifact_id: None,
            })
            .await;

        assert!(
            result.is_ok(),
            "emit after dropped transaction must succeed without nested-transaction error: {:?}",
            result.err()
        );

        // The rolled-back insert must not be visible; only the successful emit.
        let artifacts = queries::list_artifacts_for_run(&pool, &run_id, None)
            .await
            .unwrap();
        assert_eq!(
            artifacts.len(),
            1,
            "only the post-drop emit should be persisted"
        );
        assert_eq!(artifacts[0].body, json!({"after_drop": true}));
    }

    // ── set_status tests ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn set_status_running_sets_started_at_and_sends_event() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.set_status(StageStatus::Running, None).await.unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Running);
        assert!(
            si.started_at.is_some(),
            "started_at must be set on Running transition"
        );
        assert!(si.ended_at.is_none());

        let event = rx.try_recv().expect("expected a StatusChanged event");
        match event {
            ExecutorEvent::StatusChanged {
                instance_id,
                status,
                parked_reason,
                terminal_meta,
            } => {
                assert_eq!(instance_id, si_id);
                assert_eq!(status, StageStatus::Running);
                assert!(parked_reason.is_none());
                assert!(terminal_meta.is_none());
            }
            other => panic!("unexpected event: {:?}", other),
        }
        assert!(rx.try_recv().is_err(), "expected exactly one event");
    }

    #[tokio::test]
    async fn set_status_done_sets_ended_at_and_sends_event() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.set_status(StageStatus::Done, None).await.unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Done);
        assert!(
            si.ended_at.is_some(),
            "ended_at must be set on Done transition"
        );

        let event = rx.try_recv().expect("expected a StatusChanged event");
        assert!(matches!(
            event,
            ExecutorEvent::StatusChanged {
                status: StageStatus::Done,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn set_status_done_with_terminal_meta_persists_meta_and_updates_summary() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        let terminal_meta = json!({"result": "complete"});
        ctx.set_status_with_terminal_meta(StageStatus::Done, None, Some(terminal_meta.clone()))
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Done);
        assert_eq!(si.terminal_meta, Some(terminal_meta.clone()));

        let summary = ctx.stage_instance_summary();
        assert_eq!(summary.terminal_meta, Some(terminal_meta.clone()));

        let event = rx.try_recv().expect("expected a StatusChanged event");
        match event {
            ExecutorEvent::StatusChanged {
                status: StageStatus::Done,
                terminal_meta: event_meta,
                ..
            } => {
                assert_eq!(event_meta, Some(terminal_meta));
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }

    #[tokio::test]
    async fn set_status_failed_with_terminal_meta_persists_meta_and_updates_summary() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        let terminal_meta = json!({"reason": "boom"});
        ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta.clone()))
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Failed);
        assert_eq!(si.terminal_meta, Some(terminal_meta.clone()));

        let summary = ctx.stage_instance_summary();
        assert_eq!(summary.terminal_meta, Some(terminal_meta.clone()));

        let event = rx.try_recv().expect("expected a StatusChanged event");
        match event {
            ExecutorEvent::StatusChanged {
                status: StageStatus::Failed,
                terminal_meta: event_meta,
                ..
            } => {
                assert_eq!(event_meta, Some(terminal_meta));
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }

    #[tokio::test]
    async fn cancelled_terminal_stage_ignores_late_executor_status_write() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);
        let cancelled_meta = json!({"kind": "cancelled"});

        queries::update_stage_instance_status_with_terminal_meta(
            &pool,
            &si_id,
            StageStatus::Failed,
            None,
            Some(cancelled_meta.clone()),
            None,
            Some(Utc::now()),
        )
        .await
        .unwrap();

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.set_status(StageStatus::Running, None).await.unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Failed);
        assert_eq!(si.terminal_meta, Some(cancelled_meta));
        assert!(
            rx.try_recv().is_err(),
            "late write must not emit a status event"
        );
    }

    #[tokio::test]
    async fn set_status_parked_persists_reason_and_sends_event() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.set_status(StageStatus::Parked, Some("waiting for gate".into()))
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.status, StageStatus::Parked);
        assert_eq!(si.parked_reason.as_deref(), Some("waiting for gate"));
        assert!(si.ended_at.is_none());

        let event = rx.try_recv().expect("expected a StatusChanged event");
        match event {
            ExecutorEvent::StatusChanged {
                status,
                parked_reason,
                terminal_meta,
                ..
            } => {
                assert_eq!(status, StageStatus::Parked);
                assert_eq!(parked_reason.as_deref(), Some("waiting for gate"));
                assert!(terminal_meta.is_none());
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }

    #[tokio::test]
    async fn set_external_ref_persists_and_updates_summary() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        assert!(ctx.stage_instance_summary().external_ref.is_none());

        ctx.set_external_ref(Some("ext-456".into())).await.unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert_eq!(si.external_ref.as_deref(), Some("ext-456"));
        assert_eq!(
            ctx.stage_instance_summary().external_ref.as_deref(),
            Some("ext-456")
        );
    }

    #[tokio::test]
    async fn emit_versions_root_at_1_and_revision_increments() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);

        let root = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"v": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();
        assert_eq!(root.version, 1, "root artifact must be version 1");

        let rev = ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"v": 2}),
                label: None,
                parent_artifact_id: Some(root.id),
            })
            .await
            .unwrap();
        assert_eq!(rev.version, 2, "revision must be parent.version + 1");

        // Persisted, not just in-memory.
        let fetched = queries::get_artifact_by_id(&pool, &rev.id).await.unwrap();
        assert_eq!(fetched.version, 2);
    }

    #[tokio::test]
    async fn emit_concurrent_sibling_revisions_get_distinct_versions() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let root_ctx = make_ctx(pool.clone(), run_id, si_id, registry.clone(), tx.clone());
        let root = root_ctx
            .emit(EmitArgs {
                output_name: "out".into(),
                artifact_type: "any".into(),
                body: json!({"v": 1}),
                label: None,
                parent_artifact_id: None,
            })
            .await
            .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let left_ctx = make_ctx(pool.clone(), run_id, si_id, registry.clone(), tx.clone());
        let right_ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);

        let left = {
            let barrier = barrier.clone();
            async move {
                barrier.wait().await;
                left_ctx
                    .emit(EmitArgs {
                        output_name: "out".into(),
                        artifact_type: "any".into(),
                        body: json!({"v": 2}),
                        label: Some("left".into()),
                        parent_artifact_id: Some(root.id),
                    })
                    .await
                    .unwrap()
            }
        };
        let right = {
            let barrier = barrier.clone();
            async move {
                barrier.wait().await;
                right_ctx
                    .emit(EmitArgs {
                        output_name: "out".into(),
                        artifact_type: "any".into(),
                        body: json!({"v": 3}),
                        label: Some("right".into()),
                        parent_artifact_id: Some(root.id),
                    })
                    .await
                    .unwrap()
            }
        };

        let (left, right) = tokio::join!(left, right);
        let mut versions = [left.version, right.version];
        versions.sort_unstable();
        assert_eq!(versions, [2, 3]);
        assert_eq!(left.parent_artifact_id, Some(root.id));
        assert_eq!(right.parent_artifact_id, Some(root.id));

        let artifacts = queries::list_artifacts_for_run(&pool, &run_id, None)
            .await
            .unwrap();
        assert_eq!(artifacts.len(), 3);
    }

    #[tokio::test]
    async fn set_status_repeat_terminal_preserves_first_ended_at() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);

        ctx.set_status(StageStatus::Done, None).await.unwrap();
        let first = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .ended_at;
        assert!(first.is_some());

        ctx.set_status(StageStatus::Done, None).await.unwrap();
        let second = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .ended_at;
        assert_eq!(first, second, "repeat terminal must not clobber ended_at");
    }

    #[tokio::test]
    async fn set_status_non_parked_drops_parked_reason() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, mut rx) = mpsc::channel(8);

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);

        // A stray reason on a Done transition must be dropped, not persisted/broadcast.
        ctx.set_status(StageStatus::Done, Some("stray".into()))
            .await
            .unwrap();

        let si = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap();
        assert!(
            si.parked_reason.is_none(),
            "parked_reason must be None for non-Parked status"
        );

        let event = rx.try_recv().expect("expected a StatusChanged event");
        match event {
            ExecutorEvent::StatusChanged {
                parked_reason,
                terminal_meta,
                ..
            } => {
                assert!(
                    parked_reason.is_none(),
                    "event parked_reason must be None for non-Parked status"
                );
                assert!(
                    terminal_meta.is_none(),
                    "event terminal_meta must be None for non-terminal status"
                );
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }

    // ── heartbeat tests ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn heartbeat_bumps_updated_at() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let before = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .updated_at;

        // Ensure at least 1 ms passes so the new timestamp is strictly later.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.heartbeat().await.unwrap();

        let after = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .updated_at;

        assert!(
            after > before,
            "heartbeat must advance updated_at (before={before:?}, after={after:?})"
        );
    }

    #[tokio::test]
    async fn emit_bumps_updated_at() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool).await;
        let registry = make_artifact_registry();
        let (tx, _rx) = mpsc::channel(8);

        let before = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .updated_at;

        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        let ctx = make_ctx(pool.clone(), run_id, si_id, registry, tx);
        ctx.emit(EmitArgs {
            output_name: "out".into(),
            artifact_type: "any".into(),
            body: json!({"x": 1}),
            label: None,
            parent_artifact_id: None,
        })
        .await
        .unwrap();

        let after = queries::get_stage_instance_by_id(&pool, &si_id)
            .await
            .unwrap()
            .updated_at;

        assert!(
            after > before,
            "emit must advance updated_at (before={before:?}, after={after:?})"
        );
    }
}
