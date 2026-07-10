use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

// --- Newtype UUID identifiers ---

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkflowDefId(pub Uuid);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkflowRunId(pub Uuid);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StageInstanceId(pub Uuid);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ArtifactId(pub Uuid);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProjectId(pub Uuid);

// --- String aliases ---

pub type StageKey = String;
pub type StageTypeId = String;
pub type ArtifactTypeId = String;

// --- Status enums ---

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StageStatus {
    Pending,
    Running,
    Parked,
    Done,
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UnitStatus {
    Pending,
    Running,
    Parked,
    Done,
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SessionUnit {
    pub stage_instance_id: StageInstanceId,
    pub unit_id: String,
    pub params: Option<Value>,
    pub depends_on: Vec<String>,
    pub external_ref: Option<String>,
    pub worktree_branch: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_base_ref: Option<String>,
    pub status: UnitStatus,
    pub gate_state: Option<Value>,
    pub artifact_id: Option<ArtifactId>,
    pub terminal_meta: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Derive aggregate stage status from unit statuses per spec §3.3:
/// - all done → Done
/// - any failed OR parked → Parked (surface for operator; siblings keep running)
/// - otherwise → Running
/// - empty → Pending
pub fn derive_stage_status_from_units(units: &[UnitStatus]) -> StageStatus {
    if units.is_empty() {
        return StageStatus::Pending;
    }
    if units.iter().all(|u| matches!(u, UnitStatus::Done)) {
        return StageStatus::Done;
    }
    if units
        .iter()
        .any(|u| matches!(u, UnitStatus::Failed | UnitStatus::Parked))
    {
        return StageStatus::Parked;
    }
    StageStatus::Running
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GateOutcome {
    Pass,
    Fail,
    Rerun,
}

// --- Workflow-definition graph types ---

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct InputSlot {
    pub name: String,
    pub artifact_type: ArtifactTypeId,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct OutputSlot {
    pub name: String,
    pub artifact_type: ArtifactTypeId,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct EdgeEndpoint {
    pub stage: StageKey,
    pub slot: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Edge {
    pub from: EdgeEndpoint,
    pub to: EdgeEndpoint,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StageNodeDef {
    pub stage_type: StageTypeId,
    pub config: Value,
    pub inputs: Vec<InputSlot>,
    pub outputs: Vec<OutputSlot>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkflowGraph {
    pub stages: HashMap<StageKey, StageNodeDef>,
    pub edges: Vec<Edge>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkflowDef {
    pub id: WorkflowDefId,
    pub name: String,
    pub version: i32,
    pub graph: WorkflowGraph,
    pub created_at: DateTime<Utc>,
}

// --- Runtime types ---

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub repo_dir: PathBuf,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkflowRun {
    pub id: WorkflowRunId,
    pub workflow_def_id: WorkflowDefId,
    pub project_id: Option<ProjectId>,
    pub status: RunStatus,
    pub context: Value,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StageInstance {
    pub id: StageInstanceId,
    pub run_id: WorkflowRunId,
    pub stage_key: StageKey,
    pub stage_type: StageTypeId,
    pub status: StageStatus,
    pub config: Value,
    pub parked_reason: Option<String>,
    /// Structured metadata an executor attaches while a stage is parked.
    /// Surfaced on `GET /stage_instances/:id` so a client can act on the park;
    /// the substrate does not interpret it.
    pub parked_meta: Option<Value>,
    /// Structured metadata an executor attaches when a stage reaches a terminal
    /// status. Surfaced on read models; the substrate does not interpret it.
    pub terminal_meta: Option<Value>,
    pub external_ref: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StageInstanceSummary {
    pub stage_instance_id: StageInstanceId,
    pub workflow_run_id: WorkflowRunId,
    pub stage_key: StageKey,
    pub status: StageStatus,
    pub parked_reason: Option<String>,
    pub parked_meta: Option<Value>,
    pub terminal_meta: Option<Value>,
    pub external_ref: Option<String>,
}

impl From<&StageInstance> for StageInstanceSummary {
    fn from(stage_instance: &StageInstance) -> Self {
        Self {
            stage_instance_id: stage_instance.id,
            workflow_run_id: stage_instance.run_id,
            stage_key: stage_instance.stage_key.clone(),
            status: stage_instance.status,
            parked_reason: stage_instance.parked_reason.clone(),
            parked_meta: stage_instance.parked_meta.clone(),
            terminal_meta: stage_instance.terminal_meta.clone(),
            external_ref: stage_instance.external_ref.clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Artifact {
    pub id: ArtifactId,
    pub run_id: WorkflowRunId,
    pub stage_instance_id: StageInstanceId,
    pub artifact_type: ArtifactTypeId,
    /// The output slot name on the producing stage. Set by the executor at emit
    /// time; None only for artifacts created before migration 0002.
    pub output_name: Option<String>,
    pub label: Option<String>,
    pub body: Value,
    /// Revision number: 1 for a root artifact, parent.version + 1 for a revision.
    pub version: i32,
    pub parent_artifact_id: Option<ArtifactId>,
    pub created_at: DateTime<Utc>,
}

// --- Gate vocabulary ---

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GateDecision {
    pub outcome: GateOutcome,
    pub comment: Option<String>,
    pub feedback: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn test_uuid() -> Uuid {
        Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap()
    }

    // --- Canonical variant-set assertions ---

    #[test]
    fn stage_status_canonical_variants() {
        let variants = [
            (StageStatus::Pending, "pending"),
            (StageStatus::Running, "running"),
            (StageStatus::Parked, "parked"),
            (StageStatus::Done, "done"),
            (StageStatus::Failed, "failed"),
        ];
        for (variant, expected) in &variants {
            let s = serde_json::to_value(variant).unwrap();
            assert_eq!(
                s,
                json!(expected),
                "StageStatus::{:?} should serialize as {:?}",
                variant,
                expected
            );
        }
    }

    #[test]
    fn run_status_canonical_variants() {
        let variants = [
            (RunStatus::Pending, "pending"),
            (RunStatus::Running, "running"),
            (RunStatus::Done, "done"),
            (RunStatus::Failed, "failed"),
        ];
        for (variant, expected) in &variants {
            let s = serde_json::to_value(variant).unwrap();
            assert_eq!(
                s,
                json!(expected),
                "RunStatus::{:?} should serialize as {:?}",
                variant,
                expected
            );
        }
    }

    #[test]
    fn gate_outcome_canonical_variants() {
        let variants = [
            (GateOutcome::Pass, "pass"),
            (GateOutcome::Fail, "fail"),
            (GateOutcome::Rerun, "rerun"),
        ];
        for (variant, expected) in &variants {
            let s = serde_json::to_value(variant).unwrap();
            assert_eq!(
                s,
                json!(expected),
                "GateOutcome::{:?} should serialize as {:?}",
                variant,
                expected
            );
        }
    }

    // --- Round-trip tests ---

    #[test]
    fn newtype_ids_roundtrip() {
        let expected_str = json!("00000000-0000-0000-0000-000000000001");

        let id = WorkflowDefId(test_uuid());
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v, expected_str,
            "WorkflowDefId must serialize as bare UUID string"
        );
        let back: WorkflowDefId = serde_json::from_value(v).unwrap();
        assert_eq!(id, back);

        let id = WorkflowRunId(test_uuid());
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v, expected_str,
            "WorkflowRunId must serialize as bare UUID string"
        );
        let back: WorkflowRunId = serde_json::from_value(v).unwrap();
        assert_eq!(id, back);

        let id = StageInstanceId(test_uuid());
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v, expected_str,
            "StageInstanceId must serialize as bare UUID string"
        );
        let back: StageInstanceId = serde_json::from_value(v).unwrap();
        assert_eq!(id, back);

        let id = ArtifactId(test_uuid());
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v, expected_str,
            "ArtifactId must serialize as bare UUID string"
        );
        let back: ArtifactId = serde_json::from_value(v).unwrap();
        assert_eq!(id, back);

        let id = ProjectId(test_uuid());
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v, expected_str,
            "ProjectId must serialize as bare UUID string"
        );
        let back: ProjectId = serde_json::from_value(v).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn input_slot_optional_defaults_false() {
        let json = json!({"name": "x", "artifact_type": "file"});
        let slot: InputSlot = serde_json::from_value(json).unwrap();
        assert!(!slot.optional);
    }

    #[test]
    fn workflow_def_roundtrip() {
        let def = WorkflowDef {
            id: WorkflowDefId(test_uuid()),
            name: "test-workflow".to_string(),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "stage1".to_string(),
                        StageNodeDef {
                            stage_type: "llm".to_string(),
                            config: json!({"model": "gpt-4"}),
                            inputs: vec![InputSlot {
                                name: "prompt".to_string(),
                                artifact_type: "text".to_string(),
                                optional: false,
                            }],
                            outputs: vec![OutputSlot {
                                name: "response".to_string(),
                                artifact_type: "text".to_string(),
                            }],
                        },
                    );
                    m
                },
                edges: vec![],
            },
            created_at: now(),
        };
        let v = serde_json::to_value(&def).unwrap();
        let back: WorkflowDef = serde_json::from_value(v).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn project_roundtrip() {
        let p = Project {
            id: ProjectId(test_uuid()),
            name: "my-project".to_string(),
            repo_dir: PathBuf::from("/repos/my-project"),
            created_at: now(),
        };
        let v = serde_json::to_value(&p).unwrap();
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn workflow_run_roundtrip() {
        let run = WorkflowRun {
            id: WorkflowRunId(test_uuid()),
            workflow_def_id: WorkflowDefId(test_uuid()),
            project_id: None,
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: now(),
            updated_at: now(),
        };
        let v = serde_json::to_value(&run).unwrap();
        let back: WorkflowRun = serde_json::from_value(v).unwrap();
        assert_eq!(run, back);
    }

    #[test]
    fn stage_instance_roundtrip() {
        let si = StageInstance {
            id: StageInstanceId(test_uuid()),
            run_id: WorkflowRunId(test_uuid()),
            stage_key: "stage1".to_string(),
            stage_type: "llm".to_string(),
            status: StageStatus::Parked,
            config: json!({"k": "v"}),
            parked_reason: Some("waiting on human gate".to_string()),
            parked_meta: Some(json!({"request_id": "abc"})),
            terminal_meta: Some(json!({"reason": "completed"})),
            external_ref: None,
            started_at: Some(now()),
            ended_at: None,
            created_at: now(),
            updated_at: now(),
        };
        let v = serde_json::to_value(&si).unwrap();
        let back: StageInstance = serde_json::from_value(v).unwrap();
        assert_eq!(si, back);
    }

    #[test]
    fn artifact_roundtrip() {
        let a = Artifact {
            id: ArtifactId(test_uuid()),
            run_id: WorkflowRunId(test_uuid()),
            stage_instance_id: StageInstanceId(test_uuid()),
            artifact_type: "text".to_string(),
            output_name: Some("out".to_string()),
            label: Some("output".to_string()),
            body: json!({"content": "hello"}),
            version: 1,
            parent_artifact_id: None,
            created_at: now(),
        };
        let v = serde_json::to_value(&a).unwrap();
        let back: Artifact = serde_json::from_value(v).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn unit_status_canonical_variants() {
        let variants = [
            (UnitStatus::Pending, "pending"),
            (UnitStatus::Running, "running"),
            (UnitStatus::Parked, "parked"),
            (UnitStatus::Done, "done"),
            (UnitStatus::Failed, "failed"),
        ];
        for (variant, expected) in &variants {
            let s = serde_json::to_value(variant).unwrap();
            assert_eq!(
                s,
                json!(expected),
                "UnitStatus::{:?} should serialize as {:?}",
                variant,
                expected
            );
        }
    }

    #[test]
    fn derive_stage_status_empty_is_pending() {
        assert_eq!(derive_stage_status_from_units(&[]), StageStatus::Pending);
    }

    #[test]
    fn derive_stage_status_all_done_is_done() {
        assert_eq!(
            derive_stage_status_from_units(&[UnitStatus::Done, UnitStatus::Done]),
            StageStatus::Done
        );
    }

    #[test]
    fn derive_stage_status_any_failed_is_parked() {
        assert_eq!(
            derive_stage_status_from_units(&[UnitStatus::Done, UnitStatus::Failed]),
            StageStatus::Parked
        );
    }

    #[test]
    fn derive_stage_status_any_parked_is_parked() {
        assert_eq!(
            derive_stage_status_from_units(&[UnitStatus::Running, UnitStatus::Parked]),
            StageStatus::Parked
        );
    }

    #[test]
    fn derive_stage_status_running_without_failed_or_parked_is_running() {
        assert_eq!(
            derive_stage_status_from_units(&[UnitStatus::Running, UnitStatus::Pending]),
            StageStatus::Running
        );
    }

    #[test]
    fn gate_decision_roundtrip() {
        let gd = GateDecision {
            outcome: GateOutcome::Rerun,
            comment: Some("needs revision".to_string()),
            feedback: Some("please fix the tone".to_string()),
        };
        let v = serde_json::to_value(&gd).unwrap();
        let back: GateDecision = serde_json::from_value(v).unwrap();
        assert_eq!(gd, back);
    }
}
