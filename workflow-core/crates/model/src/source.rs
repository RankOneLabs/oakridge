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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReferenceRoot {
    Input,
    State,
    Trigger,
    Output {
        key: SymbolKey,
    },
    Result {
        worker: WorkerKey,
    },
    Resource {
        key: SymbolKey,
    },
    Child {
        key: SymbolKey,
        export: SymbolKey,
    },
    OutputCollection {
        key: SymbolKey,
        schema: SchemaId,
    },
    OutputRevision {
        key: SymbolKey,
        schema: SchemaId,
    },
    OutputRevisions {
        key: SymbolKey,
        schema: SchemaId,
    },
    OptionalOutputRevision {
        key: SymbolKey,
        schema: SchemaId,
    },
    Children {
        key: SymbolKey,
        export: SymbolKey,
        schema: SchemaId,
    },
    ChildrenOutcomes {
        key: SymbolKey,
        schema: SchemaId,
    },
    ChildrenComplete {
        key: SymbolKey,
        schema: SchemaId,
    },
    Item, // lexically bound by finite list transforms
    // The §2.2 stage scope. The compiler resolves stage expression text to
    // these roots so nothing re-parses the source at evaluation time.
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
        schema: SchemaId,
        fields: Vec<FieldExpression>,
    },
    List {
        schema: SchemaId,
        items: Vec<Expression>,
    },
    Variant {
        schema: SchemaId,
        variant: String,
        value: Box<Expression>,
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
    IsVariant {
        value: Box<Expression>,
        variant: String,
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
        schema: SchemaId,
        value: Box<Expression>,
    },
    Optional {
        schema: SchemaId,
        value: Option<Box<Expression>>,
    },
    Field {
        value: Box<Expression>,
        key: String,
    },
    FilterBy {
        source: Box<Expression>,
        key_field: String,
        key: Box<Expression>,
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
    UniqueBy {
        source: Box<Expression>,
        key_field: String,
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
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DecisionTree {
    Match {
        id: NodeId,
        value: Expression,
        cases: Vec<MatchCase>,
        otherwise: Option<Box<DecisionTree>>,
    },
    If {
        id: NodeId,
        condition: Expression,
        then: Box<DecisionTree>,
        otherwise: Box<DecisionTree>,
    },
    Apply {
        id: NodeId,
        mutations: Vec<Mutation>,
        actions: Vec<ActionSelection>,
        outcome: Option<Expression>,
    },
    Wait {
        id: NodeId,
        continuations: Vec<SymbolKey>,
        reason: String,
        attention: AttentionMetadata,
    },
    Reject {
        id: NodeId,
        error: SymbolKey,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        detail: Value,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttentionMetadata {
    pub label: String,
    pub trigger: SymbolKey,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MatchCase {
    pub variant: String,
    pub node: DecisionTree,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    SetState { value: Expression },
    Export { key: SymbolKey, value: Expression },
    ActivateChild { key: SymbolKey },
    CancelChildren { key: SymbolKey },
    ClearOutput { key: SymbolKey },
    Acquire { pool: SymbolKey },
    Release { pool: SymbolKey },
    Revoke { worker: WorkerKey },
    Stop { worker: WorkerKey },
    BindResource { key: SymbolKey, value: Expression },
    ClearResource { key: SymbolKey },
    Observe { resource: SymbolKey },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActionSelection {
    pub worker: WorkerKey,
    pub action: ActionKey,
}

// The v2 authoring model mirrors sections 2.1–2.3 of the core specification.
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
    },
    Code {
        operation: SymbolKey,
        inputs: BTreeMap<String, String>,
        creates: Vec<SymbolKey>,
        every: Option<String>,
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
    pub inputs: BTreeMap<String, String>,
    pub decisions: BTreeMap<String, ReviewDecision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewBy {
    Operator,
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
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub version: u32,
    pub input_schema: TypeExpression,
    pub output_schema: TypeExpression,
    #[serde(default)]
    pub error_codes: Vec<String>,
}
