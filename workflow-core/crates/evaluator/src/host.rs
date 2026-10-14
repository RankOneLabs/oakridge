//! Synchronous JSON ABI for Bun's in-process WebAssembly instance.
use std::{cell::RefCell, collections::VecDeque};
use workflow_model::protocol::{
    CompiledWorkflow, Operation, Output, Request, Response, ResponseResult, TransportError,
    TransportErrorKind, PROTOCOL_VERSION,
};
use workflow_model::{
    BundleDigest, CheckedWorkflow, DomainError, DomainErrorKind, ResourceLimits, StepEntity,
    StepError,
};

const MAX_CACHED_PROGRAMS: usize = 32;

fn entity_id(entity: StepEntity, run_id: &str) -> String {
    match entity {
        StepEntity::Run => run_id.to_owned(),
        StepEntity::Unit { unit } => unit.0,
        StepEntity::Worker { unit, worker } => format!("{}:{}", unit.0, worker.0),
        StepEntity::Artifact { unit, artifact } => format!("{}:{}", unit.0, artifact.0),
        StepEntity::Action { action } => action.0,
    }
}

struct CoreState {
    programs: VecDeque<CheckedWorkflow>,
    response: Vec<u8>,
}

impl CoreState {
    fn new() -> Self {
        Self {
            programs: VecDeque::new(),
            response: Vec::new(),
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
    fn process(&mut self, bytes: &[u8]) {
        let response = handle_request(self, bytes);
        self.response = serde_json::to_vec(&response).expect("core response serializes");
    }
}

thread_local! { static STATE: RefCell<CoreState> = RefCell::new(CoreState::new()); }

fn transport(id: String, kind: TransportErrorKind, detail: impl Into<String>) -> Response {
    Response {
        version: PROTOCOL_VERSION,
        request_id: id,
        truncated: false,
        result: ResponseResult::TransportError(TransportError {
            kind,
            detail: detail.into(),
        }),
    }
}

fn handle_request(state: &mut CoreState, bytes: &[u8]) -> Response {
    let raw = match workflow_compiler::decode_unique_json(bytes) {
        Ok(value) => value,
        Err(error) if error.kind == DomainErrorKind::DuplicateKey => {
            return Response {
                version: PROTOCOL_VERSION,
                request_id: String::new(),
                truncated: false,
                result: ResponseResult::DomainError(error),
            };
        }
        Err(error) => {
            return transport(
                String::new(),
                TransportErrorKind::MalformedRequest,
                error.detail.to_string(),
            )
        }
    };
    let id = raw
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    if id.is_empty() || id.len() > 128 {
        return transport(
            id,
            TransportErrorKind::MalformedRequest,
            "request ID must contain 1 to 128 bytes",
        );
    }
    if raw.get("version").and_then(serde_json::Value::as_u64) != Some(u64::from(PROTOCOL_VERSION)) {
        return transport(
            id,
            TransportErrorKind::UnsupportedVersion,
            "unsupported protocol version",
        );
    }
    let operation_name = raw
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    if !["compile", "step"].contains(&operation_name.as_str()) {
        return transport(
            id,
            TransportErrorKind::UnknownOperation,
            "unknown operation",
        );
    }
    if let Some(source) = raw.get("input").and_then(|input| input.get("workflow")) {
        let source_bytes = serde_json::to_vec(source).expect("JSON value serializes");
        if let Err(error) = workflow_compiler::decode_workflow(&source_bytes) {
            return Response {
                version: PROTOCOL_VERSION,
                request_id: id,
                truncated: false,
                result: ResponseResult::DomainError(error),
            };
        }
    }
    let request: Request = match serde_json::from_value(raw) {
        Ok(value) => value,
        Err(error) => {
            return transport(id, TransportErrorKind::MalformedRequest, error.to_string())
        }
    };
    let limits = ResourceLimits::default();
    let result = match request.operation {
        Operation::Compile {
            workflow,
            operations,
            prompts,
        } => workflow_compiler::compile_workflow_with_limits(
            &workflow,
            &operations,
            &prompts,
            &limits,
        )
        .map(|program| {
            let output = CompiledWorkflow {
                digest: program.digest.clone(),
                stages: program
                    .stages
                    .iter()
                    .map(|stage| stage.key.clone())
                    .collect(),
                workflow,
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
            .ok_or_else(|| {
                DomainError::new(
                    DomainErrorKind::UnknownBundle,
                    workflow_digest.to_string(),
                    "workflow digest is not cached",
                )
            })
            .and_then(|program| {
                super::step_with_limits(program, &snapshot, &incoming, &limits).map_err(|error| {
                    match error {
                        StepError::Rejected { reason, entity } => DomainError::new(
                            DomainErrorKind::RejectedEvent,
                            entity_id(entity, &snapshot.run.id),
                            reason,
                        ),
                        StepError::Stalled { unit, reason } => {
                            DomainError::new(DomainErrorKind::StalledEvent, unit.0, reason)
                        }
                        StepError::Invalid { detail, entity } => DomainError::new(
                            DomainErrorKind::InvalidSnapshot,
                            entity_id(entity, &snapshot.run.id),
                            detail,
                        ),
                    }
                })
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
                error.operation = operation_name.into();
                ResponseResult::DomainError(error)
            }
        },
    }
}

/// The caller owns the input allocation and releases it after `core_process`.
#[unsafe(no_mangle)]
pub extern "C" fn core_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `pointer` must be an allocation returned by `core_alloc(len)` and not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_dealloc(pointer: *mut u8, len: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, len)) });
}

/// # Safety
/// `pointer` must address `len` readable bytes in WASM memory. The response
/// pointer remains valid until the next call to `core_process`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_process(pointer: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(pointer, len) };
    STATE.with_borrow_mut(|state| {
        state.process(bytes);
        state.response.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_response_len() -> usize {
    STATE.with_borrow(|state| state.response.len())
}
