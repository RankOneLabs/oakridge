use workflow_evaluator::host::{core_alloc, core_dealloc, core_process, core_response_len};
use workflow_model::protocol::{
    Response, ResponseResult, TransportError, TransportErrorKind, PROTOCOL_VERSION,
};

fn request(bytes: &[u8]) -> Response {
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
