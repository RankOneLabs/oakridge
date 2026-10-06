use std::collections::VecDeque;
use workflow_compiler::{check_value, compile_with_host, decode_bundle, decode_unique_json};
use workflow_evaluator::{evaluate, materialize};
use workflow_model::protocol::{
    Operation, Output, Request, Response, ResponseResult, TransportError, TransportErrorKind,
    MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};
use workflow_model::{BundleDigest, CheckedProgram, DomainError, DomainErrorKind, ResourceLimits};

pub const MAX_CACHED_PROGRAMS: usize = 32;
pub fn request_id_prefix(frame: &[u8]) -> String {
    let text = String::from_utf8_lossy(frame);
    let Some(position) = text.find("\"request_id\"") else {
        return String::new();
    };
    let remainder = text[position + "\"request_id\"".len()..].trim_start();
    let Some(remainder) = remainder.strip_prefix(':') else {
        return String::new();
    };
    let remainder = remainder.trim_start();
    let Some(remainder) = remainder.strip_prefix('"') else {
        return String::new();
    };
    let Some(end) = remainder.find('"') else {
        return String::new();
    };
    let id = &remainder[..end];
    if id.len() <= 128 && !id.contains('\\') {
        id.to_owned()
    } else {
        String::new()
    }
}
pub struct CliState {
    host: ResourceLimits,
    programs: VecDeque<CheckedProgram>,
}
impl CliState {
    pub fn new(host: ResourceLimits) -> Self {
        Self {
            host,
            programs: VecDeque::new(),
        }
    }
    fn find(&mut self, digest: &BundleDigest) -> Option<&CheckedProgram> {
        let position = self
            .programs
            .iter()
            .position(|program| &program.digest == digest)?;
        let program = self.programs.remove(position)?;
        self.programs.push_front(program);
        self.programs.front()
    }
    fn insert(&mut self, program: CheckedProgram) {
        self.programs
            .retain(|cached| cached.digest != program.digest);
        self.programs.push_front(program);
        self.programs.truncate(MAX_CACHED_PROGRAMS);
    }
}

fn transport(request_id: String, kind: TransportErrorKind, detail: &str) -> Response {
    Response {
        version: PROTOCOL_VERSION,
        request_id,
        truncated: false,
        result: ResponseResult::TransportError(TransportError {
            kind,
            detail: detail.into(),
        }),
    }
}

