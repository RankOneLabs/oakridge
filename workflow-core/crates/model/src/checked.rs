use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A workflow after all names, types and expressions have been checked.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedWorkflow {
    pub digest: BundleDigest,
    #[serde(deserialize_with = "deserialize_checked_type")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<CheckedStageExpression>,
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
    #[serde(deserialize_with = "deserialize_checked_type")]
    pub schema: CheckedType,
    pub edit_policy: EditPolicy,
    pub validations: Vec<CheckedArtifactValidation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub equivalent_subject_fields: Vec<String>,
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
    #[serde(default, skip_serializing_if = "DecisionOperation::is_plain")]
    pub operation: DecisionOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<CheckedDecisionGuard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback_field: Option<String>,
    pub effect: DeclaredDecisionEffect,
    pub on: Option<SymbolKey>,
    #[serde(default, deserialize_with = "deserialize_optional_checked_type")]
    pub payload: Option<CheckedType>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedEngineDecision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<CheckedDecisionGuard>,
    pub key: SymbolKey,
    pub effect: DeclaredDecisionEffect,
    pub on: Option<SymbolKey>,
    pub feedback: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedReview {
    Operator {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assessment: Option<SymbolKey>,
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
        prompts: Prompts,
        inputs: Vec<CheckedNamedExpression>,
        creates: Vec<SymbolKey>,
        reviews: Option<SymbolKey>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        keyed_execution: bool,
        workspace: Option<Box<CheckedStageExpression>>,
        when: Option<CheckedStageExpression>,
    },
    Code {
        key: WorkerKey,
        inputs: Vec<CheckedNamedExpression>,
        creates: Vec<SymbolKey>,
        every: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        track_input_revisions: bool,
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
    /// Required publications; the implicit blocker is an alternative output.
    pub fn required_creates(&self) -> Vec<SymbolKey> {
        self.creates()
            .iter()
            .filter(|key| key.0 != BLOCKER_ARTIFACT)
            .cloned()
            .collect()
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
    #[serde(deserialize_with = "deserialize_checked_type")]
    pub value_type: TypeExpression,
    /// The resolved expression. Evaluation walks this; `source` is kept for
    /// traces and error messages only.
    pub expression: Expression,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedDecisionGuard {
    pub check: CheckedStageExpression,
    pub reason: String,
}

/// Checked types are tagged on the wire. Source types retain their compact decoder,
/// where a record is allowed to have a field literally named `kind`.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum TaggedCheckedType {
    Text,
    Uuid {
        generated: bool,
    },
    Ident,
    RepoPath,
    Boolean,
    Integer,
    Enum {
        variants: Vec<String>,
    },
    Optional {
        value: Box<TaggedCheckedType>,
    },
    List {
        item: Box<TaggedCheckedType>,
    },
    Record {
        fields: BTreeMap<String, TaggedCheckedType>,
    },
    Named {
        schema: SchemaKey,
    },
    OutcomeOf {
        stage: SymbolKey,
    },
}
impl From<TaggedCheckedType> for Type {
    fn from(value: TaggedCheckedType) -> Self {
        match value {
            TaggedCheckedType::Text => Self::Text,
            TaggedCheckedType::Uuid { generated } => Self::Uuid { generated },
            TaggedCheckedType::Ident => Self::Ident,
            TaggedCheckedType::RepoPath => Self::RepoPath,
            TaggedCheckedType::Boolean => Self::Boolean,
            TaggedCheckedType::Integer => Self::Integer,
            TaggedCheckedType::Enum { variants } => Self::Enum { variants },
            TaggedCheckedType::Optional { value } => Self::Optional {
                value: Box::new((*value).into()),
            },
            TaggedCheckedType::List { item } => Self::List {
                item: Box::new((*item).into()),
            },
            TaggedCheckedType::Record { fields } => Self::Record {
                fields: fields
                    .into_iter()
                    .map(|(key, value)| (key, value.into()))
                    .collect(),
            },
            TaggedCheckedType::Named { schema } => Self::Named { schema },
            TaggedCheckedType::OutcomeOf { stage } => Self::OutcomeOf { stage },
        }
    }
}
fn deserialize_checked_type<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Type, D::Error> {
    TaggedCheckedType::deserialize(deserializer).map(Into::into)
}
fn deserialize_optional_checked_type<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Type>, D::Error> {
    Option::<TaggedCheckedType>::deserialize(deserializer).map(|value| value.map(Into::into))
}
