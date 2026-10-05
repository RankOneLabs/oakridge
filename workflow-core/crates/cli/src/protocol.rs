use workflow_compiler::{check_value, compile, decode_bundle, decode_unique_json};
use workflow_evaluator::{evaluate, materialize};
use workflow_model::protocol::{
    Operation, Output, Request, Response, ResponseResult, TransportError, TransportErrorKind,
    MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};

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

pub fn handle_frame(frame: &[u8]) -> Response {
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
    let result = match request.operation {
        Operation::Compile {
            bundle,
            available_operations,
        } => compile(&bundle, &available_operations).map(Output::Compiled),
        Operation::ValidatePayload {
            bundle,
            available_operations,
            schema,
            payload,
        } => compile(&bundle, &available_operations)
            .and_then(|program| check_value(&program.source, &schema, &payload))
            .map(Output::Validated),
        Operation::Evaluate {
            bundle,
            available_operations,
            snapshot,
        } => compile(&bundle, &available_operations)
            .and_then(|program| evaluate(&program, &snapshot))
            .map(Output::Evaluated),
        Operation::Materialize {
            bundle,
            available_operations,
            snapshot,
            template,
        } => compile(&bundle, &available_operations)
            .and_then(|program| materialize(&program, &snapshot, &template))
            .map(Output::Materialized),
        Operation::Explain {
            bundle,
            available_operations,
            snapshot,
        } => compile(&bundle, &available_operations)
            .and_then(|program| evaluate(&program, &snapshot))
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
    let mut serialized = serde_json::to_vec(&response).unwrap_or_default();
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
    fn transport_failures_are_distinct() {
        let malformed = handle_frame(b"{");
        let version = handle_frame(br#"{"version":2,"request_id":"r","operation":"compile"}"#);
        let unknown = handle_frame(br#"{"version":1,"request_id":"r","operation":"other"}"#);
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
