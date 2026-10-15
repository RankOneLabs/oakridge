use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A workflow after all names, types and expressions have been checked.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedWorkflow {
    pub digest: BundleDigest,
    pub input: CheckedType,
    pub stages: Vec<CheckedStage>,
    pub root: CheckedGroup,
}

/// Checked positions use the same closed type vocabulary as source positions.
pub type CheckedType = Type;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedGroup {
    pub pools: BTreeMap<String, u32>,
    pub units: Vec<CheckedUnit>,
    pub outcome: Vec<CheckedNamedExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedUnit {
    pub key: SymbolKey,
    pub stage: Option<SymbolKey>,
    pub pool: Option<SymbolKey>,
    pub input: Vec<CheckedNamedExpression>,
    pub after: CheckedUnitDependencies,
    pub collection: Option<CheckedUnitCollection>,
    pub group: Option<Box<CheckedGroup>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedUnitDependencies {
    None,
    Fixed { keys: Vec<SymbolKey> },
    Each { keys: Vec<SymbolKey> },
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
    pub artifacts: Vec<CheckedArtifact>,
    pub workers: Vec<CheckedWorker>,
    pub done_when: CheckedStageExpression,
    pub outcome: Vec<CheckedNamedExpression>,
    pub reviews: Vec<CheckedReview>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedArtifact {
    pub key: SymbolKey,
    pub schema: CheckedType,
    pub validations: Vec<CheckedArtifactValidation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedArtifactValidation {
    pub expression: CheckedStageExpression,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedDecision {
    pub effect: DeclaredDecisionEffect,
    pub on: Option<SymbolKey>,
    pub payload: Option<CheckedType>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedEngineDecision {
    pub key: SymbolKey,
    pub effect: DeclaredDecisionEffect,
    pub on: Option<SymbolKey>,
    pub feedback: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedReview {
    Operator {
        key: SymbolKey,
        of: SymbolKey,
        inputs: Vec<CheckedNamedExpression>,
        when: Option<CheckedStageExpression>,
        decisions: BTreeMap<String, CheckedDecision>,
    },
    Engine {
        key: SymbolKey,
        of: SymbolKey,
        when: CheckedStageExpression,
        decision: CheckedEngineDecision,
    },
}
impl CheckedReview {
    pub fn key(&self) -> &SymbolKey {
        match self {
            Self::Operator { key, .. } | Self::Engine { key, .. } => key,
        }
    }
    pub fn of(&self) -> &SymbolKey {
        match self {
            Self::Operator { of, .. } | Self::Engine { of, .. } => of,
        }
    }
    pub fn when(&self) -> Option<&CheckedStageExpression> {
        match self {
            Self::Operator { when, .. } => when.as_ref(),
            Self::Engine { when, .. } => Some(when),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedWorker {
    Agent {
        key: WorkerKey,
        inputs: Vec<CheckedNamedExpression>,
        creates: Vec<SymbolKey>,
        reviews: Option<SymbolKey>,
        workspace: Option<CheckedStageExpression>,
        when: Option<CheckedStageExpression>,
    },
    Code {
        key: WorkerKey,
        inputs: Vec<CheckedNamedExpression>,
        creates: Vec<SymbolKey>,
        every: Option<String>,
        when: Option<CheckedStageExpression>,
    },
}
impl CheckedWorker {
    pub fn key(&self) -> &WorkerKey {
        match self {
            Self::Agent { key, .. } | Self::Code { key, .. } => key,
        }
    }
    pub fn inputs(&self) -> &[CheckedNamedExpression] {
        match self {
            Self::Agent { inputs, .. } | Self::Code { inputs, .. } => inputs,
        }
    }
    pub fn creates(&self) -> &[SymbolKey] {
        match self {
            Self::Agent { creates, .. } | Self::Code { creates, .. } => creates,
        }
    }
    pub fn when(&self) -> Option<&CheckedStageExpression> {
        match self {
            Self::Agent { when, .. } | Self::Code { when, .. } => when.as_ref(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedNamedExpression {
    pub key: String,
    pub value: CheckedStageExpression,
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
