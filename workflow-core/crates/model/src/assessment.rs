//! Assessment values, committed facts, and operator commands.
use crate::*;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Citation {
    pub revision_id: RevisionId,
    pub pointer: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackProposal {
    pub key: String,
    pub instruction: String,
    pub citation: Option<Citation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssignmentVerification {
    pub round_id: AssignmentRoundId,
    pub outcome: VerificationOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackItem {
    pub id: FeedbackItemId,
    pub unit: UnitId,
    pub assessment_artifact: SymbolKey,
    pub origin: FeedbackOrigin,
    pub instruction: String,
    pub citation: Option<Citation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentFeedback {
    pub assessment_revision: RevisionId,
    pub item: FeedbackItemId,
    pub association: AssociationKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackRejection {
    pub id: FeedbackRejectionId,
    pub item: FeedbackItemId,
    pub assessment_revision: RevisionId,
    pub assignment: Option<FeedbackAssignmentId>,
    pub reason: String,
    pub decision: DecisionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DispatchAuthorization {
    pub id: DispatchAuthorizationId,
    pub item: FeedbackItemId,
    pub operation: DispatchOperation,
    pub target: DispatchTarget,
    pub instruction: String,
    pub recipients: Vec<SymbolKey>,
    pub policy: DispatchPolicyKind,
    pub authorized_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DispatchTarget {
    pub unit: UnitId,
    pub artifact: SymbolKey,
    pub revision: RevisionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackAssignment {
    pub id: FeedbackAssignmentId,
    pub item: FeedbackItemId,
    pub target_unit: UnitId,
    pub target_artifact: SymbolKey,
    pub recipient: SymbolKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssignmentRound {
    pub id: AssignmentRoundId,
    pub assignment: FeedbackAssignmentId,
    pub ordinal: u32,
    pub authorization: DispatchAuthorizationId,
    pub instruction: String,
    pub decision: DecisionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssignmentUpdate {
    pub round: AssignmentRoundId,
    pub revision: RevisionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssignmentVerificationFact {
    pub id: AssignmentVerificationId,
    pub round: AssignmentRoundId,
    pub assessment_revision: RevisionId,
    pub update_revision: RevisionId,
    pub outcome: VerificationOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentApproval {
    pub id: AssessmentApprovalId,
    pub unit: UnitId,
    pub assessment_revision: RevisionId,
    pub assessed_revision: RevisionId,
    pub decision: DecisionId,
    pub approved_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentStatus {
    pub unit: UnitId,
    pub assessment_artifact: SymbolKey,
    pub assessment_revision: RevisionId,
    pub approval: ApprovalState,
    pub unresolved_proposals: Vec<FeedbackItemId>,
    pub items: Vec<ItemProgress>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ItemProgress {
    pub item: FeedbackItemId,
    pub assignments: Vec<AssignmentProgressEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssignmentProgressEntry {
    pub assignment: FeedbackAssignmentId,
    pub recipient: SymbolKey,
    pub current_round: AssignmentRoundId,
    pub progress: AssignmentProgress,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentDecisionCommand {
    pub decision: SymbolKey,
    pub target: RevisionId,
    pub assessed_revision: RevisionId,
    pub dispositions: Vec<FeedbackDisposition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DispatchAuthorizationRequest {
    pub item: FeedbackItemId,
    pub target_revision: RevisionId,
    pub instruction: String,
    pub recipients: Vec<SymbolKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackItemRequest {
    pub instruction: String,
    pub citation: Option<Citation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentEmbeddings {
    pub proposals: Vec<Vec<PathSegment>>,
    pub verifications: Vec<Vec<PathSegment>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RoundRequest {
    pub round: AssignmentRoundId,
    pub assignment: FeedbackAssignmentId,
    pub worker: SymbolKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerificationOutcome {
    Verified,
    NeedsFurtherWork,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssociationKind {
    Proposed,
    Carried,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DispatchOperation {
    DispatchFeedback,
    DirectCorrection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DispatchPolicyKind {
    OperatorRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentProgress {
    AwaitingUpdate,
    AwaitingVerification,
    ReturnedForUpdate,
    AssessorVerified,
    AcceptedByOperator,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FeedbackOrigin {
    Proposal { revision: RevisionId, key: String },
    Operator { request_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApprovalState {
    Pending,
    Approved { approval: AssessmentApprovalId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FeedbackDisposition {
    Reject {
        item: FeedbackItemId,
        reason: String,
    },
    RejectFollowUp {
        assignment: FeedbackAssignmentId,
        reason: String,
    },
    Dispatch {
        item: FeedbackItemId,
        instruction: String,
        recipients: Vec<SymbolKey>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PathSegment {
    Field(String),
    Each,
}

pub fn core_schemas() -> BTreeMap<&'static str, Type> {
    [
        ("citation", "{revision_id: text, pointer: text}"),
        (
            "feedback_proposal",
            "{key: ident, instruction: text, citation: optional(citation)}",
        ),
        (
            "assignment_verification",
            "{round_id: text, outcome: enum(verified, needs_further_work)}",
        ),
    ]
    .into_iter()
    .map(|(name, schema)| {
        (
            name,
            Type::parse(schema).expect("valid core assessment schema"),
        )
    })
    .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentContracts {
    pub citation: Citation,
    pub feedback_proposal: FeedbackProposal,
    pub assignment_verification: AssignmentVerification,
    pub feedback_item: FeedbackItem,
    pub assessment_feedback: AssessmentFeedback,
    pub feedback_rejection: FeedbackRejection,
    pub dispatch_authorization: DispatchAuthorization,
    pub dispatch_target: DispatchTarget,
    pub feedback_assignment: FeedbackAssignment,
    pub assignment_round: AssignmentRound,
    pub assignment_update: AssignmentUpdate,
    pub assignment_verification_fact: AssignmentVerificationFact,
    pub assessment_approval: AssessmentApproval,
    pub assessment_status: AssessmentStatus,
    pub item_progress: ItemProgress,
    pub assignment_progress_entry: AssignmentProgressEntry,
    pub assessment_decision_command: AssessmentDecisionCommand,
    pub dispatch_authorization_request: DispatchAuthorizationRequest,
    pub feedback_item_request: FeedbackItemRequest,
    pub assessment_embeddings: AssessmentEmbeddings,
    pub round_request: RoundRequest,
    pub verification_outcome: VerificationOutcome,
    pub association_kind: AssociationKind,
    pub dispatch_operation: DispatchOperation,
    pub dispatch_policy_kind: DispatchPolicyKind,
    pub assignment_progress: AssignmentProgress,
    pub feedback_origin: FeedbackOrigin,
    pub approval_state: ApprovalState,
    pub feedback_disposition: FeedbackDisposition,
    pub path_segment: PathSegment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DispatchPayload {
    pub rounds: Vec<RoundRequest>,
}