pub fn handle_frame(state: &mut CliState, frame: &[u8]) -> Response {
    if frame.len() > MAX_FRAME_BYTES {
        let request_id = serde_json::from_slice::<serde_json::Value>(frame)
            .ok()
            .and_then(|value| {
                value
                    .get("request_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        return transport(
            request_id,
            TransportErrorKind::OversizedPayload,
            "frame exceeds maximum bytes",
        );
    }
    let raw: serde_json::Value = match decode_unique_json(frame) {
        Ok(value) => value,
        Err(error) if error.kind == workflow_model::DomainErrorKind::DuplicateSymbol => {
            return Response {
                version: PROTOCOL_VERSION,
                // Only recover correlation metadata; overwritten source is never compiled.
                request_id: serde_json::from_slice::<serde_json::Value>(frame)
                    .ok()
                    .and_then(|raw| {
                        raw.get("request_id")
                            .and_then(serde_json::Value::as_str)
                            .filter(|id| !id.is_empty() && id.len() <= 128)
                            .map(str::to_owned)
                    })
                    .unwrap_or_default(),
                truncated: false,
                result: ResponseResult::DomainError(error),
            };
        }
        Err(error) => {
            return transport(
                String::new(),
                TransportErrorKind::MalformedFrame,
                &error.detail,
            )
        }
    };
    let request_id = raw
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let version = raw.get("version").and_then(serde_json::Value::as_u64);
    if request_id.len() > 128 {
        return transport(
            String::new(),
            TransportErrorKind::MalformedFrame,
            "request ID exceeds 128 bytes",
        );
    }
    if request_id.is_empty() {
        return transport(
            request_id,
            TransportErrorKind::MalformedFrame,
            "request ID required",
        );
    }
    if version.is_none() {
        return transport(
            request_id,
            TransportErrorKind::MalformedFrame,
            "version must be an integer",
        );
    }
    if version != Some(u64::from(PROTOCOL_VERSION)) {
        return transport(
            request_id,
            TransportErrorKind::UnsupportedVersion,
            "unsupported protocol version",
        );
    }
    let operation = raw
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if ![
        "compile",
        "validate_payload",
        "evaluate",
        "materialize",
        "explain",
    ]
    .contains(&operation)
    {
        return transport(
            request_id,
            TransportErrorKind::UnknownOperation,
            "unknown operation",
        );
    }
    if let Some(source) = raw.get("input").and_then(|input| input.get("bundle")) {
        let source_bytes = serde_json::to_vec(source).unwrap_or_default();
        if let Err(error) = decode_bundle(&source_bytes) {
            return Response {
                version: PROTOCOL_VERSION,
                request_id,
                truncated: false,
                result: ResponseResult::DomainError(error),
            };
        }
    }
    let request: Request = match serde_json::from_value(raw) {
        Ok(value) => value,
        Err(error) => {
            return transport(
                request_id,
                TransportErrorKind::MalformedFrame,
                &error.to_string(),
            )
        }
    };
    let unknown = |digest: &BundleDigest| {
        DomainError::new(
            DomainErrorKind::UnknownBundle,
            digest.to_string(),
            "bundle digest is not cached",
        )
    };
    let result = match request.operation {
        Operation::Compile { bundle } => compile_with_host(&bundle, &state.host).map(|program| {
            let output = workflow_model::protocol::CompiledBundle {
                digest: program.digest.clone(),
                scopes: program.scopes.clone(),
            };
            state.insert(program);
            Output::Compiled(output)
        }),
        Operation::ValidatePayload {
            bundle_digest,
            schema,
            payload,
        } => state
            .find(&bundle_digest)
            .ok_or_else(|| unknown(&bundle_digest))
            .and_then(|program| check_value(&program.derived, &schema, &payload))
            .map(Output::Validated),
        Operation::Evaluate {
            bundle_digest,
            snapshot,
        } => state
            .find(&bundle_digest)
            .ok_or_else(|| unknown(&bundle_digest))
            .and_then(|program| evaluate(program, &snapshot))
            .map(Output::Evaluated),
        Operation::Materialize {
            bundle_digest,
            snapshot,
            template,
        } => state
            .find(&bundle_digest)
            .ok_or_else(|| unknown(&bundle_digest))
            .and_then(|program| materialize(program, &snapshot, &template))
            .map(Output::Materialized),
        Operation::Explain {
            bundle_digest,
            snapshot,
        } => state
            .find(&bundle_digest)
            .ok_or_else(|| unknown(&bundle_digest))
            .and_then(|program| evaluate(program, &snapshot))
            .map(Output::Explained),
    };
    Response {
        version: PROTOCOL_VERSION,
        request_id: request.request_id,
        truncated: false,
        result: match result {
            Ok(output) => ResponseResult::Ok(output),
            Err(error) => ResponseResult::DomainError(error),
        },
    }
}

pub fn bounded_response(mut response: Response) -> Vec<u8> {
    let mut serialized = match serde_json::to_vec(&response) {
        Ok(bytes) => bytes,
        Err(error) => {
            response = transport(
                response.request_id,
                TransportErrorKind::MalformedFrame,
                &error.to_string(),
            );
            serde_json::to_vec(&response).expect("transport response is serializable")
        }
    };
    if serialized.len() > MAX_RESPONSE_BYTES {
        response.truncated = true;
        response.result = ResponseResult::TransportError(TransportError {
            kind: TransportErrorKind::OversizedPayload,
            detail: "response exceeded maximum bytes".into(),
        });
        serialized = serde_json::to_vec(&response).unwrap_or_default();
    }
    serialized.push(b'\n');
    serialized
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_wide_integer_response_is_a_transport_error_not_an_empty_frame() {
        let bytes = bounded_response(Response {
            version: 1,
            request_id: "wide".into(),
            truncated: false,
            result: ResponseResult::Ok(Output::Validated(workflow_model::CheckedValue {
                schema: "number".into(),
                data: workflow_model::CheckedData::Integer { value: i64::MAX },
            })),
        });
        let response: Response = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(response.request_id, "wide");
        assert!(matches!(
            response.result,
            ResponseResult::TransportError(TransportError {
                kind: TransportErrorKind::MalformedFrame,
                ..
            })
        ));
    }
    #[test]
    fn transport_failures_are_distinct() {
        let mut state = CliState::new(ResourceLimits {
            max_list_items: 10_000,
            max_depth: 128,
            evaluation_budget: 1_000_000,
        });
        let malformed = handle_frame(&mut state, b"{");
        let version = handle_frame(
            &mut state,
            br#"{"version":2,"request_id":"r","operation":"compile"}"#,
        );
        let unknown = handle_frame(
            &mut state,
            br#"{"version":1,"request_id":"r","operation":"other"}"#,
        );
        assert!(matches!(
            malformed.result,
            ResponseResult::TransportError(TransportError {
                kind: TransportErrorKind::MalformedFrame,
                ..
            })
        ));
        assert!(matches!(
            version.result,
            ResponseResult::TransportError(TransportError {
                kind: TransportErrorKind::UnsupportedVersion,
                ..
            })
        ));
        assert!(matches!(
            unknown.result,
            ResponseResult::TransportError(TransportError {
                kind: TransportErrorKind::UnknownOperation,
                ..
            })
        ));
    }
}
