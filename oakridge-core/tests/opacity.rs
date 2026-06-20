/// Opacity check: no direct Claude Code concept leaks under `src/`.
///
/// Scans all `.rs` source files under `src/` and asserts that none of the
/// following direct-execution tokens appear:
///   - "claude --print" (direct CC subprocess invocation)
///   - "stream-json"  (CC input/output format flag)
///   - "PreToolUse"   (CC hook event type)
///   - "gate.sh"      (CC PreToolUse gate script name)
///   - "settings.json" (CC per-instance settings file)
///   - "mcp-servers.json" (per-instance MCP injection file)
///   - "write_cc_settings" / "write_cc_mcp_config" / "read_parent_cc_sid"
///   - "write_parent_cc_sid"
///   - "SessionBackend::Codex"
///
/// Any match under `src/` is a boundary violation.
use std::path::{Path, PathBuf};

const FORBIDDEN_TOKENS: &[&str] = &[
    "claude --print",
    "stream-json",
    "PreToolUse",
    "gate.sh",
    "settings.json",
    "mcp-servers.json",
    "write_cc_settings",
    "write_cc_mcp_config",
    "read_parent_cc_sid",
    "write_parent_cc_sid",
    "SessionBackend::Codex",
];

#[test]
fn no_direct_claude_concepts_leak_into_src() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");

    let mut violations: Vec<(String, &'static str)> = vec![];
    scan_dir(&src_dir, &mut violations);

    assert!(
        violations.is_empty(),
        "direct Claude Code tokens found under src/:\n{}",
        violations
            .iter()
            .map(|(file, token)| format!("  {file}  contains  {token:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn scan_dir(dir: &Path, violations: &mut Vec<(String, &'static str)>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("failed to read_dir {}: {}", dir.display(), e));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path, violations);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let content = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));
            for &token in FORBIDDEN_TOKENS {
                if content.contains(token) {
                    violations.push((path.to_string_lossy().into_owned(), token));
                }
            }
        }
    }
}
