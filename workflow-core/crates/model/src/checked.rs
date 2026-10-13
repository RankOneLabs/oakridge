use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A v2 workflow after all names, scopes and expressions have been checked.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedWorkflow {
    pub source: Workflow,
    pub digest: BundleDigest,
    pub stages: Vec<CheckedStage>,
    pub root: CheckedGroup,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedGroup {
    pub units: Vec<CheckedUnit>,
    pub outcome: Vec<CheckedNamedExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedUnit {
    pub key: SymbolKey,
    pub input: Vec<CheckedNamedExpression>,
    pub after: Vec<SymbolKey>,
    pub collection: Option<CheckedUnitCollection>,
    pub group: Option<Box<CheckedGroup>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedUnitCollection {
    pub source: CheckedStageExpression,
    pub key: CheckedStageExpression,
    pub after: CheckedStageExpression,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedStage {
    pub key: SymbolKey,
    pub workers: Vec<CheckedWorker>,
    pub done_when: CheckedStageExpression,
    pub outcome: Vec<CheckedNamedExpression>,
    pub validations: Vec<CheckedArtifactValidation>,
    pub reviews: Vec<CheckedReview>,
}

/// An operator review's checked `inputs`, which its prompt is rendered with.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedReview {
    pub key: SymbolKey,
    pub of: SymbolKey,
    pub inputs: Vec<CheckedNamedExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedWorker {
    pub key: WorkerKey,
    pub inputs: Vec<CheckedNamedExpression>,
    /// The expression inside `repository(<expr>)`; None for `none` or no workspace.
    pub workspace: Option<CheckedStageExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedNamedExpression {
    pub key: String,
    pub value: CheckedStageExpression,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedArtifactValidation {
    pub artifact: SymbolKey,
    pub checks: Vec<CheckedStageExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedStageExpression {
    pub source: String,
    pub value_type: TypeExpression,
    /// The resolved expression. Evaluation walks this; `source` is kept for
    /// traces and error messages only.
    pub expression: Expression,
}
