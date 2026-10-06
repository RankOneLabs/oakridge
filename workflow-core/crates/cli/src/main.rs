mod codegen;
mod protocol;
use std::io::{self, BufRead, Write};
use workflow_model::protocol::{
    Response, ResponseResult, TransportError, TransportErrorKind, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
fn main() -> io::Result<()> {
    if std::env::args().any(|arg| arg == "--generate-contracts") {
        print!("{}", codegen::generate());
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--generate-source-contracts") {
        print!("{}", codegen::generate_source());
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--source-schema") {
        println!(
            "{}",
            serde_json::to_string_pretty(&schemars::schema_for!(workflow_model::DefinitionBundle))?
        );
        return Ok(());
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::stdout().lock();
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            if !frame.is_empty() || oversized {
                let response = Response {
                    version: PROTOCOL_VERSION,
                    request_id: String::new(),
                    truncated: false,
                    result: ResponseResult::TransportError(TransportError {
                        kind: TransportErrorKind::MalformedFrame,
                        detail: "unterminated request frame".into(),
                    }),
                };
                stdout.write_all(&protocol::bounded_response(response))?;
            }
            break;
        }
        let consumed = chunk.len();
        for byte in chunk {
            if *byte == b'\n' {
                let response = if oversized {
                    Response {
                        version: PROTOCOL_VERSION,
                        request_id: String::new(),
                        truncated: false,
                        result: ResponseResult::TransportError(TransportError {
                            kind: TransportErrorKind::OversizedPayload,
                            detail: "request exceeds maximum bytes".into(),
                        }),
                    }
                } else {
                    protocol::handle_frame(&frame)
                };
                stdout.write_all(&protocol::bounded_response(response))?;
                stdout.flush()?;
                frame.clear();
                oversized = false;
            } else if !oversized {
                if frame.len() == MAX_FRAME_BYTES {
                    frame.clear();
                    oversized = true;
                } else {
                    frame.push(*byte);
                }
            }
        }
        input.consume(consumed);
    }
    Ok(())
}
