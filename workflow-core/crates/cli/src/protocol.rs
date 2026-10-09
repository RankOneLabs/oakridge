use std::collections::VecDeque;
use workflow_compiler::{
    check_value, compile_with_host, decode_bundle, decode_unique_json, validate_checked_value,
};
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
    // `DomainError::new` cannot know which request it serves; the transport does.
    let operation_name: Box<str> = operation.into();
    if ![
        "compile",
        "validate_payload",
        "validate_value",
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
        Operation::Compile { bundle, catalog } => compile_with_host(&bundle, &state.host, &catalog)
            .map(|program| {
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
        Operation::ValidateValue {
            bundle_digest,
            schema,
            value,
        } => state
            .find(&bundle_digest)
            .ok_or_else(|| unknown(&bundle_digest))
            .and_then(|program| validate_checked_value(&program.derived, &schema, &value))
            .map(|()| Output::Validated(value)),
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
            Err(mut error) => {
                error.operation = operation_name;
                ResponseResult::DomainError(error)
            }
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
    fn domain_errors_report_the_requested_operation() {
        let mut state = CliState::new(ResourceLimits {
            max_list_items: 10_000,
            max_depth: workflow_model::protocol::MAX_DEPTH_CEILING,
            evaluation_budget: 1_000_000,
        });
        let digest = "0".repeat(64);
        let unit = r#"{"schema":"unit","data":{"kind":"record","fields":[],"dictionary":[]}}"#;
        let snapshot = format!(
            r#"{{"owner":"i","scope":"s","version":1,"input":{unit},"state":{unit},"trigger":{{"id":"t","key":"k","payload":{unit}}},"observations":[],"timestamp_ms":1,"random_seed":1}}"#
        );
        let inputs = [
            (
                "validate_payload",
                format!(r#"{{"bundle_digest":"{digest}","schema":"x","payload":1}}"#),
            ),
            (
                "evaluate",
                format!(r#"{{"bundle_digest":"{digest}","snapshot":{snapshot}}}"#),
            ),
            (
                "explain",
                format!(r#"{{"bundle_digest":"{digest}","snapshot":{snapshot}}}"#),
            ),
            (
                "materialize",
                format!(r#"{{"bundle_digest":"{digest}","snapshot":{snapshot},"template":"m"}}"#),
            ),
        ];
        for (operation, input) in inputs {
            let frame = format!(
                r#"{{"version":{PROTOCOL_VERSION},"request_id":"r","operation":"{operation}","input":{input}}}"#
            );
            let response = handle_frame(&mut state, frame.as_bytes());
            let ResponseResult::DomainError(error) = response.result else {
                panic!("{operation}: expected a domain error");
            };
            assert_eq!(error.kind, DomainErrorKind::UnknownBundle, "{operation}");
            assert_eq!(&*error.operation, operation);
        }
    }
    // ---- wire depth: what the compiler accepts must fit the wire both ways ----

    use serde_json::{json, Value};
    use workflow_model::protocol::{
        JSON_CONTAINERS_PER_DEPTH_UNIT, MAX_DEPTH_CEILING, WIRE_ENVELOPE_CONTAINERS,
        WIRE_MAX_JSON_DEPTH,
    };

    /// Nested array/object containers, the quantity serde_json limits.
    fn container_depth(value: &Value) -> usize {
        match value {
            Value::Array(items) => 1 + items.iter().map(container_depth).max().unwrap_or(0),
            Value::Object(members) => 1 + members.values().map(container_depth).max().unwrap_or(0),
            _ => 0,
        }
    }
    fn nested_arrays(levels: usize) -> Vec<u8> {
        let mut bytes = "[".repeat(levels).into_bytes();
        bytes.extend("]".repeat(levels).into_bytes());
        bytes
    }
    fn host() -> ResourceLimits {
        ResourceLimits {
            max_list_items: 10_000,
            max_depth: MAX_DEPTH_CEILING,
            evaluation_budget: 1_000_000,
        }
    }
    fn frame(operation: &str, input: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version": PROTOCOL_VERSION, "request_id": "depth", "operation": operation, "input": input,
        }))
        .unwrap()
    }
    fn minimal() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap()
    }
    fn catalog_for(bundle: &Value) -> Value {
        let operations = bundle["operations"].clone();
        let providers: Vec<Value> = operations
            .as_array()
            .unwrap()
            .iter()
            .map(|operation| {
                json!({"kind": operation["provider_kind"], "input_contract": operation["input_contract"]})
            })
            .collect();
        json!({"operations": operations, "providers": providers})
    }
    /// A `CheckedValue` of `levels` nested record schemas (the costliest kind: four
    /// containers per level), ending in a scalar.
    fn checked_record_chain(levels: usize) -> Value {
        let mut value = json!({"schema": "leaf", "data": {"kind": "boolean", "value": true}});
        for _ in 0..levels {
            value = json!({"schema": "link", "data": {"kind": "record",
                "fields": [{"field_id": 0, "value": value}], "dictionary": []}});
        }
        value
    }
    /// An expression of `levels` record expressions (three containers per node:
    /// the node, its `fields`, a field entry) ending in a literal that carries
    /// `literal_levels` nested containers.
    fn expression_record_chain(levels: usize, literal_levels: usize) -> Value {
        let mut literal = json!(true);
        for _ in 0..literal_levels {
            literal = json!({"f": literal});
        }
        let mut expression = json!({"kind": "literal", "schema": "link", "value": literal});
        for _ in 0..levels {
            expression = json!({"kind": "record", "schema": "link",
                "fields": [{"key": "f", "value": expression}]});
        }
        expression
    }

    #[test]
    fn the_documented_wire_depth_is_what_serde_json_accepts() {
        assert!(decode_unique_json(&nested_arrays(WIRE_MAX_JSON_DEPTH)).is_ok());
        assert!(decode_unique_json(&nested_arrays(WIRE_MAX_JSON_DEPTH + 1)).is_err());
    }

    #[test]
    fn deepest_checked_value_slot_at_the_ceiling_fits_the_wire() {
        // observations[0].value is the deepest slot a CheckedValue occupies in a request:
        // frame, input, snapshot, observations, entry, then the value itself.
        let deepest = checked_record_chain(MAX_DEPTH_CEILING);
        let request = frame(
            "evaluate",
            json!({"bundle_digest": "0".repeat(64), "snapshot": {"observations": [{"value": deepest}]}}),
        );
        let parsed = decode_unique_json(&request).expect("deepest value must fit the wire");
        // MAX_DEPTH_CEILING levels plus the scalar's own data object.
        assert_eq!(
            container_depth(&parsed),
            5 + JSON_CONTAINERS_PER_DEPTH_UNIT * MAX_DEPTH_CEILING + 2
        );
        assert!(container_depth(&parsed) <= WIRE_MAX_JSON_DEPTH);
    }

    #[test]
    fn deepest_source_path_at_the_ceiling_fits_the_wire() {
        // A worker action's `input`: frame, input, bundle, scopes, scope, workers, worker,
        // actions, action, then max_depth + 1 expression nodes ending in the deepest literal.
        let expression = expression_record_chain(MAX_DEPTH_CEILING, MAX_DEPTH_CEILING + 1);
        let bundle = json!({"scopes": [{"workers": [{"actions": [{"input": expression}]}]}]});
        let request = frame("compile", json!({"bundle": bundle, "catalog": {}}));
        let parsed = decode_unique_json(&request).expect("deepest bundle must fit the wire");
        assert_eq!(
            container_depth(&parsed),
            JSON_CONTAINERS_PER_DEPTH_UNIT * MAX_DEPTH_CEILING + WIRE_ENVELOPE_CONTAINERS
        );
        assert!(container_depth(&parsed) <= WIRE_MAX_JSON_DEPTH);
    }

    /// `minimal` with its tree wrapped in `levels` nested `if` nodes.
    fn nested_ifs(levels: usize, max_depth: usize) -> Value {
        let mut bundle = minimal();
        bundle["limits"]["max_depth"] = json!(max_depth);
        let mut tree = bundle["scopes"][0]["tree"].take();
        for index in 0..levels {
            tree = json!({"kind": "if", "id": format!("wrap_{index}"),
                "condition": {"kind": "literal", "schema": "flag", "value": true},
                "then": tree,
                "otherwise": {"kind": "wait", "id": format!("hold_{index}"), "continuations": ["cancel"],
                    "reason": "held", "attention": {"label": "Held", "trigger": "cancel"}}});
        }
        bundle["scopes"][0]["tree"] = tree;
        bundle
    }
    fn compile_outcome(state: &mut CliState, bundle: Value) -> ResponseResult {
        let catalog = catalog_for(&bundle);
        handle_frame(
            state,
            &frame("compile", json!({"bundle": bundle, "catalog": catalog})),
        )
        .result
    }

    #[test]
    fn validate_value_rechecks_an_already_checked_value_against_its_schema() {
        let mut state = CliState::new(host());
        let ResponseResult::Ok(Output::Compiled(compiled)) = compile_outcome(&mut state, minimal())
        else {
            panic!("minimal must compile");
        };
        let flag = json!({"schema": "flag", "data": {"kind": "boolean", "value": true}});
        let accepted = handle_frame(
            &mut state,
            &frame(
                "validate_value",
                json!({"bundle_digest": compiled.digest, "schema": "flag", "value": flag}),
            ),
        );
        assert!(
            matches!(accepted.result, ResponseResult::Ok(Output::Validated(_))),
            "{:?}",
            accepted.result
        );
        let forged = json!({"schema": "flag", "data": {"kind": "integer", "value": 1}});
        let rejected = handle_frame(
            &mut state,
            &frame(
                "validate_value",
                json!({"bundle_digest": compiled.digest, "schema": "flag", "value": forged}),
            ),
        );
        let ResponseResult::DomainError(error) = rejected.result else {
            panic!(
                "a forged value must be a domain error: {:?}",
                rejected.result
            );
        };
        assert_eq!(error.kind, DomainErrorKind::InvalidSnapshot);
        let renamed = handle_frame(
            &mut state,
            &frame(
                "validate_value",
                json!({"bundle_digest": compiled.digest, "schema": "text", "value": flag}),
            ),
        );
        assert!(matches!(renamed.result, ResponseResult::DomainError(_)));
    }

    #[test]
    fn a_bundle_at_the_ceiling_compiles_and_one_level_beyond_is_a_compile_error() {
        let mut state = CliState::new(host());
        let mut deepest_accepted = None;
        for wrappers in 0.. {
            match compile_outcome(&mut state, nested_ifs(wrappers, MAX_DEPTH_CEILING)) {
                ResponseResult::Ok(Output::Compiled(_)) => deepest_accepted = Some(wrappers),
                ResponseResult::DomainError(beyond) => {
                    assert_eq!(beyond.kind, DomainErrorKind::ResourceLimit);
                    assert!(
                        beyond.detail.ends_with("exceeds nesting limit"),
                        "{}",
                        beyond.detail
                    );
                    break;
                }
                _ => panic!("unexpected compile outcome at {wrappers} wrappers"),
            }
        }
        // minimal's own tree spends a few levels of the budget; the rest are wrappers.
        let deepest = deepest_accepted.expect("a shallow bundle compiles");
        assert!(
            (MAX_DEPTH_CEILING - 5..MAX_DEPTH_CEILING).contains(&deepest),
            "{deepest}"
        );
    }

    #[test]
    fn a_declared_max_depth_beyond_the_ceiling_is_a_compile_error_not_a_wire_error() {
        let mut state = CliState::new(ResourceLimits {
            max_depth: MAX_DEPTH_CEILING + 1,
            ..host()
        });
        let ResponseResult::DomainError(refused) =
            compile_outcome(&mut state, nested_ifs(0, MAX_DEPTH_CEILING + 1))
        else {
            panic!("a max_depth above the ceiling must be refused");
        };
        assert_eq!(refused.kind, DomainErrorKind::ResourceLimit);
        assert!(
            refused.detail.contains("exceeds the ceiling"),
            "{}",
            refused.detail
        );
    }

    #[test]
    fn a_value_at_the_ceiling_round_trips_through_validate_payload() {
        let mut state = CliState::new(host());
        let mut bundle = minimal();
        bundle["limits"]["max_depth"] = json!(MAX_DEPTH_CEILING);
        // A record cannot contain itself; build the chain link_0 -> link_1 -> ... -> leaf.
        let schemas = bundle["schemas"].as_array_mut().unwrap();
        schemas.push(json!({"key": "leaf", "shape": {"kind": "boolean"}}));
        // max_depth bounds the schemas on one path, leaf included.
        let links = MAX_DEPTH_CEILING - 1;
        for level in 0..links {
            let next = if level + 1 == links {
                "leaf".to_owned()
            } else {
                format!("link_{}", level + 1)
            };
            schemas.push(
                json!({"key": format!("link_{level}"), "shape": {"kind": "record",
                "fields": [{"key": "f", "schema": next, "required": true}], "dictionary": null}}),
            );
        }
        let ResponseResult::Ok(Output::Compiled(compiled)) = compile_outcome(&mut state, bundle)
        else {
            panic!("chain bundle must compile");
        };
        let mut payload = json!(true);
        for _ in 0..links {
            payload = json!({"f": payload});
        }
        let request = frame(
            "validate_payload",
            json!({"bundle_digest": compiled.digest, "schema": "link_0", "payload": payload}),
        );
        let response = handle_frame(&mut state, &request);
        let ResponseResult::Ok(Output::Validated(value)) = response.result.clone() else {
            panic!("a value at max_depth must validate: {:?}", response.result);
        };
        let wire = bounded_response(Response {
            result: ResponseResult::Ok(Output::Validated(value)),
            ..response
        });
        let echoed: Value = serde_json::from_slice(&wire).unwrap();
        assert!(
            container_depth(&echoed) > MAX_DEPTH_CEILING * 3,
            "{}",
            container_depth(&echoed)
        );
        // And the checked form can be sent back in: it is what an evaluate snapshot carries.
        let checked = echoed["result"]["value"]["value"].clone();
        let back = frame(
            "evaluate",
            json!({"bundle_digest": "0".repeat(64), "snapshot": {"observations": [{"value": checked}]}}),
        );
        assert!(decode_unique_json(&back).is_ok());
    }

    #[test]
    fn transport_failures_are_distinct() {
        let mut state = CliState::new(ResourceLimits {
            max_list_items: 10_000,
            max_depth: workflow_model::protocol::MAX_DEPTH_CEILING,
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
