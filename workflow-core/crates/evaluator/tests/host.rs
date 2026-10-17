use workflow_evaluator::host::{core_alloc, core_dealloc, core_process, core_response_len};
use workflow_model::protocol::{
    Response, ResponseResult, TransportError, TransportErrorKind, PROTOCOL_VERSION,
};

fn request_value(bytes: &[u8]) -> serde_json::Value {
    let pointer = core_alloc(bytes.len());
    unsafe {
        std::slice::from_raw_parts_mut(pointer, bytes.len()).copy_from_slice(bytes);
        let response = core_process(pointer, bytes.len());
        let result =
            serde_json::from_slice(std::slice::from_raw_parts(response, core_response_len()))
                .unwrap();
        core_dealloc(pointer, bytes.len());
        result
    }
}

fn request(bytes: &[u8]) -> Response {
    serde_json::from_value(request_value(bytes)).unwrap()
}

#[test]
fn abi_allocation_round_trips_through_exact_length() {
    let len = 512;
    let pointer = core_alloc(len);
    unsafe {
        std::slice::from_raw_parts_mut(pointer, len).fill(0xa5);
        core_dealloc(pointer, len);
    }
}

#[test]
fn unknown_operation_returns_a_typed_error() {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": PROTOCOL_VERSION, "request_id": "one", "operation": "unknown", "input": {},
    }))
    .unwrap();
    let response = request(&bytes);
    assert!(matches!(
        response.result,
        ResponseResult::TransportError(TransportError {
            kind: TransportErrorKind::UnknownOperation,
            ..
        })
    ));
}

#[test]
fn previous_wire_version_is_rejected_before_dispatch() {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": PROTOCOL_VERSION - 1, "request_id": "one", "operation": "step", "input": {},
    }))
    .unwrap();
    let response = request(&bytes);
    assert!(matches!(
        response.result,
        ResponseResult::TransportError(TransportError {
            kind: TransportErrorKind::UnsupportedVersion,
            ..
        })
    ));
}

#[test]
fn compile_response_carries_every_located_error() {
    let mut workflow: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    workflow["stages"]["prepare"]["done_when"] = serde_json::Value::Null;
    workflow["stages"]["item"]["done_when"] = serde_json::Value::Null;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": PROTOCOL_VERSION,
        "request_id": "compile-errors",
        "operation": "compile",
        "input": { "workflow": workflow, "prompts": {}, "operations": [] },
    }))
    .unwrap();
    let response = request(&bytes);
    let ResponseResult::CompileErrors(errors) = response.result else {
        panic!("expected compile errors")
    };
    assert!(errors
        .iter()
        .any(|error| error.path.0 == "stages.item.done_when"));
    assert!(errors
        .iter()
        .any(|error| error.path.0 == "stages.prepare.done_when"));
}

#[test]
fn source_decode_error_uses_the_compile_error_response() {
    let mut workflow: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
    workflow["schemas"]["pr_status"]["number"] = "list(integer".into();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": PROTOCOL_VERSION,
        "request_id": "source-error",
        "operation": "compile",
        "input": { "workflow": workflow, "prompts": {}, "operations": [] },
    }))
    .unwrap();
    let response = request(&bytes);
    let ResponseResult::CompileErrors(errors) = response.result else {
        panic!("expected compile errors")
    };
    assert_eq!(errors[0].path.0, "schemas.pr_status.number");
    assert_eq!((errors[0].span.start, errors[0].span.end), (0, 12));
}

#[test]
fn compile_response_exposes_resolved_types_with_the_source_digest() {
    let mut workflow: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
    workflow["schemas"]["future"] = "outcome_of(document)".into();
    workflow["schemas"]["label"] = "text".into();
    workflow["stages"]["document"]["input"]["topic"] = "label".into();
    let prompts: std::collections::BTreeMap<String, String> = [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{topic}} {{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}} {{critique}}"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect();
    let source =
        workflow_compiler::decode_workflow(&serde_json::to_vec(&workflow).unwrap()).unwrap();
    let expected_digest = workflow_compiler::compile_workflow_detailed(&source, &[], &prompts)
        .unwrap()
        .digest;
    let response = request_value(
        &serde_json::to_vec(&serde_json::json!({
            "version": PROTOCOL_VERSION,
            "request_id": "resolved-workflow",
            "operation": "compile",
            "input": { "workflow": workflow, "prompts": prompts, "operations": [] },
        }))
        .unwrap(),
    );
    let compiled = &response["result"]["value"]["value"];
    assert_eq!(response["result"]["status"], "ok");
    assert_eq!(response["result"]["value"]["kind"], "compiled");
    assert_eq!(compiled["digest"], expected_digest.0);
    assert_eq!(compiled["workflow"]["schemas"]["future"]["kind"], "record");
    assert_eq!(
        compiled["workflow"]["stages"]["document"]["input"]["fields"]["topic"],
        serde_json::json!({ "kind": "named", "schema": "label" })
    );
}
