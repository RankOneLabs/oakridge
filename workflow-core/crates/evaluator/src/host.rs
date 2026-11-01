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
    let mut raw = match workflow_compiler::decode_unique_json(bytes) {
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
        match workflow_compiler::decode_workflow_value_detailed(source.clone()) {
            Ok(_) => {}
            Err(errors) => {
                return Response {
                    version: PROTOCOL_VERSION,
                    request_id: id,
                    truncated: false,
                    result: ResponseResult::CompileErrors(errors),
                }
            }
        }
        let mut expanded = source.clone();
        workflow_compiler::expand_workflow_templates_value(&mut expanded)
            .expect("workflow templates were validated by decoding");
        raw["input"]["workflow"] = expanded;
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
        } => workflow_compiler::compile_workflow_with_limits_and_projection_detailed(
            &workflow,
            &operations,
            &prompts,
            &limits,
        )
        .map(|(program, projected_workflow)| {
            let output = CompiledWorkflow {
                digest: program.digest.clone(),
                stages: program
                    .stages
                    .iter()
                    .map(|stage| stage.key.clone())
                    .collect(),
                workflow: Box::new(projected_workflow),
            };
            state.insert(program);
            Output::Compiled(output)
        })
        .map_err(ResponseResult::CompileErrors),
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
            .map(|result| Output::Stepped(Box::new(result)))
            .map_err(|mut error| {
                error.operation = operation_name.into();
                ResponseResult::DomainError(error)
            }),
    };
    Response {
        version: PROTOCOL_VERSION,
        request_id: request.request_id,
        truncated: false,
        result: match result {
            Ok(output) => ResponseResult::Ok(output),
            Err(error) => error,
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

#[cfg(test)]
mod identity_tests {
    use super::*;
    use std::collections::BTreeMap;
    use workflow_model::{CodeOperation, Incoming, StepSnapshot, Workflow};

    fn source() -> Workflow {
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap()
    }
    fn prompts() -> BTreeMap<String, String> {
        [
            (
                "review-loop/write.md",
                include_str!("../../../../workflow-config/prompts/review-loop/write.md"),
            ),
            (
                "review-loop/revise.md",
                include_str!("../../../../workflow-config/prompts/review-loop/revise.md"),
            ),
            (
                "review-loop/critique.md",
                include_str!("../../../../workflow-config/prompts/review-loop/critique.md"),
            ),
            (
                "review-loop/editor.md",
                include_str!("../../../../workflow-config/prompts/review-loop/editor.md"),
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
    }
    fn launch(program: &CheckedWorkflow) {
        let snapshot: StepSnapshot = serde_json::from_value(serde_json::json!({
            "run": { "id": "run", "root": "run" }, "units": [], "attempts": [],
            "revisions": [], "decisions": [], "retry_events": []
        }))
        .unwrap();
        let incoming: Incoming = serde_json::from_value(serde_json::json!({
            "event": { "kind": "launched", "input": { "topic": "identity" } },
            "writer": { "kind": "engine" }, "ingress_id": "launch"
        }))
        .unwrap();
        assert!(
            crate::step_with_limits(program, &snapshot, &incoming, &ResourceLimits::default())
                .is_ok()
        );
    }
    #[test]
    fn cache_and_recovery_keep_prompt_and_registry_variants_separate_in_both_orders() {
        let source = source();
        let original_prompts = prompts();
        let mut edited_prompts = original_prompts.clone();
        edited_prompts.insert("review-loop/write.md".into(), "Changed {{topic}}\n".into());
        let registry: Vec<CodeOperation> = serde_json::from_value(serde_json::json!([{
            "key": "unused", "input_schema": "text", "output_schema": "text"
        }]))
        .unwrap();
        for (first, second) in [
            ((&original_prompts, &[][..]), (&edited_prompts, &[][..])),
            (
                (&original_prompts, &[][..]),
                (&original_prompts, registry.as_slice()),
            ),
        ] {
            let programs = [first, second].map(|(prompts, operations)| {
                workflow_compiler::compile_workflow(&source, operations, prompts).unwrap()
            });
            assert_ne!(programs[0].digest, programs[1].digest);
            for reverse in [false, true] {
                let mut state = CoreState::new();
                let order = if reverse { [1, 0] } else { [0, 1] };
                for index in order {
                    state.insert(programs[index].clone());
                }
                assert_eq!(state.programs.len(), 2);
                for program in &programs {
                    let cached = state
                        .find(&program.digest)
                        .expect("definition remains cached");
                    assert_eq!(cached.digest, program.digest);
                    launch(cached);
                }
                let mut restarted = CoreState::new();
                for index in order {
                    let (prompts, operations) = [first, second][index];
                    let rebuilt =
                        workflow_compiler::compile_workflow(&source, operations, prompts).unwrap();
                    assert_eq!(rebuilt.digest, programs[index].digest);
                    restarted.insert(rebuilt);
                }
                for program in &programs {
                    launch(restarted.find(&program.digest).unwrap());
                }
            }
        }
    }
}
