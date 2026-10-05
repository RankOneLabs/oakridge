pub mod protocol;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type CoreResult<T> = Result<T, DomainError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DomainError {
    pub operation: String,
    pub entity_id: String,
    pub kind: DomainErrorKind,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DomainErrorKind {
    InvalidShape,
    DuplicateScope,
    UnknownScope,
    DuplicateCollection,
    UnknownCollection,
    DuplicatePolicy,
    UnknownPolicy,
    DuplicateBinding,
    DuplicateFact,
    DuplicateState,
    DuplicateAction,
    DuplicateDependency,
    UnknownBinding,
    UnknownFact,
    UnknownState,
    UnknownAction,
    InvalidExpression,
    InvalidLiteral,
    CyclicScope,
    CyclicDecision,
    MissingPayloadField,
    PayloadTypeMismatch,
    MissingObservation,
    Rejected,
}

impl DomainError {
    pub fn new(operation: &str, entity_id: &str, kind: DomainErrorKind, detail: &str) -> Self {
        Self {
            operation: operation.into(),
            entity_id: entity_id.into(),
            kind,
            detail: detail.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefinitionBundle {
    pub id: String,
    pub version: u32,
    pub facts: Vec<String>,
    pub scopes: Vec<Scope>,
    pub collections: Vec<Collection>,
    pub policies: Vec<Policy>,
    pub bindings: Vec<Binding>,
    pub decision: Decision,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub id: String,
    pub depends_on: Vec<String>,
    pub states: Vec<String>,
    pub actions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Collection {
    pub id: String,
    pub scope: String,
    pub item_type: PayloadType,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub id: String,
    pub collection: String,
    pub release: Release,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Release {
    Immediate,
    Accepted,
    Complete,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub source: String,
    pub target: String,
    pub value_type: PayloadType,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PayloadType {
    String,
    Number,
    Boolean,
    Object,
    Array,
    Null,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expression {
    Fact { name: String },
    Equals { binding: String, value: Value },
    All { items: Vec<Expression> },
    Any { items: Vec<Expression> },
    Not { item: Box<Expression> },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Decision {
    If {
        expression: Expression,
        then: Box<Decision>,
        otherwise: Box<Decision>,
    },
    Apply {
        scope: String,
        state: String,
        action: String,
    },
    Wait {
        reason: String,
    },
    Reject {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Snapshot {
    pub facts: Vec<String>,
    pub values: Value,
    pub observations: Vec<Observation>,
    pub timestamp_ms: i64,
    pub random_seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Observation {
    pub collection: String,
    pub item_id: String,
    pub payload: Value,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Effect {
    Apply {
        scope: String,
        state: String,
        action: String,
    },
    Wait {
        reason: String,
    },
    Reject {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DecisionOutcome {
    pub effect: Effect,
    pub trace: Vec<String>,
}

pub fn payload_matches(value: &Value, expected: &PayloadType) -> bool {
    match expected {
        PayloadType::String => value.is_string(),
        PayloadType::Number => value.is_number(),
        PayloadType::Boolean => value.is_boolean(),
        PayloadType::Object => value.is_object(),
        PayloadType::Array => value.is_array(),
        PayloadType::Null => value.is_null(),
    }
}
