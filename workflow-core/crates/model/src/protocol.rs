use crate::{DecisionOutcome, DefinitionBundle, DomainError, Observation, Snapshot};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_RESPONSE_BYTES: usize = 262_144;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    #[serde(flatten)]
    pub operation: Operation,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "operation", content = "input", rename_all = "snake_case")]
pub enum Operation {
    Compile {
        bundle: DefinitionBundle,
    },
    ValidatePayload {
        bundle: DefinitionBundle,
        collection: String,
        payload: Value,
    },
    Evaluate {
        bundle: DefinitionBundle,
        snapshot: Snapshot,
    },
    Materialize {
        bundle: DefinitionBundle,
        collection: String,
        observations: Vec<Observation>,
    },
    Explain {
        bundle: DefinitionBundle,
        snapshot: Snapshot,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Output {
    Compiled {
        bundle_id: String,
        scope_order: Vec<String>,
    },
    Validated {
        collection: String,
    },
    Evaluated(DecisionOutcome),
    Materialized {
        collection: String,
        item_ids: Vec<String>,
    },
    Explained {
        trace: Vec<String>,
    },
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
    pub version: u32,
    pub request_id: String,
    pub truncated: bool,
    pub result: ResponseResult,
}
