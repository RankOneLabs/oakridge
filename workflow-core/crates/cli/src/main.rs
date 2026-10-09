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
    let mut host = workflow_model::ResourceLimits {
        max_list_items: 10_000,
        max_depth: workflow_model::protocol::MAX_DEPTH_CEILING,
        evaluation_budget: 1_000_000,
    };
    let mut arguments = std::env::args().skip(1);
    while let Some(flag) = arguments.next() {
        let slot = match flag.as_str() {
            "--max-list-items" => &mut host.max_list_items,
            "--max-depth" => &mut host.max_depth,
            "--evaluation-budget" => &mut host.evaluation_budget,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unknown argument {flag}"),
                ))
            }
        };
        *slot = arguments
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("missing {flag}")))?
            .parse()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("invalid {flag}")))?;
    }
    let mut state = protocol::CliState::new(host);
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
                    request_id: protocol::request_id_prefix(&frame),
                    truncated: false,
                    result: ResponseResult::TransportError(TransportError {
                        kind: if oversized {
                            TransportErrorKind::OversizedPayload
                        } else {
                            TransportErrorKind::MalformedFrame
                        },
                        detail: if oversized {
                            "request exceeds maximum bytes"
                        } else {
                            "unterminated request frame"
                        }
                        .into(),
                    }),
                };
                stdout.write_all(&protocol::bounded_response(response))?;
            }
            break;
        }
        let consumed = chunk.len();
        for byte in chunk {
            if *byte == b'\n' {
                if frame.is_empty() && !oversized {
                    continue;
                }
                let response = if oversized {
                    Response {
                        version: PROTOCOL_VERSION,
                        request_id: protocol::request_id_prefix(&frame),
                        truncated: false,
                        result: ResponseResult::TransportError(TransportError {
                            kind: TransportErrorKind::OversizedPayload,
                            detail: "request exceeds maximum bytes".into(),
                        }),
                    }
                } else {
                    protocol::handle_frame(&mut state, &frame)
                };
                stdout.write_all(&protocol::bounded_response(response))?;
                stdout.flush()?;
                frame.clear();
                oversized = false;
            } else if !oversized {
                if frame.len() == MAX_FRAME_BYTES {
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
