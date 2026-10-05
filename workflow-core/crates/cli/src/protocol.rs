use workflow_compiler::{compile, validate_payload};
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
    let raw: serde_json::Value = match serde_json::from_slice(frame) {
        Ok(value) => value,
        Err(error) => {
            return transport(
                String::new(),
                TransportErrorKind::MalformedFrame,
                &error.to_string(),
            )
        }
    };
    let request_id = raw
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let version = raw.get("version").and_then(serde_json::Value::as_u64);
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
        Operation::Compile { bundle } => compile(&bundle).map(|program| Output::Compiled {
            bundle_id: bundle.id.clone(),
            scope_order: program.scope_order,
        }),
        Operation::ValidatePayload {
            bundle,
            collection,
            payload,
        } => compile(&bundle)
            .and_then(|_| validate_payload(&bundle, &collection, &payload))
            .map(|()| Output::Validated { collection }),
        Operation::Evaluate { bundle, snapshot } => {
            evaluate(&bundle, &snapshot).map(Output::Evaluated)
        }
        Operation::Materialize {
            bundle,
            collection,
            observations,
        } => {
            materialize(&bundle, &collection, &observations).map(|item_ids| Output::Materialized {
                collection,
                item_ids,
            })
        }
        Operation::Explain { bundle, snapshot } => {
            evaluate(&bundle, &snapshot).map(|outcome| Output::Explained {
                trace: outcome.trace,
            })
        }
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
