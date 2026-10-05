mod codegen;
mod protocol;

use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    if std::env::args().any(|arg| arg == "--generate-contracts") {
        print!("{}", codegen::generate());
        return Ok(());
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().split(b'\n') {
        let frame = line?;
        let response = protocol::handle_frame(&frame);
        stdout.write_all(&protocol::bounded_response(response))?;
        stdout.flush()?;
    }
    Ok(())
}
