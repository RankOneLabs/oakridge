#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

fn smoke_enabled() -> bool {
    matches!(
        std::env::var("OAKRIDGE_RUN_REAL_LBC_SMOKE").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("oakridge-core has a parent repo directory")
        .to_path_buf()
}

fn legit_biz_club_dir() -> PathBuf {
    repo_root().join("legit-biz-club")
}

#[test]
#[ignore = "opt-in real legit-biz-club smoke test"]
fn real_legit_biz_club_cli_smoke() {
    if !smoke_enabled() {
        eprintln!("skipping real legit-biz-club smoke test; set OAKRIDGE_RUN_REAL_LBC_SMOKE=1");
        return;
    }

    let legit_biz_club_dir = legit_biz_club_dir();
    assert!(
        legit_biz_club_dir.exists(),
        "missing legit-biz-club checkout at {}",
        legit_biz_club_dir.display()
    );

    let tempdir = TempDir::new().unwrap();
    let spec_path = tempdir.path().join("run-spec.json");
    let output_dir = tempdir.path().join("output");
    let model = std::env::var("OAKRIDGE_LBC_SMOKE_MODEL")
        .unwrap_or_else(|_| "claude-sonnet-4-5".to_owned());
    let spec = serde_json::json!({
        "task": "code_leetcode_longest_substring",
        "model_pool": [model],
        "condition": { "kind": "single_agent", "n": 1 },
        "grade": false,
    });
    std::fs::write(&spec_path, serde_json::to_vec_pretty(&spec).unwrap()).unwrap();

    let output = Command::new("uv")
        .current_dir(&legit_biz_club_dir)
        .arg("run")
        .arg("python")
        .arg("-m")
        .arg("legit_biz_club.run")
        .arg("--spec")
        .arg(&spec_path)
        .arg("--output-dir")
        .arg(&output_dir)
        .output()
        .expect("failed to launch uv");

    assert!(
        output.status.success(),
        "legit-biz-club CLI failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let result_line = stdout
        .lines()
        .find(|line| line.starts_with("RESULT "))
        .unwrap_or_else(|| panic!("missing RESULT line in stdout:\n{stdout}"));
    let result_json: Value =
        serde_json::from_str(result_line.strip_prefix("RESULT ").unwrap()).unwrap();

    let artifact_path = result_json["artifact_path"]
        .as_str()
        .expect("RESULT artifact_path must be a string");
    assert!(
        !artifact_path.trim().is_empty(),
        "RESULT artifact_path must not be empty"
    );
    assert_eq!(result_json["eval_scores"], Value::Null);

    let artifact_disk_path = {
        let path = PathBuf::from(artifact_path);
        if path.is_absolute() {
            path
        } else {
            output_dir.join(path)
        }
    };
    assert!(
        artifact_disk_path.exists(),
        "expected artifact file to exist at {}",
        artifact_disk_path.display()
    );
}
