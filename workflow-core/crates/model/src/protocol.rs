use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
/// Bumped whenever the request or response shape changes. v5 carries each
/// wanted worker's identity and resolved inputs in one step response entry.
pub const PROTOCOL_VERSION: u32 = 5;

/// One wanted worker and the identity of the attempt that runs it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WantedWorker {
    pub unit: UnitId,
    pub worker: WorkerKey,
    pub action_id: ActionKey,
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub attempt_seq: u32,
    pub action: Action,
    pub resolved: ResolvedRunWorker,
}

/// Deepest container nesting serde_json accepts.
pub const WIRE_MAX_JSON_DEPTH: usize = 127;
/// Containers the frame wraps around the deepest JSON value slot. Values are
/// plain JSON, one container per `max_depth` unit. The deepest slot is a
/// response's snapshot unit `outcome`: frame, `result`, `value` (the output),
/// `value` (the step result), `snapshot`, `units`, the unit, then its
/// `status`: 8. Requests are shallower: a step's snapshot outcome is at 6,
/// and a compile's workflow source at 2.
pub const WIRE_ENVELOPE_CONTAINERS: usize = 8;
/// The `max_depth` a workflow's values may reach. Any value at this depth fits
/// the wire with room to spare (28 + 8 = 36 <= 127), so a legal value is
/// refused as a domain error, never as a malformed frame. Raising it past
/// `WIRE_MAX_JSON_DEPTH - WIRE_ENVELOPE_CONTAINERS` requires the JSON reader's
/// depth budget to be raised first.
pub const MAX_DEPTH_CEILING: usize = 28;
const _: () = assert!(MAX_DEPTH_CEILING + WIRE_ENVELOPE_CONTAINERS <= WIRE_MAX_JSON_DEPTH);

/// Generated TypeScript decoders confine arbitrary JSON to one boundary and
/// recurse over it, counting at most four schema hops ($ref, oneOf member,
/// property, items) per container. No response nests deeper than the wire
/// allows, so these are runaway guards at twice the wire depth, not domain
/// limits.
pub const DECODER_MAX_JSON_DEPTH: usize = 2 * WIRE_MAX_JSON_DEPTH + 2;
pub const DECODER_MAX_SCHEMA_HOPS: usize = 4 * DECODER_MAX_JSON_DEPTH;
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub version: u32,
    pub request_id: String,
    #[serde(flatten)]
    pub operation: Operation,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "operation",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Operation {
    Compile {
        workflow: Box<Workflow>,
        #[serde(default)]
        operations: Vec<CodeOperation>,
        #[serde(default)]
        prompts: std::collections::BTreeMap<String, String>,
    },
    /// One event against the affected unit and its ancestors.
    Step {
        workflow_digest: BundleDigest,
        snapshot: Box<StepSnapshot>,
        incoming: Incoming,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Output {
    Compiled(CompiledWorkflow),
    Stepped(Box<StepResult>),
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CompiledWorkflow {
    pub digest: BundleDigest,
    pub stages: Vec<SymbolKey>,
    /// The parsed source returned with its tagged types for read projections.
    pub workflow: Box<Workflow>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TransportErrorKind {
    MalformedRequest,
    UnsupportedVersion,
    OversizedPayload,
    UnknownOperation,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TransportError {
    pub kind: TransportErrorKind,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum ResponseResult {
    Ok(Output),
    DomainError(DomainError),
    TransportError(TransportError),
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Response {
    #[serde(with = "crate::wire_numbers::word")]
    #[schemars(schema_with = "crate::wire_numbers::word::schema")]
    pub version: u32,
    pub request_id: String,
    pub truncated: bool,
    pub result: ResponseResult,
}
