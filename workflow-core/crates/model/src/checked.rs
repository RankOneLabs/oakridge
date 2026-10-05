use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedProgram {
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub language_version: u32,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub evaluator_version: u32,
    pub digest: BundleDigest,
    pub source: DefinitionBundle,
    pub scopes: Vec<CheckedScope>,
    pub analysis: Vec<ScopeAnalysis>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScopeAnalysis {
    pub scope: ScopeKey,
    pub reachable_states: Vec<String>,
    pub actions: Vec<ActionSelection>,
    pub outcomes: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedScope {
    pub key: ScopeKey,
    pub initial: CheckedValue,
    pub tree: CheckedTree,
    pub children: Vec<CheckedChild>,
    pub command_targets: Vec<CheckedCommandTargets>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedCommandTargets {
    pub command: SymbolKey,
    pub targets: Vec<CheckedExpression>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedChild {
    pub key: SymbolKey,
    pub input: CheckedExpression,
    pub collection: Option<CheckedCollection>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedCollection {
    pub source: CheckedExpression,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub key_field: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub input_field: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub dependencies_field: usize,
    pub empty_outcome: Option<CheckedExpression>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedExpression {
    pub schema: SchemaId,
    pub node: CheckedExpressionNode,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedExpressionNode {
    Literal {
        value: CheckedValue,
    },
    Reference {
        root: ReferenceRoot,
        selectors: Vec<Selector>,
    },
    Record {
        fields: Vec<CheckedFieldExpression>,
    },
    List {
        items: Vec<CheckedExpression>,
    },
    Variant {
        variant: String,
        value: Box<CheckedExpression>,
    },
    Equals {
        left: Box<CheckedExpression>,
        right: Box<CheckedExpression>,
    },
    IsVariant {
        value: Box<CheckedExpression>,
        variant: String,
    },
    All {
        items: Vec<CheckedExpression>,
    },
    Any {
        items: Vec<CheckedExpression>,
    },
    Not {
        value: Box<CheckedExpression>,
    },
    Map {
        source: Box<CheckedExpression>,
        value: Box<CheckedExpression>,
    },
    Every {
        source: Box<CheckedExpression>,
        predicate: Box<CheckedExpression>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Selector {
    Field {
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        index: usize,
    },
    OptionalField {
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        index: usize,
        schema: SchemaId,
    },
    Optional,
    Variant {
        variant: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedFieldExpression {
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub field_id: usize,
    pub value: CheckedExpression,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedTree {
    Match {
        id: NodeId,
        value: CheckedExpression,
        cases: Vec<CheckedCase>,
        otherwise: Option<Box<CheckedTree>>,
    },
    If {
        id: NodeId,
        condition: CheckedExpression,
        then: Box<CheckedTree>,
        otherwise: Box<CheckedTree>,
    },
    Apply {
        id: NodeId,
        mutations: Vec<CheckedMutation>,
        actions: Vec<CheckedAction>,
        outcome: Option<CheckedExpression>,
    },
    Wait {
        id: NodeId,
        continuations: Vec<SymbolKey>,
        reason: String,
    },
    Reject {
        id: NodeId,
        error: SymbolKey,
        detail: CheckedValue,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedCase {
    pub variant: String,
    pub node: CheckedTree,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedAction {
    pub selection: ActionSelection,
    pub definition: InvocationContract,
    pub input: CheckedExpression,
    pub prompt_content: Option<String>,
}
/// Frozen provider boundary: no source expression or mutable prompt reference.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InvocationContract {
    pub operation: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub contract_version: u32,
    pub provider: String,
    pub input_schema: SchemaId,
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
impl From<&ActionDefinition> for InvocationContract {
    fn from(action: &ActionDefinition) -> Self {
        Self {
            operation: action.operation.clone(),
            contract_version: action.contract_version,
            provider: action.provider.clone(),
            input_schema: action.input_schema.clone(),
            settings: action.settings.clone(),
            tools: action.tools.clone(),
            outputs: action.outputs.clone(),
            deadline_ms: action.deadline_ms,
            max_attempts: action.max_attempts,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedMutation {
    SetState {
        value: CheckedExpression,
    },
    Export {
        key: SymbolKey,
        value: CheckedExpression,
    },
    ActivateChild {
        key: SymbolKey,
    },
    Acquire {
        pool: SymbolKey,
    },
    Release {
        pool: SymbolKey,
    },
    Revoke {
        worker: WorkerKey,
    },
    Stop {
        worker: WorkerKey,
    },
    Observe {
        resource: SymbolKey,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MutationValue {
    SetState {
        value: CheckedValue,
    },
    Export {
        key: SymbolKey,
        value: CheckedValue,
    },
    ActivateChild {
        key: SymbolKey,
        input: CheckedValue,
    },
    ActivateCollection {
        key: SymbolKey,
        materialization: Materialization,
    },
    Acquire {
        pool: SymbolKey,
    },
    Release {
        pool: SymbolKey,
    },
    Revoke {
        worker: WorkerKey,
    },
    Stop {
        worker: WorkerKey,
    },
    Observe {
        resource: SymbolKey,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub selection: ActionSelection,
    pub definition: InvocationContract,
    pub input: CheckedValue,
    pub prompt_content: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Explanation {
    pub bundle_digest: BundleDigest,
    pub owner: InstanceId,
    pub node_id: NodeId,
    pub trigger_id: TriggerId,
    pub read_set: Vec<ReadVersion>,
    pub trace: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DecisionOutcome {
    Apply {
        explanation: Explanation,
        mutations: Vec<MutationValue>,
        invocations: Vec<Invocation>,
        outcome: Option<CheckedValue>,
        targets: Vec<CheckedValue>,
    },
    Wait {
        explanation: Explanation,
        continuations: Vec<SymbolKey>,
        reason: String,
    },
    Reject {
        explanation: Explanation,
        error: SymbolKey,
        detail: CheckedValue,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MaterializedChild {
    pub key: String,
    pub scope: ScopeKey,
    pub input: CheckedValue,
    pub depends_on: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Materialization {
    pub children: Vec<MaterializedChild>,
    pub empty_outcome: Option<CheckedValue>,
}
