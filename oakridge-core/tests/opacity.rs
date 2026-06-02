/// Opacity check: no CC-specific concept leaks outside the session_agent module.
///
/// Scans all `.rs` source files under `src/` excluding `src/executor/session_agent/`
/// and asserts that none of the following CC-specific tokens appear:
///   - "PreToolUse"   (CC hook event type)
///   - "stream-json"  (CC input/output format flag)
///   - "settings.json" (CC per-instance settings file)
///   - "gate.sh"      (CC PreToolUse gate script name)
///
/// Any match outside the session_agent module is a boundary violation.
use std::path::{Path, PathBuf};

const FORBIDDEN_TOKENS: &[&str] = &["PreToolUse", "stream-json", "settings.json", "gate.sh"];

#[test]
fn no_cc_concepts_leak_outside_session_agent() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");
    let session_agent_dir = src_dir.join("executor").join("session_agent");

    let mut violations: Vec<(String, &'static str)> = vec![];
    scan_dir(&src_dir, &session_agent_dir, &mut violations);

    assert!(
        violations.is_empty(),
        "CC-specific tokens found outside the session_agent module boundary:\n{}",
        violations
            .iter()
            .map(|(file, token)| format!("  {file}  contains  {token:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn scan_dir(
    dir: &Path,
    session_agent_dir: &Path,
    violations: &mut Vec<(String, &'static str)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.starts_with(session_agent_dir) {
            continue;
        }
        if path.is_dir() {
            scan_dir(&path, session_agent_dir, violations);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            for &token in FORBIDDEN_TOKENS {
                if content.contains(token) {
                    violations.push((path.to_string_lossy().into_owned(), token));
                }
            }
        }
    }
}
