use std::collections::VecDeque;
use workflow_compiler::{check_value, compile_with_host, decode_bundle, decode_unique_json};
use workflow_evaluator::{evaluate, materialize};
use workflow_model::protocol::{
    Operation, Output, Request, Response, ResponseResult, TransportError, TransportErrorKind,
    MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};
use workflow_model::{BundleDigest, CheckedProgram, DomainError, DomainErrorKind, ResourceLimits};

pub const MAX_CACHED_PROGRAMS: usize = 32;
pub const MAX_REQUEST_ID_BYTES: usize = 128;

/// Recover the root object's `request_id` from a frame that cannot be parsed
/// whole — oversized, or cut off before its newline — so the transport error
/// can still be correlated.
///
/// One bounded pass over the bytes. Object and array nesting is tracked so a
/// `request_id` member inside `input` is never mistaken for the root one, and
/// string tokens are skipped escape-aware so braces inside strings do not
/// disturb the depth. The matched value is decoded as a JSON string, so an
/// escaped ID such as `"r\u002d1"` comes back as `r-1`. Returns an empty
/// string when the root ID is absent, malformed, or beyond the retained bytes.
pub fn request_id_prefix(frame: &[u8]) -> String {
    let mut depth = 0usize;
    // At depth 1, the next string token is a member key (we just passed `{` or `,`).
    let mut key_next = false;
    let mut index = 0;
    while index < frame.len() {
        match frame[index] {
            b'"' => {
                let Some(end) = string_end(frame, index) else {
                    break;
                };
                if depth == 1 && key_next && &frame[index + 1..end] == b"request_id" {
                    return member_string_value(&frame[end + 1..]).unwrap_or_default();
                }
                key_next = false;
                index = end + 1;
            }
            byte @ (b'{' | b'[') => {
                depth += 1;
                key_next = depth == 1 && byte == b'{';
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                key_next = false;
                index += 1;
            }
            b',' => {
                key_next = depth == 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    String::new()
}

/// Index of the closing quote of the string token opening at `start`, or None
/// when the frame ends inside it.
fn string_end(frame: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < frame.len() {
        match frame[index] {
            b'\\' => index += 2,
            b'"' => return Some(index),
            _ => index += 1,
        }
    }
    None
}

/// Decode `: "<string>"` at the head of `rest` as a request ID.
fn member_string_value(rest: &[u8]) -> Option<String> {
    let is_space = |byte: &u8| byte.is_ascii_whitespace();
    let rest = &rest[rest.iter().position(|b| !is_space(b))?..];
    let rest = rest.strip_prefix(b":")?;
    let rest = &rest[rest.iter().position(|b| !is_space(b))?..];
    if rest.first() != Some(&b'"') {
        return None;
    }
    let end = string_end(rest, 0)?;
    let id: String = serde_json::from_slice(&rest[..=end]).ok()?;
    (!id.is_empty() && id.len() <= MAX_REQUEST_ID_BYTES).then_some(id)
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
                            .filter(|id| !id.is_empty() && id.len() <= MAX_REQUEST_ID_BYTES)
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
    if request_id.len() > MAX_REQUEST_ID_BYTES {
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
    fn request_id_prefix_takes_the_root_member_not_a_nested_one() {
        let frame = br#"{"version":1,"input":{"bundle":{"request_id":"nested","key":"x"}},"request_id":"root","operation":"compile"}"#;
        assert_eq!(request_id_prefix(frame), "root");
    }

    #[test]
    fn request_id_prefix_decodes_escapes() {
        assert_eq!(
            request_id_prefix(br#"{"request_id":"r\u002d1","version":1}"#),
            "r-1"
        );
        assert_eq!(
            request_id_prefix(br#"{"request_id":"a\"b\\c","version":1}"#),
            "a\"b\\c"
        );
    }

    #[test]
    fn request_id_prefix_ignores_strings_that_merely_contain_the_key() {
        // A value equal to the key name, and braces inside a string, must not confuse the scan.
        let frame = br#"{"note":"request_id","text":"}{[","request_id":"root"}"#;
        assert_eq!(request_id_prefix(frame), "root");
        let frame = br#"["request_id","root"]"#;
        assert_eq!(request_id_prefix(frame), "");
    }

    #[test]
    fn request_id_prefix_survives_truncation_after_the_root_member() {
        let frame = br#"{"request_id":"root","version":1,"input":{"bundle":{"schemas":[{"key":"a","shape":{"ki"#;
        assert_eq!(request_id_prefix(frame), "root");
        // Cut off inside the root ID itself: nothing trustworthy to echo.
        assert_eq!(request_id_prefix(br#"{"request_id":"ro"#), "");
        // Root ID beyond the retained bytes: nested one is not used in its place.
        assert_eq!(
            request_id_prefix(br#"{"input":{"request_id":"nested"},"req"#),
            ""
        );
    }

    #[test]
    fn request_id_prefix_rejects_empty_and_oversized_ids() {
        assert_eq!(request_id_prefix(br#"{"request_id":""}"#), "");
        let long = format!(
            r#"{{"request_id":"{}"}}"#,
            "x".repeat(MAX_REQUEST_ID_BYTES + 1)
        );
        assert_eq!(request_id_prefix(long.as_bytes()), "");
        assert_eq!(request_id_prefix(br#"{"request_id":42}"#), "");
    }

    #[test]
    fn native_wide_integer_response_is_a_transport_error_not_an_empty_frame() {
        let bytes = bounded_response(Response {
            version: PROTOCOL_VERSION,
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
            format!(
                r#"{{"version":{},"request_id":"r","operation":"compile"}}"#,
                PROTOCOL_VERSION + 1
            )
            .as_bytes(),
        );
        let unknown = handle_frame(
            &mut state,
            format!(r#"{{"version":{PROTOCOL_VERSION},"request_id":"r","operation":"other"}}"#)
                .as_bytes(),
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
