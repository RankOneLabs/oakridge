fn main() {
    let source = std::env::args().any(|argument| argument == "--generate-source-contracts");
    if source {
        print!("{}", workflow_contracts::generate_source());
    } else {
        print!("{}", workflow_contracts::generate());
    }
}
