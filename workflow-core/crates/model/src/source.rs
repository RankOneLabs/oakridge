use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimits {
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub max_list_items: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub max_depth: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub evaluation_budget: usize,
}
impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_list_items: 10_000,
            max_depth: crate::protocol::MAX_DEPTH_CEILING,
            evaluation_budget: 1_000_000,
        }
    }
}
impl ResourceLimits {
    /// Bound every JSON container before the compiler or evaluator walks it.
    pub fn check_value(&self, value: &Value) -> Result<(), &'static str> {
        fn visit(limits: &ResourceLimits, value: &Value, depth: usize) -> Result<(), &'static str> {
            match value {
                Value::Array(items) => {
                    if depth >= limits.max_depth {
                        return Err("max_depth exceeded");
                    }
                    if items.len() > limits.max_list_items {
                        return Err("max_list_items exceeded");
                    }
                    for item in items {
                        visit(limits, item, depth + 1)?;
                    }
                }
                Value::Object(fields) => {
                    if depth >= limits.max_depth {
                        return Err("max_depth exceeded");
                    }
                    for field in fields.values() {
                        visit(limits, field, depth + 1)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        visit(self, value, 0)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReferenceRoot {
    // The §2.2 stage scope. The compiler resolves stage expression text to
    // these roots so nothing re-parses the source at evaluation time.
    /// The element a finite list transform binds.
    Item,
    UnitInput,
    EachMember,
    ValidationBody {
        artifact: SymbolKey,
    },
    Latest {
        artifact: SymbolKey,
    },
    Published {
        artifact: SymbolKey,
    },
    Approved {
        artifact: SymbolKey,
    },
    ChangesRequested {
        artifact: SymbolKey,
    },
    UnitOutcome {
        unit: SymbolKey,
    },
    /// Every member outcome of a collection, in key order.
    MemberOutcomes {
        unit: SymbolKey,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expression {
    Literal {
        schema: SchemaId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        value: Value,
    },
    Reference {
        root: ReferenceRoot,
        path: Vec<String>,
    },
    Record {
        fields: Vec<FieldExpression>,
    },
    List {
        schema: SchemaId,
        items: Vec<Expression>,
    },
    Equals {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Len {
        value: Box<Expression>,
    },
    GreaterThan {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    GreaterOrEqual {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    LessThan {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    LessOrEqual {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    All {
        items: Vec<Expression>,
    },
    Any {
        items: Vec<Expression>,
    },
    Not {
        value: Box<Expression>,
    },
    Map {
        source: Box<Expression>,
        value: Box<Expression>,
    },
    Field {
        value: Box<Expression>,
        key: String,
    },
    Contains {
        source: Box<Expression>,
        value: Box<Expression>,
    },
    Lookup {
        source: Box<Expression>,
        key_field: String,
        key: Box<Expression>,
    },
    Filter {
        source: Box<Expression>,
        predicate: Box<Expression>,
    },
    CheckCollection {
        source: Box<Expression>,
        key_field: String,
        dependencies_field: String,
    },
    Every {
        source: Box<Expression>,
        predicate: Box<Expression>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FieldExpression {
    pub key: String,
    pub value: Expression,
}
// The workflow source model mirrors sections 2.1–2.3 of the core specification.
// Expressions are source text here; the compiler resolves them to Expression.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Workflow {
    pub workflow: SymbolKey,
    pub input: TypeExpression,
    #[serde(default)]
    pub schemas: BTreeMap<String, TypeExpression>,
    pub run: Group,
    pub stages: BTreeMap<String, Stage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TypeExpression {
    Name(String),
    Record(BTreeMap<String, TypeExpression>),
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Group {
    #[serde(default)]
    #[serde(with = "crate::wire_numbers::word_map")]
    #[schemars(schema_with = "crate::wire_numbers::word_map::schema")]
    pub pools: BTreeMap<String, u32>,
    pub units: BTreeMap<String, Unit>,
    pub outcome: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Unit {
    pub stage: Option<SymbolKey>,
    pub group: Option<Box<Group>>,
    #[serde(default)]
    pub input: BTreeMap<String, String>,
    #[serde(default)]
    pub after: UnitDependencies,
    pub for_each: Option<String>,
    pub key: Option<String>,
    pub pool: Option<SymbolKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum UnitDependencies {
    #[default]
    None,
    Fixed(Vec<SymbolKey>),
    Each(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub input: TypeExpression,
    pub artifacts: BTreeMap<String, Artifact>,
    pub workers: BTreeMap<String, Worker>,
    #[serde(default)]
    pub reviews: BTreeMap<String, Review>,
    pub done_when: Option<String>,
    pub outcome: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub schema: TypeExpression,
    #[serde(default)]
    pub validate: Vec<ValidationCheck>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ValidationCheck {
    pub check: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Worker {
    Agent {
        prompts: BTreeMap<String, String>,
        inputs: BTreeMap<String, String>,
        creates: Vec<SymbolKey>,
        reviews: Option<SymbolKey>,
        runtime: Option<WorkerRuntime>,
        workspace: Option<String>,
        session: Option<SessionMode>,
        /// Optional guard: the worker is wanted only while it holds, and the
        /// artifacts it proves published type the worker's inputs.
        when: Option<String>,
    },
    Code {
        operation: SymbolKey,
        inputs: BTreeMap<String, String>,
        creates: Vec<SymbolKey>,
        every: Option<String>,
        when: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkerRuntime {
    pub harness: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Resume,
    Fresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub of: SymbolKey,
    pub by: ReviewBy,
    pub prompt: Option<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
    pub decisions: BTreeMap<String, ReviewDecision>,
    /// Optional for an operator review: it awaits a decision only while this
    /// holds. Required for an engine review: the engine decides when it holds.
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewBy {
    Operator,
    /// Decided by the engine, once per target revision, when `when` holds.
    Engine,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewDecision {
    pub effect: DecisionEffect,
    pub on: Option<SymbolKey>,
    pub label: String,
    pub payload: Option<TypeExpression>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// The fixed feedback an engine review's `request_changes` carries.
    pub feedback: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEffect {
    Approve,
    RequestChanges,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeOperation {
    pub key: SymbolKey,
    pub input_schema: TypeExpression,
    pub output_schema: TypeExpression,
    #[serde(default)]
    pub error_codes: Vec<String>,
}
