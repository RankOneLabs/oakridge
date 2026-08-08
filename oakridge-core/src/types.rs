use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GateDecisionAuditId(pub Uuid);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EpicWorkflowProfileId(pub Uuid);

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
    /// Fully resolved working directory for this unit.
    pub workdir_path: Option<String>,
    pub status: UnitStatus,
    pub gate_state: Option<Value>,
    pub artifact_id: Option<ArtifactId>,
    /// Upstream artifact that caused this unit to be materialized. Present for
    /// incrementally delivered fan-out units and used as the idempotency key.
    pub source_artifact_id: Option<ArtifactId>,
    pub terminal_meta: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InputDelivery {
    /// Make the input visible only after every producer stage is complete.
    #[default]
    ProducerComplete,
    /// Materialize the matching consumer unit whenever a producer unit completes.
    UnitComplete,
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

/// Stable semantic role used by operator surfaces and dev-flow policy.
///
/// Stage keys remain workflow-local identifiers and must not be interpreted as
/// lifecycle roles by consumers.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StageOperatorRole {
    Spec,
    Plan,
    Brief,
    Build,
    Assessment,
    FinalIntegration,
}

// --- Workflow-definition graph types ---

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct InputSlot {
    pub name: String,
    pub artifact_type: ArtifactTypeId,
    #[serde(default)]
    pub optional: bool,
    /// Preserve the latest artifact from every producer unit for this input.
    #[serde(default)]
    pub collect: bool,
    /// Controls when artifacts from delegated fan-out producers become available.
    #[serde(default)]
    pub delivery: InputDelivery,
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
    /// Optional for compatibility with generic and pre-role workflow definitions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_role: Option<StageOperatorRole>,
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
    /// Retired from the launcher surface but still resolvable by the runs that
    /// reference it. Defaults false so a def POSTed without the field is active.
    #[serde(default)]
    pub archived: bool,
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FinalMergePolicy {
    Guarded,
    ExternalConfirmation,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EpicLifecycleState {
    Draft,
    Active,
    FinalIntegration,
    Completed,
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FinalMergeState {
    #[default]
    Pending,
    PullRequestOpen,
    Merged,
    ClosedWithoutMerge,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PullRequestReference {
    pub number: u64,
    pub url: String,
    pub head_branch: String,
    pub base_branch: String,
}

/// One repository participating in a dev-flow Epic.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct EpicRepositoryBinding {
    pub repository_key: String,
    pub repository_path: PathBuf,
    pub base_branch: String,
    pub epic_branch: String,
    pub final_pull_request: Option<PullRequestReference>,
    pub final_merge_state: FinalMergeState,
}

/// Typed dev-flow projection linked one-to-one to the generic workflow run.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct EpicWorkflowProfile {
    pub id: EpicWorkflowProfileId,
    pub workflow_run_id: WorkflowRunId,
    pub title: String,
    pub slug: String,
    pub lifecycle_state: EpicLifecycleState,
    pub final_merge_policy: FinalMergePolicy,
    pub repositories: Vec<EpicRepositoryBinding>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl EpicWorkflowProfile {
    pub fn validate(&self) -> crate::Result<()> {
        use std::collections::HashSet;

        if self.title.trim().is_empty() || self.slug.trim().is_empty() {
            return Err(crate::Error::Validation(
                "epic title and slug must be non-empty".into(),
            ));
        }
        let slug_is_valid = self.slug.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        }) && !self.slug.starts_with(['-', '_'])
            && !self.slug.ends_with(['-', '_']);
        if !slug_is_valid {
            return Err(crate::Error::Validation(
                "epic slug must contain lowercase ASCII letters, digits, hyphens, or underscores"
                    .into(),
            ));
        }
        if self.repositories.is_empty() {
            return Err(crate::Error::Validation(
                "an Epic must bind at least one repository".into(),
            ));
        }
        let mut keys = HashSet::new();
        let mut paths = HashSet::new();
        let mut epic_branches = HashSet::new();
        for repository in &self.repositories {
            if repository.repository_key.trim().is_empty()
                || repository.repository_path.as_os_str().is_empty()
                || repository.base_branch.trim().is_empty()
                || repository.epic_branch.trim().is_empty()
            {
                return Err(crate::Error::Validation(
                    "repository key, path, base branch, and epic branch must be non-empty".into(),
                ));
            }
            if !repository.repository_path.is_absolute() {
                return Err(crate::Error::Validation(format!(
                    "repository {} path must be absolute",
                    repository.repository_key
                )));
            }
            if !is_valid_git_branch_name(&repository.base_branch)
                || !is_valid_git_branch_name(&repository.epic_branch)
            {
                return Err(crate::Error::Validation(format!(
                    "repository {} has an invalid base or epic branch",
                    repository.repository_key
                )));
            }
            if repository.base_branch == repository.epic_branch {
                return Err(crate::Error::Validation(format!(
                    "repository {} has identical base and epic branches",
                    repository.repository_key
                )));
            }
            if !keys.insert(repository.repository_key.as_str()) {
                return Err(crate::Error::Validation(format!(
                    "duplicate repository key {}",
                    repository.repository_key
                )));
            }
            if !paths.insert(repository.repository_path.as_path()) {
                return Err(crate::Error::Validation(format!(
                    "duplicate repository path {}",
                    repository.repository_path.display()
                )));
            }
            if !epic_branches.insert((
                repository.repository_path.as_path(),
                repository.epic_branch.as_str(),
            )) {
                return Err(crate::Error::Validation(format!(
                    "duplicate epic branch {} for repository path {}",
                    repository.epic_branch,
                    repository.repository_path.display()
                )));
            }
            if let Some(pull_request) = &repository.final_pull_request {
                if pull_request.number == 0
                    || pull_request.number > i64::MAX as u64
                    || pull_request.url.trim().is_empty()
                    || pull_request.head_branch != repository.epic_branch
                    || pull_request.base_branch != repository.base_branch
                {
                    return Err(crate::Error::Validation(format!(
                        "final pull request does not match repository {} binding",
                        repository.repository_key
                    )));
                }
            }
            let state_matches_metadata = match repository.final_merge_state {
                FinalMergeState::Pending => repository.final_pull_request.is_none(),
                FinalMergeState::PullRequestOpen
                | FinalMergeState::Merged
                | FinalMergeState::ClosedWithoutMerge => repository.final_pull_request.is_some(),
            };
            if !state_matches_metadata {
                return Err(crate::Error::Validation(format!(
                    "repository {} final merge state does not match pull request metadata",
                    repository.repository_key
                )));
            }
        }
        Ok(())
    }
}

fn is_valid_git_branch_name(branch: &str) -> bool {
    !branch.is_empty()
        && branch != "@"
        && !branch.starts_with('/')
        && !branch.ends_with('.')
        && !branch.ends_with('/')
        && !branch.contains("..")
        && branch.split('/').all(|component| {
            !component.is_empty()
                && !component.starts_with('.')
                && !component.ends_with(".lock")
        })
        && !branch.contains("@{")
        && !branch.chars().any(|character| {
            character.is_control() || character.is_whitespace() || "~^:?*[\\".contains(character)
        })
}

// --- Strict dev-flow artifact contracts ---

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Blocking,
    Warning,
    Info,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpecFinding {
    pub id: String,
    pub description: String,
    pub severity: FindingSeverity,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Implementable,
    Blocked,
    Ambiguous,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpecRequirement {
    pub id: String,
    pub description: String,
    pub status: RequirementStatus,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DevRisk {
    pub description: String,
    pub mitigation: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpecAnalysisBody {
    pub summary: String,
    pub source_spec_refs: Vec<String>,
    pub findings: Vec<SpecFinding>,
    pub requirements: Vec<SpecRequirement>,
    pub risks: Vec<DevRisk>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PlanCohort {
    pub id: String,
    pub repository_key: Option<String>,
    pub title: String,
    pub scope: String,
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub files_in_scope: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PlanScope {
    #[serde(default)]
    pub in_scope: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PlanBody {
    pub summary: String,
    pub cohorts: Vec<PlanCohort>,
    pub dependency_order: Vec<String>,
    pub scope: PlanScope,
    pub acceptance_criteria: Vec<String>,
    pub risks: Vec<DevRisk>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BriefDecision {
    pub decision: String,
    pub rationale: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RejectedApproach {
    pub approach: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BuildBriefBody {
    pub cohort_id: String,
    pub repository_key: String,
    pub title: String,
    pub depends_on: Vec<String>,
    pub goal: String,
    pub files_in_scope: Vec<String>,
    pub decisions_made: Vec<BriefDecision>,
    pub approaches_rejected: Vec<RejectedApproach>,
    pub acceptance_criteria: Vec<String>,
    pub next_action: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TestEvidence {
    #[serde(default)]
    pub passed: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    /// Legacy v1/v2 evidence key retained as a typed compatibility field.
    #[serde(default)]
    pub cargo_test_output: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DelegatedBuildMetadata {
    #[serde(default)]
    pub cohort_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BuildIssue {
    pub description: String,
    pub severity: FindingSeverity,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BuildResultBody {
    pub repository_key: Option<String>,
    pub summary: String,
    pub changed_files: Vec<String>,
    pub tests: TestEvidence,
    pub delegated_session_metadata: Option<DelegatedBuildMetadata>,
    pub known_issues: Vec<BuildIssue>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentVerdict {
    Pass,
    PassWithNotes,
    Fail,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CriterionStatus {
    Met,
    NotMet,
    Partial,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AssessmentFinding {
    #[serde(default)]
    pub criterion: Option<String>,
    #[serde(default)]
    pub status: Option<CriterionStatus>,
    #[serde(default)]
    pub evidence: Option<String>,
    /// Legacy assessment findings used a single description field.
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AssessmentBody {
    pub verdict: AssessmentVerdict,
    pub findings: Vec<AssessmentFinding>,
    pub test_evidence: Option<TestEvidence>,
    pub recommended_next_actions: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PrSummaryBody {
    pub pr_url: String,
    pub branch: String,
    pub summary: String,
    pub review_status: Option<PrReviewStatus>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrReviewStatus {
    Draft,
    Ready,
    ChangesRequested,
    Approved,
    Merged,
    Closed,
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

/// An immutable gate-decision request plus its durable application status.
///
/// The decision boundary owns the idempotency key. Persisting the same key again is
/// a successful no-op, which makes post-decision retries safe without duplicating
/// the audit trail.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct GateDecisionAudit {
    pub id: GateDecisionAuditId,
    pub run_id: WorkflowRunId,
    pub stage_instance_id: StageInstanceId,
    pub unit_id: String,
    pub artifact_chain_id: ArtifactId,
    pub artifact_revision_id: ArtifactId,
    pub gate_step: String,
    pub action: String,
    pub operator_comment: Option<String>,
    pub feedback: Option<String>,
    pub status: GateDecisionAuditStatus,
    pub created_at: DateTime<Utc>,
    pub applied_at: Option<DateTime<Utc>>,
    pub idempotency_key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GateDecisionAuditStatus {
    Pending,
    Applied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecisionAuditInsert {
    Inserted,
    AlreadyRecorded,
}

/// A resolved scheduler input: either one producer artifact or an ordered,
/// provenance-preserving collection keyed by producer unit id.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedInput {
    Single(Artifact),
    Collection(BTreeMap<String, Artifact>),
}

impl ResolvedInput {
    /// Convert this input to the JSON value visible to prompt/config bindings.
    /// Collections preserve their ordered producer-unit keys in envelopes.
    pub fn to_binding_value(&self) -> Value {
        match self {
            Self::Single(artifact) => artifact.body.clone(),
            Self::Collection(artifacts) => Value::Array(
                artifacts
                    .iter()
                    .map(|(unit_id, artifact)| {
                        serde_json::json!({
                            "unit_id": unit_id,
                            "artifact_id": artifact.id,
                            "artifact": artifact.body
                        })
                    })
                    .collect(),
            ),
        }
    }
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
        assert!(!slot.collect);
        assert_eq!(slot.delivery, InputDelivery::ProducerComplete);
    }

    #[test]
    fn input_slot_deserializes_unit_complete_delivery() {
        let slot: InputSlot = serde_json::from_value(json!({
            "name": "build_result",
            "artifact_type": "dev.build_result",
            "delivery": "unit_complete"
        }))
        .unwrap();
        assert_eq!(slot.delivery, InputDelivery::UnitComplete);
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
                            operator_role: None,
                            stage_type: "llm".to_string(),
                            config: json!({"model": "gpt-4"}),
                            inputs: vec![InputSlot {
                                name: "prompt".to_string(),
                                artifact_type: "text".to_string(),
                                optional: false,
                                collect: false,
                                delivery: InputDelivery::ProducerComplete,
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
            archived: false,
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

    fn valid_epic_profile() -> EpicWorkflowProfile {
        EpicWorkflowProfile {
            id: EpicWorkflowProfileId(test_uuid()),
            workflow_run_id: WorkflowRunId(test_uuid()),
            title: "Typed parity".into(),
            slug: "typed-parity".into(),
            lifecycle_state: EpicLifecycleState::Draft,
            final_merge_policy: FinalMergePolicy::Guarded,
            repositories: vec![EpicRepositoryBinding {
                repository_key: "oakridge".into(),
                repository_path: "/repos/oakridge".into(),
                base_branch: "develop".into(),
                epic_branch: "epic/typed-parity".into(),
                final_pull_request: None,
                final_merge_state: FinalMergeState::Pending,
            }],
            created_at: now(),
            updated_at: now(),
        }
    }

    #[test]
    fn epic_profile_rejects_duplicate_repository_keys() {
        let mut profile = valid_epic_profile();
        profile.repositories.push(EpicRepositoryBinding {
            repository_path: "/repos/other".into(),
            ..profile.repositories[0].clone()
        });
        assert!(profile.validate().is_err());
    }

    #[test]
    fn epic_profile_rejects_git_invalid_branch_components() {
        for branch in ["epic/.hidden", "epic/a.lock/b", "a//b", "@"] {
            let mut profile = valid_epic_profile();
            profile.repositories[0].epic_branch = branch.into();
            assert!(
                profile.validate().is_err(),
                "branch {branch:?} must be rejected"
            );
        }
    }

    #[test]
    fn epic_profile_requires_pr_metadata_to_match_binding_and_state() {
        let mut profile = valid_epic_profile();
        profile.repositories[0].final_merge_state = FinalMergeState::PullRequestOpen;
        assert!(profile.validate().is_err());

        profile.repositories[0].final_pull_request = Some(PullRequestReference {
            number: 42,
            url: "https://example.test/pull/42".into(),
            head_branch: "wrong-head".into(),
            base_branch: "develop".into(),
        });
        assert!(profile.validate().is_err());

        profile.repositories[0]
            .final_pull_request
            .as_mut()
            .unwrap()
            .head_branch = "epic/typed-parity".into();
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn strict_artifact_contracts_accept_v6_prompt_shapes() {
        let plan: PlanBody = serde_json::from_value(json!({
            "summary": "plan",
            "cohorts": [{
                "id": "a", "repository_key": "oakridge", "title": "A",
                "scope": "Implement A", "depends_on": [], "description": null,
                "files_in_scope": ["src/a.rs"], "decisions": ["typed"],
                "acceptance_criteria": ["tests pass"]
            }],
            "dependency_order": ["a"],
            "scope": {"in_scope": ["A"], "out_of_scope": []},
            "acceptance_criteria": ["tests pass"],
            "risks": [{"description": "risk", "mitigation": "test"}]
        }))
        .unwrap();
        assert_eq!(plan.cohorts[0].repository_key.as_deref(), Some("oakridge"));

        let assessment: AssessmentBody = serde_json::from_value(json!({
            "verdict": "pass",
            "findings": [{"criterion": "tests pass", "status": "met", "evidence": "cargo test"}],
            "test_evidence": {"passed": 1, "failed": 0, "summary": "green"},
            "recommended_next_actions": []
        }))
        .unwrap();
        assert_eq!(assessment.verdict, AssessmentVerdict::Pass);
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
