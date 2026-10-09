use std::io::Write;
use std::process::{Command, Stdio};

/// A blank line before a real frame must be skipped silently: it produces no
/// response and must not disturb the one real frame that follows it.
#[test]
fn a_blank_line_before_a_frame_produces_no_response_of_its_own() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow-cli"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn workflow-cli");

    let frames = format!(
        "\n{{\"version\":{},\"request_id\":\"blank-line-test\",\"operation\":\"nonexistent\"}}\n",
        workflow_model::protocol::PROTOCOL_VERSION
    );
    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(frames.as_bytes())
        .expect("write frames");

    let output = child.wait_with_output().expect("child exits");
    let stdout = String::from_utf8(output.stdout).expect("stdout is utf8");
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "blank line must not produce its own response: {stdout:?}"
    );

    let response: serde_json::Value = serde_json::from_str(lines[0]).expect("response is JSON");
    assert_eq!(response["request_id"], "blank-line-test");
    assert_eq!(response["result"]["status"], "transport_error");
    assert_eq!(response["result"]["value"]["kind"], "unknown_operation");
}
