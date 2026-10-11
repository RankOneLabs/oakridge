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
    pub derived: CheckedDefinition,
    pub scopes: Vec<CheckedScope>,
    pub analysis: Vec<ScopeAnalysis>,
}
/// Only the resolved data required by the evaluator; authored prompts and operation
/// manifests stay in the pinned source bundle outside the checked program.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedDefinition {
    pub schemas: Vec<Schema>,
    pub scopes: Vec<ScopeDefinition>,
    pub limits: ResourceLimits,
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
    pub reads: Vec<ReferenceRoot>,
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
    pub key: Option<CheckedExpression>,
    pub after: Option<CheckedExpression>,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub key_field: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub input_field: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub dependencies_field: usize,
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
    Len { value: Box<CheckedExpression> },
    GreaterThan { left: Box<CheckedExpression>, right: Box<CheckedExpression> },
    GreaterOrEqual { left: Box<CheckedExpression>, right: Box<CheckedExpression> },
    LessThan { left: Box<CheckedExpression>, right: Box<CheckedExpression> },
    LessOrEqual { left: Box<CheckedExpression>, right: Box<CheckedExpression> },
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
    Optional {
        value: Option<Box<CheckedExpression>>,
    },
    Field {
        value: Box<CheckedExpression>,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        index: usize,
    },
    FilterBy {
        source: Box<CheckedExpression>,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        key_field: usize,
        key: Box<CheckedExpression>,
    },
    Contains {
        source: Box<CheckedExpression>,
        value: Box<CheckedExpression>,
    },
    Lookup {
        source: Box<CheckedExpression>,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        key_field: usize,
        key: Box<CheckedExpression>,
    },
    Filter {
        source: Box<CheckedExpression>,
        predicate: Box<CheckedExpression>,
    },
    UniqueBy {
        source: Box<CheckedExpression>,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        key_field: usize,
    },
    CheckCollection {
        source: Box<CheckedExpression>,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        key_field: usize,
        #[serde(with = "crate::wire_numbers::index")]
        #[schemars(schema_with = "crate::wire_numbers::index::schema")]
        dependencies_field: usize,
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
        attention: AttentionMetadata,
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
    pub prompt_key: Option<SymbolKey>,
}
/// Frozen provider boundary: no source expression or mutable prompt reference.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InvocationContract {
    pub operation: SymbolKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub contract_version: u32,
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
    CancelChildren {
        key: SymbolKey,
    },
    ClearOutput {
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
    BindResource {
        key: SymbolKey,
        value: CheckedExpression,
    },
    ClearResource {
        key: SymbolKey,
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
    CancelChildren {
        key: SymbolKey,
    },
    ClearOutput {
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
    BindResource {
        key: SymbolKey,
        value: CheckedValue,
    },
    ClearResource {
        key: SymbolKey,
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
    pub prompt_key: Option<SymbolKey>,
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
        attention: Option<AttentionMetadata>,
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
}

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
    pub source: CheckedExpression,
    pub key: CheckedExpression,
    pub after: CheckedExpression,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedStage {
    pub key: SymbolKey,
    pub workers: Vec<CheckedWorker>,
    pub done_when: CheckedExpression,
    pub outcome: Vec<CheckedNamedExpression>,
    pub validations: Vec<CheckedArtifactValidation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedWorker {
    pub key: WorkerKey,
    pub inputs: Vec<CheckedNamedExpression>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedNamedExpression {
    pub key: String,
    pub value: CheckedExpression,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedArtifactValidation {
    pub artifact: SymbolKey,
    pub checks: Vec<CheckedExpression>,
}
