use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefinitionBundle {
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub language_version: u32,
    pub key: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub version: u32,
    pub root: ScopeKey,
    pub schemas: Vec<Schema>,
    pub scopes: Vec<ScopeDefinition>,
    pub prompts: Vec<Prompt>,
    pub operations: Vec<OperationManifest>,
    pub limits: ResourceLimits,
}
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
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    pub key: SchemaId,
    pub shape: SchemaShape,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SchemaShape {
    Boolean,
    Integer {
        #[serde(with = "crate::wire_numbers::signed")]
        #[schemars(schema_with = "crate::wire_numbers::signed::schema")]
        min: i64,
        #[serde(with = "crate::wire_numbers::signed")]
        #[schemars(schema_with = "crate::wire_numbers::signed::schema")]
        max: i64,
    },
    String {
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        min_length: usize,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        max_length: usize,
    },
    Enum {
        variants: Vec<String>,
    },
    Record {
        fields: Vec<SchemaField>,
        dictionary: Option<SchemaId>,
    },
    List {
        item: SchemaId,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        max_items: usize,
    },
    Optional {
        item: SchemaId,
    },
    Union {
        variants: Vec<SchemaVariant>,
    },
    Reference {
        brand: ReferenceBrand,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SchemaField {
    pub key: String,
    pub schema: SchemaId,
    pub required: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SchemaVariant {
    pub key: String,
    pub schema: SchemaId,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceBrand {
    Instance,
    Execution,
    ArtifactRevision,
    Resource,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Prompt {
    pub key: SymbolKey,
    pub path: String,
    pub input_schema: SchemaId,
    pub content_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationManifest {
    pub key: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub version: u32,
    pub input_schema: SchemaId,
    pub provider_kind: String,
    pub input_contract: String,
    pub settings: Vec<String>,
    pub tools: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScopeDefinition {
    pub key: ScopeKey,
    pub input_schema: SchemaId,
    pub state_schema: SchemaId,
    #[serde(with = "crate::wire_numbers::json")]
    #[schemars(with = "Value")]
    pub initial: Value,
    pub outcome_schema: SchemaId,
    pub errors: Vec<FactDefinition>,
    pub commands: Vec<CommandDefinition>,
    pub facts: Vec<FactDefinition>,
    pub outputs: Vec<OutputDefinition>,
    pub workers: Vec<WorkerDefinition>,
    pub children: Vec<ChildDefinition>,
    pub exports: Vec<ExportDefinition>,
    pub resources: Vec<ExportDefinition>,
    pub pools: Vec<CapacityPool>,
    pub cancellation: CancellationDefinition,
    pub presentation: Presentation,
    pub tree: DecisionTree,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_command: Option<SymbolKey>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CommandDefinition {
    pub key: SymbolKey,
    pub payload_schema: SchemaId,
    pub available_in: Vec<String>,
    pub required: bool,
    pub targets: Vec<Expression>,
    pub label: String,
    pub consequence: String,
    pub field_presentation: Vec<CommandFieldPresentation>,
}
/// Presentation for a named, top-level command payload record field.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CommandFieldPresentation {
    pub key: String,
    pub presentation: Presentation,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FactDefinition {
    pub key: SymbolKey,
    pub payload_schema: SchemaId,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExportDefinition {
    pub key: SymbolKey,
    pub schema: SchemaId,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OutputDefinition {
    pub key: SymbolKey,
    pub schema: SchemaId,
    pub policy: PublicationPolicy,
    pub producers: Vec<WorkerKey>,
    pub collection_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_trigger: Option<SymbolKey>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicationPolicy {
    AppendRevision,
    ReplaceArtifact,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkerDefinition {
    pub key: WorkerKey,
    pub result_schema: SchemaId,
    pub exclusive: bool,
    pub actions: Vec<ActionDefinition>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActionDefinition {
    pub key: ActionKey,
    pub operation: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub contract_version: u32,
    pub input_schema: SchemaId,
    pub input: Expression,
    pub prompt: Option<SymbolKey>,
    pub settings: Vec<InvocationSetting>,
    pub tools: Vec<String>,
    pub outputs: Vec<SymbolKey>,
    #[serde(with = "crate::wire_numbers::unsigned")]
    #[schemars(schema_with = "crate::wire_numbers::unsigned::schema")]
    pub deadline_ms: u64,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub max_attempts: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InvocationSetting {
    pub key: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChildDefinition {
    pub key: SymbolKey,
    pub scope: ScopeKey,
    pub input: Expression,
    pub depends_on: Vec<SymbolKey>,
    pub imports: Vec<SymbolKey>,
    pub collection: Option<CollectionDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_terminal: Option<SymbolKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerequisite_export: Option<SymbolKey>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CollectionDefinition {
    pub source: Expression,
    pub key_field: String,
    pub input_field: String,
    pub dependencies_field: String,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub min_items: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub max_items: usize,
    pub empty: EmptyPolicy,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EmptyPolicy {
    Reject,
    Complete { outcome: Expression },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapacityPool {
    pub key: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub limit: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CancellationDefinition {
    pub trigger: SymbolKey,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Presentation {
    pub label: String,
    pub viewer: Option<String>,
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
