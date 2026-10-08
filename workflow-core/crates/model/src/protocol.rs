use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// Bumped whenever the request or response shape changes. v2: non-compile
/// operations address a cached bundle by `bundle_digest` instead of carrying
/// the source, `available_operations` is gone, and `compiled` returns the
/// digest and scope summaries rather than the checked program. v3: the frame
/// cap rose from 1 MiB to 64 MiB. v4: `DecisionOutcome::Wait` carries
/// `targets`, populated when the decision collapsed from an evaluated apply.
pub const PROTOCOL_VERSION: u32 = 4;
/// Guards the line reader, not the domain: a scope's whole snapshot travels in
/// one evaluate frame, so this cap must sit far above any legitimate state.
/// It changes only with a protocol version bump and regenerated TypeScript contracts.
pub const MAX_FRAME_BYTES: usize = 64 * 1_048_576;
pub const MAX_RESPONSE_BYTES: usize = MAX_FRAME_BYTES;

/// Deepest container nesting the Rust reader accepts: serde_json refuses more
/// than 127 nested arrays/objects (its fixed recursion guard, which protects the
/// stack). Every request frame has to fit, so every bundle and value the
/// compiler and evaluator accept has to fit with its envelope.
pub const WIRE_MAX_JSON_DEPTH: usize = 127;
/// JSON containers one `max_depth` unit can cost on the wire. A nested
/// `CheckedValue` is the worst: `{schema, data:{kind:"record", fields:[{field_id,
/// value:<next>}]}}` is value, data, fields array and field entry: four per
/// schema level (a list, dictionary or variant level costs three or fewer).
/// Source trees and expressions cost at most three per node (`match` ->
/// `cases` -> case -> `node`; `apply` -> `mutations` -> mutation -> `value`).
pub const JSON_CONTAINERS_PER_DEPTH_UNIT: usize = 4;
/// Containers a depth-limited path can add beyond four per unit: the deepest
/// source path is a worker action `input` (frame, `input`, `bundle`, `scopes`,
/// scope, `workers`, worker, `actions`, action, then expression 0 at container
/// 10) whose last node is a literal carrying `max_depth + 1` more nested
/// containers. 10 + 3 * max_depth + (max_depth + 1) = 4 * max_depth + 11.
/// The deepest value slot, `observations[0].value`, needs 4 * max_depth + 7.
pub const WIRE_ENVELOPE_CONTAINERS: usize = 11;
/// The `max_depth` a bundle may declare. Chosen so the worst case above fits the
/// wire with four containers to spare: 4 * 28 + 11 = 123 <= 127. At 30 it would
/// be 131, so a legal bundle or value could be refused as a malformed frame
/// rather than a domain error. Lowering it is a compatible change; raising it
/// requires the wire reader's depth budget to be raised first.
pub const MAX_DEPTH_CEILING: usize = 28;
const _: () = assert!(
    JSON_CONTAINERS_PER_DEPTH_UNIT * MAX_DEPTH_CEILING + WIRE_ENVELOPE_CONTAINERS
        <= WIRE_MAX_JSON_DEPTH
);

/// Generated TypeScript decoders confine arbitrary JSON to one boundary and
/// recurse over it. Responses can nest deeper than requests (a checked
/// expression wraps each node in `{schema, node}`; measured up to 1.5x), so the
/// guard sits at twice the wire depth, and counts at most four schema hops
/// ($ref, oneOf member, property, items) per container. These are runaway
/// guards sized above anything the Rust side can emit, not domain limits.
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
        bundle: DefinitionBundle,
        catalog: ProviderCatalog,
    },
    ValidatePayload {
        bundle_digest: BundleDigest,
        schema: SchemaId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        payload: Value,
    },
    /// Recheck a value that arrived already checked, such as a published output.
    ValidateValue {
        bundle_digest: BundleDigest,
        schema: SchemaId,
        value: CheckedValue,
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
