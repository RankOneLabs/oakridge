use std::collections::VecDeque;
use workflow_compiler::{decode_unique_json, decode_workflow};
use workflow_model::protocol::{
    Operation, Output, Request, Response, ResponseResult, TransportError, TransportErrorKind,
    MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};
use workflow_model::{
    BundleDigest, CheckedWorkflow, DomainError, DomainErrorKind, ResourceLimits, StepError,
};

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
    programs: VecDeque<CheckedWorkflow>,
}
impl CliState {
    pub fn new(host: ResourceLimits) -> Self {
        Self {
            host,
            programs: VecDeque::new(),
        }
    }
    fn find(&mut self, digest: &BundleDigest) -> Option<&CheckedWorkflow> {
        let position = self
            .programs
            .iter()
            .position(|program| &program.digest == digest)?;
        let program = self.programs.remove(position)?;
        self.programs.push_front(program);
        self.programs.front()
    }
    fn insert(&mut self, program: CheckedWorkflow) {
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
    if !["compile", "step"].contains(&operation) {
        return transport(
            request_id,
            TransportErrorKind::UnknownOperation,
            "unknown operation",
        );
    }
    if let Some(source) = raw.get("input").and_then(|input| input.get("workflow")) {
        let source_bytes = serde_json::to_vec(source).unwrap_or_default();
        if let Err(error) = decode_workflow(&source_bytes) {
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
    let domain = |error: StepError| match error {
        StepError::Rejected { reason } => {
            DomainError::new(DomainErrorKind::InvalidAssignment, "step", reason)
        }
        StepError::Invalid { detail } => {
            DomainError::new(DomainErrorKind::InvalidSnapshot, "step", detail)
        }
    };
    let host = state.host.clone();
    let result = match request.operation {
        Operation::Compile {
            workflow,
            operations,
            prompts,
        } => workflow_compiler::compile_workflow_with_limits(
            workflow.as_ref(),
            &operations,
            &prompts,
            &state.host,
        )
        .map(|program| {
            let output = workflow_model::protocol::CompiledWorkflow {
                digest: program.digest.clone(),
                stages: program
                    .stages
                    .iter()
                    .map(|stage| stage.key.clone())
                    .collect(),
            };
            state.insert(program);
            Output::Compiled(output)
        }),
        Operation::Step {
            workflow_digest,
            snapshot,
            incoming,
        } => state
            .find(&workflow_digest)
            .ok_or_else(|| unknown(&workflow_digest))
            .and_then(|program| {
                workflow_evaluator::step_with_limits(program, snapshot.as_ref(), &incoming, &host)
                    .map_err(domain)
            })
            .map(|result| Output::Stepped(Box::new(result))),
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
    use serde_json::{json, Value};
    use workflow_model::protocol::{
        CompiledWorkflow, Operation, Request, MAX_DEPTH_CEILING, WIRE_MAX_JSON_DEPTH,
    };
    use workflow_model::{
        Event, Incoming, RunState, ScopedSnapshot, StepResult, UnitId, UnitStatus, Workflow, Writer,
    };

    fn host() -> ResourceLimits {
        ResourceLimits {
            max_list_items: 10_000,
            max_depth: MAX_DEPTH_CEILING,
            evaluation_budget: 1_000_000,
        }
    }
    fn nested_arrays(levels: usize) -> Vec<u8> {
        let mut bytes = "[".repeat(levels).into_bytes();
        bytes.extend("]".repeat(levels).into_bytes());
        bytes
    }
    fn workflow() -> Workflow {
        serde_json::from_value(json!({
            "workflow": "simple", "input": {},
            "run": {"units": {"document": {"stage": "document", "input": {}}},
                    "outcome": {"draft": "document.outcome.draft"}},
            "stages": {"document": {
                "input": {}, "artifacts": {"draft": {"schema": "text"}},
                "workers": {"writer": {"kind": "agent", "prompts": {"initial": "write.md"},
                                       "inputs": {}, "creates": ["draft"]}},
                "done_when": "approved(draft)", "outcome": {"draft": "latest(draft)"}}}
        }))
        .unwrap()
    }
    /// Serialized from the typed operation so the test never hand-writes a
    /// wire shape the model owns.
    fn frame(request_id: &str, operation: Operation) -> Vec<u8> {
        serde_json::to_vec(&Request {
            version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            operation,
        })
        .unwrap()
    }
    fn compile_frame() -> Vec<u8> {
        frame(
            "compile",
            Operation::Compile {
                workflow: Box::new(workflow()),
                operations: vec![],
                prompts: [("write.md".to_owned(), String::new())]
                    .into_iter()
                    .collect(),
            },
        )
    }
    fn empty_snapshot() -> ScopedSnapshot {
        ScopedSnapshot {
            run: RunState {
                id: "run".into(),
                root: UnitId::from("run"),
                status: UnitStatus::NotStarted,
                input: None,
            },
            units: vec![],
            attempts: vec![],
            revisions: vec![],
            decisions: vec![],
            retry_events: vec![],
        }
    }

    #[test]
    fn request_id_prefix_survives_truncation_after_the_root_member() {
        let frame = br#"{"request_id":"root","version":1,"input":{"workflow":{"workflow":"a","inp"#;
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
        let long = "a".repeat(MAX_REQUEST_ID_BYTES + 1);
        assert_eq!(
            request_id_prefix(format!(r#"{{"request_id":"{long}"}}"#).as_bytes()),
            ""
        );
    }

    #[test]
    fn the_documented_wire_depth_is_what_serde_json_accepts() {
        assert!(serde_json::from_slice::<Value>(&nested_arrays(WIRE_MAX_JSON_DEPTH)).is_ok());
        assert!(serde_json::from_slice::<Value>(&nested_arrays(WIRE_MAX_JSON_DEPTH + 1)).is_err());
    }

    #[test]
    fn compile_caches_the_program_and_step_advances_it() {
        let mut state = CliState::new(host());
        let compiled = handle_frame(&mut state, &compile_frame());
        let ResponseResult::Ok(Output::Compiled(CompiledWorkflow { digest, stages })) =
            compiled.result
        else {
            panic!("expected a compiled workflow, got {:?}", compiled.result);
        };
        assert_eq!(stages.len(), 1);
        let stepped = handle_frame(
            &mut state,
            &frame(
                "step",
                Operation::Step {
                    workflow_digest: digest,
                    snapshot: Box::new(empty_snapshot()),
                    incoming: Incoming {
                        event: Event::Launched { input: json!({}) },
                        writer: Writer::Engine,
                        ingress_id: Some("launch".into()),
                    },
                },
            ),
        );
        let ResponseResult::Ok(Output::Stepped(result)) = stepped.result else {
            panic!("expected a step result, got {:?}", stepped.result);
        };
        // Launching the run starts the one unit and wants its writer.
        assert_eq!(result.wanted.len(), 1);
        assert!(matches!(result.snapshot.run.status, UnitStatus::Active));
    }

    #[test]
    fn configured_host_limits_reach_compile_and_step() {
        let mut depth_limited = CliState::new(ResourceLimits {
            max_depth: 2,
            ..host()
        });
        let response = handle_frame(&mut depth_limited, &compile_frame());
        assert!(matches!(response.result, ResponseResult::DomainError(error)
            if error.kind == DomainErrorKind::ResourceLimit && &*error.detail == "max_depth exceeded"));

        let mut budget_limited = CliState::new(ResourceLimits {
            evaluation_budget: 0,
            ..host()
        });
        let ResponseResult::Ok(Output::Compiled(compiled)) =
            handle_frame(&mut budget_limited, &compile_frame()).result
        else {
            panic!("workflow should compile before its evaluation budget is used")
        };
        let response = handle_frame(
            &mut budget_limited,
            &frame(
                "step",
                Operation::Step {
                    workflow_digest: compiled.digest,
                    snapshot: Box::new(empty_snapshot()),
                    incoming: Incoming {
                        event: Event::Launched { input: json!({}) },
                        writer: Writer::Engine,
                        ingress_id: Some("launch".into()),
                    },
                },
            ),
        );
        assert!(matches!(response.result, ResponseResult::DomainError(error)
            if &*error.detail == "evaluation_budget exceeded"));

        let mut list_limited = CliState::new(ResourceLimits {
            max_list_items: 1,
            ..host()
        });
        let mut source = workflow();
        source.input = workflow_model::TypeExpression::Record(
            [(
                "items".into(),
                workflow_model::TypeExpression::Name("list(text)".into()),
            )]
            .into(),
        );
        let compiled = handle_frame(
            &mut list_limited,
            &frame(
                "compile",
                Operation::Compile {
                    workflow: Box::new(source),
                    operations: vec![],
                    prompts: [("write.md".into(), String::new())].into(),
                },
            ),
        );
        let ResponseResult::Ok(Output::Compiled(compiled)) = compiled.result else {
            panic!("workflow should compile")
        };
        let response = handle_frame(
            &mut list_limited,
            &frame(
                "step",
                Operation::Step {
                    workflow_digest: compiled.digest,
                    snapshot: Box::new(empty_snapshot()),
                    incoming: Incoming {
                        event: Event::Launched {
                            input: json!({"items": ["a", "b"]}),
                        },
                        writer: Writer::Engine,
                        ingress_id: Some("launch".into()),
                    },
                },
            ),
        );
        assert!(matches!(response.result, ResponseResult::DomainError(error)
            if &*error.detail == "max_list_items exceeded"));
    }

    #[test]
    fn stepping_an_uncached_digest_is_an_unknown_bundle_domain_error() {
        let mut state = CliState::new(host());
        let response = handle_frame(
            &mut state,
            &frame(
                "step",
                Operation::Step {
                    workflow_digest: BundleDigest("absent".into()),
                    snapshot: Box::new(empty_snapshot()),
                    incoming: Incoming {
                        event: Event::Launched { input: json!({}) },
                        writer: Writer::Engine,
                        ingress_id: None,
                    },
                },
            ),
        );
        let ResponseResult::DomainError(error) = response.result else {
            panic!("expected a domain error");
        };
        assert_eq!(error.kind, DomainErrorKind::UnknownBundle);
    }

    #[test]
    fn domain_errors_report_the_requested_operation() {
        let mut state = CliState::new(host());
        // A workflow whose stage is absent fails in the compiler, not the wire.
        let mut broken = workflow();
        broken.run.units.get_mut("document").unwrap().stage =
            Some(workflow_model::SymbolKey::from("missing"));
        let response = handle_frame(
            &mut state,
            &frame(
                "compile",
                Operation::Compile {
                    workflow: Box::new(broken),
                    operations: vec![],
                    prompts: Default::default(),
                },
            ),
        );
        let ResponseResult::DomainError(error) = response.result else {
            panic!("expected a domain error");
        };
        assert_eq!(&*error.operation, "compile");
    }

    #[test]
    fn native_wide_integer_response_is_a_transport_error_not_an_empty_frame() {
        let mut snapshot = empty_snapshot();
        // Any raw state Value is guarded; a unit outcome is the one a step
        // response always carries.
        snapshot.units.push(workflow_model::UnitState {
            id: UnitId::from("run/document"),
            parent: Some(UnitId::from("run")),
            declaration: workflow_model::SymbolKey::from("document"),
            stage: Some(workflow_model::SymbolKey::from("document")),
            status: UnitStatus::Done {
                outcome: json!({"draft": u64::MAX}),
            },
            input: json!({}),
            pool: None,
            after: vec![],
        });
        let bytes = bounded_response(Response {
            version: PROTOCOL_VERSION,
            request_id: "wide".into(),
            truncated: false,
            result: ResponseResult::Ok(Output::Stepped(Box::new(StepResult {
                snapshot,
                statuses: vec![],
                wanted: vec![],
            }))),
        });
        assert!(!bytes.is_empty());
        let decoded: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded["result"]["status"], "transport_error");
    }

    #[test]
    fn an_oversized_frame_is_rejected_with_its_request_id() {
        let mut state = CliState::new(host());
        let mut oversized = compile_frame();
        oversized.resize(MAX_FRAME_BYTES + 1, b' ');
        let response = handle_frame(&mut state, &oversized);
        assert!(matches!(
            response.result,
            ResponseResult::TransportError(TransportError {
                kind: TransportErrorKind::OversizedPayload,
                ..
            })
        ));
    }

    #[test]
    fn transport_failures_are_distinct() {
        let mut state = CliState::new(host());
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
