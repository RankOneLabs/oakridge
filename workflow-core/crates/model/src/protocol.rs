use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// Bumped whenever the request or response shape changes. v2: non-compile
/// operations address a cached bundle by `bundle_digest` instead of carrying
/// the source, `available_operations` is gone, and `compiled` returns the
/// digest and scope summaries rather than the checked program.
pub const PROTOCOL_VERSION: u32 = 2;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
// The 1 MiB cap changes only with a protocol version bump and regenerated TypeScript contracts.
pub const MAX_RESPONSE_BYTES: usize = MAX_FRAME_BYTES;
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
        bundle: DefinitionBundle,
    },
    ValidatePayload {
        bundle_digest: BundleDigest,
        schema: SchemaId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        payload: Value,
    },
    Evaluate {
        bundle_digest: BundleDigest,
        snapshot: Snapshot,
    },
    Materialize {
        bundle_digest: BundleDigest,
        snapshot: Snapshot,
        template: SymbolKey,
    },
    Explain {
        bundle_digest: BundleDigest,
        snapshot: Snapshot,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Output {
    Compiled(CompiledBundle),
    Validated(CheckedValue),
    Evaluated(DecisionOutcome),
    Materialized(Materialization),
    Explained(DecisionOutcome),
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CompiledBundle {
    pub digest: BundleDigest,
    pub scopes: Vec<CheckedScope>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TransportErrorKind {
    MalformedFrame,
    UnsupportedVersion,
    OversizedPayload,
    UnknownOperation,
    TerminatedChild,
    UnresponsiveChild,
    MismatchedRequestId,
    QueueFull,
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
