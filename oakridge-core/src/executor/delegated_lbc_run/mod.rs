pub mod config;

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tokio::{fs, io::AsyncReadExt};

use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, ResolvedInput, StageInstanceId, StageStatus};

use config::{
    default_result_output_slot, resolve_output_dir, resolve_run_spec, validate_result_output_slot,
    DelegatedLbcRunConfig, DelegatedLbcRunDefConfig,
};

#[derive(Debug)]
struct DelegatedLbcRunHandle {
    cancel_tx: watch::Sender<bool>,
    completion_rx: Mutex<Option<oneshot::Receiver<()>>>,
}

#[derive(Debug, Clone)]
struct BridgeResultPayload {
    artifact_path: String,
    eval_scores: Value,
}

#[derive(Debug, Clone)]
enum ResultScanError {
    InvalidJson(String),
    InvalidPayload(String),
}

#[derive(Debug, Clone)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
}

impl CapturedOutput {
    fn stdout_tail(&self) -> Vec<String> {
        tail_lines(&self.stdout, 20)
    }

    fn stderr_tail(&self) -> Vec<String> {
        tail_lines(&self.stderr, 20)
    }
}

pub struct DelegatedLbcRunStage;

impl DelegatedLbcRunStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl StageType for DelegatedLbcRunStage {
    fn id(&self) -> &str {
        "delegated_lbc_run"
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, ResolvedInput>,
        output_slots: &[OutputSlot],
        _stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: DelegatedLbcRunDefConfig = serde_json::from_value(def_config.clone())?;
        let run_spec = resolve_run_spec(&def, inputs, run_context)?;
        let output_dir = resolve_output_dir(&def, inputs, run_context)?;
        let bridge_command = def.bridge_command.unwrap_or_else(|| "uv".to_owned());
        let bridge_args = def.bridge_args.unwrap_or_else(|| {
            vec![
                "run".into(),
                "python".into(),
                "-m".into(),
                "legit_biz_club.run".into(),
            ]
        });
        let result_output_slot_name = if def.result_output_slot.is_empty() {
            default_result_output_slot()
        } else {
            def.result_output_slot
        };
        let result_output_slot =
            validate_result_output_slot(output_slots, &result_output_slot_name)?;

        let config = DelegatedLbcRunConfig {
            run_spec,
            output_dir,
            bridge_command,
            bridge_args,
            result_output_slot,
        };

        Ok(serde_json::to_value(config)?)
    }

    async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let config: DelegatedLbcRunConfig = serde_json::from_value(_ctx.config.clone())?;
        let output_dir = canonicalize_or_original(&config.output_dir).await?;
        fs::create_dir_all(&output_dir).await?;

        // `run-spec.json` is written directly into `output_dir` and the bridge runs
        // with that as its `current_dir`. `output_dir` is expected to be scoped per
        // run by the caller (via `resolve_output_dir`), so concurrent stages do not
        // share it; we do not add a stage-instance subdir here. If a workflow ever
        // points multiple delegated_lbc_run stages at the same `output_dir`, scope it
        // upstream rather than relying on a subdir carved out at this layer.
        let run_spec_path = output_dir.join("run-spec.json");
        let run_spec_json = serde_json::to_vec_pretty(&config.run_spec)?;
        fs::write(&run_spec_path, run_spec_json).await?;

        // Trust boundary (intentional): `bridge_command` / `bridge_args` come from
        // the workflow definition and are executed as-is — this stage can launch any
        // binary the def names, as the oakridge-core process user. This is by design:
        // oakridge-core is a single-operator, local-network application, so submitting
        // a workflow def is already a trusted, authenticated action. We deliberately
        // do NOT allowlist bridge executables. If oakridge-core is ever exposed to
        // untrusted def submitters, this must become a strict allowlist.
        let mut command = Command::new(&config.bridge_command);
        command.args(&config.bridge_args);
        command.arg("--spec");
        command.arg(&run_spec_path);
        command.arg("--output-dir");
        command.arg(&output_dir);
        command.current_dir(&output_dir);
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        configure_process_group(&mut command);

        let child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let terminal_meta = terminal_meta_for_spawn_failure(
                    &config,
                    &output_dir,
                    &run_spec_path,
                    &err.to_string(),
                );
                let _ = _ctx
                    .set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                    .await;
                return Ok(Box::new(NoopHandle));
            }
        };

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (completion_tx, completion_rx) = oneshot::channel();

        if let Err(err) = _ctx.set_status(StageStatus::Running, None).await {
            let _ = kill_and_reap(child).await;
            return Err(err);
        }

        let ctx = _ctx.clone();
        let config_clone = config.clone();
        let output_dir_clone = output_dir.clone();
        let run_spec_path_clone = run_spec_path.clone();
        // Supervise the bridge task. If run_bridge panics before reaching its own
        // catch-all, dropping the JoinHandle would discard the JoinError and leave
        // the stage stuck in Running forever with no terminal_meta. The supervisor
        // awaits the handle and records a Failed terminal status on panic so the run
        // always reaches quiescence.
        let supervised_ctx = _ctx.clone();
        tokio::spawn(async move {
            let join: JoinHandle<()> = tokio::spawn(async move {
                run_bridge(
                    ctx,
                    config_clone,
                    output_dir_clone,
                    run_spec_path_clone,
                    child,
                    cancel_rx,
                    completion_tx,
                )
                .await;
            });
            if let Err(join_err) = join.await {
                let _ = supervised_ctx
                    .set_status_with_terminal_meta(
                        StageStatus::Failed,
                        None,
                        Some(serde_json::json!({
                            "kind": "task_panic",
                            "error": join_err.to_string(),
                        })),
                    )
                    .await;
            }
        });

        Ok(Box::new(DelegatedLbcRunHandle {
            cancel_tx,
            completion_rx: Mutex::new(Some(completion_rx)),
        }))
    }
}

#[async_trait]
impl StageHandle for DelegatedLbcRunHandle {
    async fn resume(&self, _payload: crate::executor::ResumePayload) -> anyhow::Result<()> {
        anyhow::bail!("delegated_lbc_run does not support resume")
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        self.cancel_tx
            .send(true)
            .map_err(|_| anyhow::anyhow!("cancel channel closed"))?;
        if let Some(rx) = self.completion_rx.lock().await.take() {
            let _ = rx.await;
        }
        Ok(())
    }
}

struct NoopHandle;

#[async_trait]
impl StageHandle for NoopHandle {
    async fn resume(&self, _payload: crate::executor::ResumePayload) -> anyhow::Result<()> {
        Ok(())
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

async fn canonicalize_or_original(path: &Path) -> anyhow::Result<PathBuf> {
    match fs::canonicalize(path).await {
        Ok(canonical) => Ok(canonical),
        Err(_) => Ok(path.to_path_buf()),
    }
}

async fn kill_and_reap(mut child: Child) -> anyhow::Result<()> {
    terminate_process_group_or_child(&mut child).await;
    let _ = child.wait().await;
    Ok(())
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
async fn terminate_process_group_or_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        signal_process_group(pid, SIGTERM);
        tokio::time::sleep(Duration::from_millis(100)).await;
        signal_process_group(pid, SIGKILL);
    } else {
        let _ = child.kill().await;
    }
}

#[cfg(unix)]
const SIGTERM: i32 = 15;

#[cfg(unix)]
const SIGKILL: i32 = 9;

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let pgid = -(pid as i32);
    unsafe {
        let _ = kill(pgid, signal);
    }
}

#[cfg(not(unix))]
async fn terminate_process_group_or_child(child: &mut Child) {
    let _ = child.kill().await;
}

async fn run_bridge(
    ctx: StageContext,
    config: DelegatedLbcRunConfig,
    output_dir: PathBuf,
    run_spec_path: PathBuf,
    mut child: Child,
    mut cancel_rx: watch::Receiver<bool>,
    completion_tx: oneshot::Sender<()>,
) {
    let command_display = terminal_command(
        &config.bridge_command,
        &config.bridge_args,
        &run_spec_path,
        &output_dir,
    );
    let command_display_for_task = command_display.clone();
    let result = async {
        let stdout = child.stdout.take().ok_or_else(|| {
            anyhow::anyhow!("delegated_lbc_run bridge stdout was not piped")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            anyhow::anyhow!("delegated_lbc_run bridge stderr was not piped")
        })?;

        let output_task = tokio::spawn(capture_output(stdout, stderr));
        let pid = child.id();
        let status = tokio::select! {
            status = child.wait() => {
                status.map_err(|err| anyhow::anyhow!("bridge wait failed: {}", err))?
            }
            _ = async {
                if *cancel_rx.borrow() {
                    return;
                }
                let _ = cancel_rx.changed().await;
            } => {
                terminate_process_group_or_child(&mut child).await;
                child.wait().await.map_err(|err| anyhow::anyhow!("bridge wait after cancel failed: {}", err))?
            }
        };
        let captured = output_task
            .await
            .map_err(|err| anyhow::anyhow!("bridge output task failed: {}", err))??;

        let terminal_meta_base = json_terminal_meta_base(
            &config,
            &output_dir,
            &run_spec_path,
            &command_display_for_task,
            pid,
            &captured,
        );

        if !status.success() {
            let mut terminal_meta = terminal_meta_base;
            merge_terminal_meta(
                &mut terminal_meta,
                serde_json::json!({
                    "kind": if *cancel_rx.borrow() { "cancelled" } else { "non_zero_exit" },
                    "exit_status": format_exit_status(&status),
                }),
            );
            ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                .await?;
            return Ok::<(), anyhow::Error>(());
        }

        let result_payload = match last_result_payload(&captured.stdout) {
            Ok(Some(payload)) => payload,
            Ok(None) => {
                let mut terminal_meta = terminal_meta_base;
                merge_terminal_meta(
                    &mut terminal_meta,
                    serde_json::json!({
                        "kind": "missing_result",
                    }),
                );
                ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                    .await?;
                return Ok::<(), anyhow::Error>(());
            }
            Err(ResultScanError::InvalidJson(err)) => {
                let mut terminal_meta = terminal_meta_base;
                merge_terminal_meta(
                    &mut terminal_meta,
                    serde_json::json!({
                        "kind": "invalid_result_json",
                        "error": err.to_string(),
                    }),
                );
                ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                    .await?;
                return Ok::<(), anyhow::Error>(());
            }
            Err(ResultScanError::InvalidPayload(err)) => {
                let mut terminal_meta = terminal_meta_base;
                merge_terminal_meta(
                    &mut terminal_meta,
                    serde_json::json!({
                        "kind": "invalid_result_payload",
                        "error": err.to_string(),
                    }),
                );
                ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                    .await?;
                return Ok::<(), anyhow::Error>(());
            }
        };

        let artifact_path = resolve_artifact_path(&output_dir, &result_payload.artifact_path);
        let cell_output_dir = artifact_path.parent().ok_or_else(|| {
            anyhow::anyhow!("artifact_path '{}' has no parent directory", artifact_path.display())
        })?;

        let sidecars = discover_sidecars(cell_output_dir).await?;
        let artifact_body = serde_json::json!({
            "artifact_path": result_payload.artifact_path,
            "output_dir": output_dir,
            "run_spec_path": run_spec_path,
            "run_spec": config.run_spec,
            "eval_scores": result_payload.eval_scores,
            "sidecars": sidecars,
        });

        let artifact = match ctx
            .emit(crate::executor::EmitArgs {
                output_name: config.result_output_slot.name.clone(),
                artifact_type: config.result_output_slot.artifact_type.clone(),
                body: artifact_body,
                label: None,
                parent_artifact_id: None,
            })
            .await
        {
            Ok(artifact) => artifact,
            Err(err) => {
                let mut terminal_meta = terminal_meta_base;
                merge_terminal_meta(
                    &mut terminal_meta,
                    serde_json::json!({
                        "kind": "artifact_emit_failed",
                        "error": err.to_string(),
                        "output_name": config.result_output_slot.name,
                        "artifact_type": config.result_output_slot.artifact_type,
                    }),
                );
                ctx.set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
                    .await?;
                return Ok::<(), anyhow::Error>(());
            }
        };

        let mut terminal_meta = terminal_meta_base;
        merge_terminal_meta(
            &mut terminal_meta,
            serde_json::json!({
                "kind": "completed",
                "artifact_id": artifact.id,
                "artifact_path": result_payload.artifact_path,
            }),
        );
        ctx.set_status_with_terminal_meta(StageStatus::Done, None, Some(terminal_meta))
            .await?;

        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(err) = result {
        let terminal_meta = serde_json::json!({
            "kind": "runtime_error",
            "error": err.to_string(),
            "command": command_display,
        });
        let _ = ctx
            .set_status_with_terminal_meta(StageStatus::Failed, None, Some(terminal_meta))
            .await;
    }

    let _ = completion_tx.send(());
}

fn terminal_command(
    command: &str,
    args: &[String],
    run_spec_path: &Path,
    output_dir: &Path,
) -> String {
    // Mirror the args actually injected by `execute` so the recorded command is a
    // faithful reflection of what was spawned.
    let mut parts = vec![command.to_owned()];
    parts.extend(args.iter().cloned());
    parts.push("--spec".to_owned());
    parts.push(run_spec_path.to_string_lossy().into_owned());
    parts.push("--output-dir".to_owned());
    parts.push(output_dir.to_string_lossy().into_owned());
    parts.join(" ")
}

fn json_terminal_meta_base(
    config: &DelegatedLbcRunConfig,
    output_dir: &Path,
    run_spec_path: &Path,
    command_display: &str,
    pid: Option<u32>,
    captured: &CapturedOutput,
) -> Value {
    serde_json::json!({
        "command": &config.bridge_command,
        "args": &config.bridge_args,
        "command_display": command_display,
        "pid": pid,
        "output_dir": output_dir,
        "run_spec_path": run_spec_path,
        "stdout_tail": captured.stdout_tail(),
        "stderr_tail": captured.stderr_tail(),
    })
}

fn merge_terminal_meta(base: &mut Value, extra: Value) {
    if let (Some(base_obj), Some(extra_obj)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_obj {
            base_obj.insert(key.clone(), value.clone());
        }
    }
}

// `artifact_path` comes from the bridge's `RESULT` line. The bridge is a
// first-party process we spawn (legit_biz_club), not untrusted input, so we do
// not guard against absolute paths or `..` traversal here — a misbehaving bridge
// is a bug in our own code, not an attacker surface. Add path confinement if the
// bridge ever becomes a third-party or sandboxed boundary.
fn resolve_artifact_path(output_dir: &Path, artifact_path: &str) -> PathBuf {
    let path = PathBuf::from(artifact_path);
    if path.is_absolute() {
        path
    } else {
        output_dir.join(path)
    }
}

async fn discover_sidecars(cell_output_dir: &Path) -> anyhow::Result<Value> {
    let events_jsonl = maybe_path(cell_output_dir.join("events.jsonl")).await?;
    let eval_scores_json = maybe_path(cell_output_dir.join("eval_scores.json")).await?;
    let commits_dir = maybe_dir(cell_output_dir.join("commits")).await?;
    Ok(serde_json::json!({
        "cell_output_dir": cell_output_dir,
        "events_jsonl_path": events_jsonl,
        "eval_scores_json_path": eval_scores_json,
        "commits_dir": commits_dir,
    }))
}

async fn maybe_path(path: PathBuf) -> anyhow::Result<Option<PathBuf>> {
    match fs::metadata(&path).await {
        Ok(meta) if meta.is_file() => Ok(Some(path)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

async fn maybe_dir(path: PathBuf) -> anyhow::Result<Option<PathBuf>> {
    match fs::metadata(&path).await {
        Ok(meta) if meta.is_dir() => Ok(Some(path)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

fn terminal_meta_for_spawn_failure(
    config: &DelegatedLbcRunConfig,
    output_dir: &Path,
    run_spec_path: &Path,
    error: &str,
) -> Value {
    serde_json::json!({
        "kind": "spawn_failed",
        "command": &config.bridge_command,
        "args": &config.bridge_args,
        "output_dir": output_dir,
        "run_spec_path": run_spec_path,
        "error": error,
    })
}

fn format_exit_status(status: &std::process::ExitStatus) -> Value {
    serde_json::json!({
        "code": status.code(),
        "success": status.success(),
    })
}

fn tail_lines(text: &str, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = text.lines().map(|line| line.to_owned()).collect();
    if lines.len() > max_lines {
        lines.drain(0..lines.len() - max_lines);
    }
    lines
}

// Reads the full stdout/stderr into memory. `last_result_payload` needs to scan
// the entire stdout for the final `RESULT` line, so a bounded tail can't replace
// the full read without risking dropping the payload behind trailing output. The
// bridge is expected to be a single delegated run with modest output; if bridges
// ever become long-lived or chatty, revisit this with a line-streaming scanner
// that keeps the last RESULT plus a bounded tail rather than the whole buffer.
async fn capture_output(
    mut stdout: tokio::process::ChildStdout,
    mut stderr: tokio::process::ChildStderr,
) -> anyhow::Result<CapturedOutput> {
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&buf).to_string())
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        stderr.read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&buf).to_string())
    });

    let stdout = stdout_task
        .await
        .map_err(|err| anyhow::anyhow!("stdout capture task failed: {}", err))??;
    let stderr = stderr_task
        .await
        .map_err(|err| anyhow::anyhow!("stderr capture task failed: {}", err))??;

    Ok(CapturedOutput { stdout, stderr })
}

fn last_result_payload(stdout: &str) -> Result<Option<BridgeResultPayload>, ResultScanError> {
    // The bridge's final `RESULT` line is authoritative: it represents the run's
    // verdict. If that last line cannot be parsed we fail rather than silently
    // falling back to an earlier valid RESULT, which could mask a broken final
    // result and report a stale payload as success.
    let mut last_result = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("RESULT ") {
            last_result = Some(parse_result_payload(rest));
        }
    }
    last_result.transpose()
}

fn parse_result_payload(rest: &str) -> Result<BridgeResultPayload, ResultScanError> {
    let value: Value =
        serde_json::from_str(rest).map_err(|err| ResultScanError::InvalidJson(err.to_string()))?;
    let object = value.as_object().ok_or_else(|| {
        ResultScanError::InvalidPayload("RESULT payload must be a JSON object".into())
    })?;
    let artifact_path = object
        .get("artifact_path")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ResultScanError::InvalidPayload(
                "RESULT payload must contain string artifact_path".into(),
            )
        })?;
    let eval_scores = object.get("eval_scores").cloned().ok_or_else(|| {
        ResultScanError::InvalidPayload("RESULT payload must contain eval_scores".into())
    })?;

    Ok(BridgeResultPayload {
        artifact_path: artifact_path.to_owned(),
        eval_scores,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::executor::delegated_lbc_run::config::{
        DelegatedLbcRunCondition, DelegatedLbcRunConfig, DelegatedLbcRunGraderRef,
    };
    use crate::registry::{ArtifactTypeDef, ArtifactTypeRegistry};
    use crate::types::{ArtifactId, StageInstanceId};
    use crate::types::{
        RunStatus, StageInstance, StageInstanceSummary, StageKey, StageStatus, WorkflowDef,
        WorkflowDefId, WorkflowGraph, WorkflowRun, WorkflowRunId,
    };
    use chrono::Utc;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::mpsc;
    use tokio::time::Duration;
    use uuid::Uuid;

    fn artifact(body: Value) -> Artifact {
        Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: WorkflowRunId(Uuid::new_v4()),
            stage_instance_id: StageInstanceId(Uuid::new_v4()),
            artifact_type: "any".into(),
            output_name: Some("out".into()),
            label: None,
            body,
            version: 1,
            parent_artifact_id: None,
            created_at: Utc::now(),
        }
    }

    fn make_stage() -> DelegatedLbcRunStage {
        DelegatedLbcRunStage::new()
    }

    #[tokio::test]
    async fn build_config_uses_literal_and_context_bindings() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "context", "path": "/workdir"},
        });
        let output_slots = vec![OutputSlot {
            name: "result".into(),
            artifact_type: "text".into(),
        }];

        let config = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({"workdir": "/tmp/study"}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(cfg.run_spec.task, "prose_substrate_thesis");
        assert_eq!(cfg.run_spec.model_pool, vec!["claude-sonnet-4-5"]);
        assert_eq!(
            cfg.run_spec.condition,
            DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            }
        );
        assert_eq!(cfg.output_dir, PathBuf::from("/tmp/study"));
        assert_eq!(cfg.bridge_command, "uv");
        assert_eq!(
            cfg.bridge_args,
            vec!["run", "python", "-m", "legit_biz_club.run"]
        );
        assert_eq!(cfg.result_output_slot.name, "result");
        assert_eq!(cfg.result_output_slot.artifact_type, "text");
    }

    #[tokio::test]
    async fn build_config_preserves_json_bindings_and_custom_bridge_and_slot() {
        let stage = make_stage();
        let mut inputs = HashMap::new();
        inputs.insert("spec".into(), ResolvedInput::Single(artifact(json!({
            "task": "local_task",
            "model_pool": ["m1", "m2"],
            "condition": { "kind": "ensemble_multi_round", "n": 2 },
            "grade": false,
            "grader": { "kind": "registered", "key": "prose_substrate_thesis", "config": { "depth": 3 } },
            "local_task_dir": "/workspace/tasks",
            "local_grader_config_dir": "/workspace/graders"
        }))));
        let def_config = json!({
            "task": {"from": "input", "input_name": "spec", "path": "/task"},
            "model_pool": {"from": "input", "input_name": "spec", "path": "/model_pool"},
            "condition": {"from": "input", "input_name": "spec", "path": "/condition"},
            "grade": {"from": "input", "input_name": "spec", "path": "/grade"},
            "grader": {"from": "input", "input_name": "spec", "path": "/grader"},
            "local_task_dir": {"from": "input", "input_name": "spec", "path": "/local_task_dir"},
            "local_grader_config_dir": {"from": "input", "input_name": "spec", "path": "/local_grader_config_dir"},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
            "bridge_command": "python",
            "bridge_args": ["-m", "legit_biz_club.run"],
            "result_output_slot": "artifact"
        });
        let output_slots = vec![
            OutputSlot {
                name: "artifact".into(),
                artifact_type: "json".into(),
            },
            OutputSlot {
                name: "result".into(),
                artifact_type: "text".into(),
            },
        ];

        let config = stage
            .build_config(
                &def_config,
                &inputs,
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(
            cfg.run_spec,
            crate::executor::delegated_lbc_run::config::DelegatedLbcRunSpec {
                task: "local_task".into(),
                model_pool: vec!["m1".into(), "m2".into()],
                condition: DelegatedLbcRunCondition {
                    kind: "ensemble_multi_round".into(),
                    n: 2,
                },
                grade: false,
                grader: Some(DelegatedLbcRunGraderRef::Registered {
                    key: "prose_substrate_thesis".into(),
                    config: Some(json!({"depth": 3})),
                }),
                local_task_dir: Some(PathBuf::from("/workspace/tasks")),
                local_grader_config_dir: Some(PathBuf::from("/workspace/graders")),
            }
        );
        assert_eq!(cfg.bridge_command, "python");
        assert_eq!(cfg.bridge_args, vec!["-m", "legit_biz_club.run"]);
        assert_eq!(cfg.result_output_slot.name, "artifact");
        assert_eq!(cfg.result_output_slot.artifact_type, "json");
    }

    #[tokio::test]
    async fn build_config_rejects_missing_result_slot() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
        });
        let output_slots = vec![OutputSlot {
            name: "not-result".into(),
            artifact_type: "text".into(),
        }];

        let err = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("result output slot 'result' not found"));
    }

    #[tokio::test]
    async fn build_config_accepts_custom_result_slot_type_from_workflow_outputs() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
            "result_output_slot": "final"
        });
        let output_slots = vec![OutputSlot {
            name: "final".into(),
            artifact_type: "markdown".into(),
        }];

        let config = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(cfg.result_output_slot.artifact_type, "markdown");
    }

    async fn make_pool() -> Arc<sqlx::SqlitePool> {
        let path = format!("/tmp/oakridge_lbc_run_{}.db", Uuid::new_v4());
        Arc::new(
            crate::db::init_pool(&format!("sqlite:{}", path))
                .await
                .unwrap(),
        )
    }

    fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    async fn setup_run(
        pool: &sqlx::SqlitePool,
        stage_type: &str,
    ) -> (WorkflowRunId, StageInstanceId) {
        let def = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut stages = HashMap::new();
                    stages.insert(
                        "s1".into(),
                        crate::types::StageNodeDef {
                            stage_type: stage_type.into(),
                            config: json!({}),
                            inputs: vec![],
                            outputs: vec![crate::types::OutputSlot {
                                name: "result".into(),
                                artifact_type: "artifact".into(),
                            }],
                        },
                    );
                    stages
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        queries::insert_workflow_def(pool, &def).await.unwrap();

        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_workflow_run(pool, &run).await.unwrap();

        let si = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: StageKey::from("s1"),
            stage_type: stage_type.into(),
            status: StageStatus::Pending,
            config: json!({}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: None,
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        queries::insert_stage_instance(pool, &si).await.unwrap();
        (run.id, si.id)
    }

    fn make_registry() -> Arc<ArtifactTypeRegistry> {
        let mut registry = ArtifactTypeRegistry::new();
        registry.register(ArtifactTypeDef {
            id: "artifact".into(),
            validate: |_| Ok(()),
            component_id: "artifact-viewer".into(),
            capabilities: Default::default(),
            anchor_schema: None,
            review_items_extractor: None,
        });
        Arc::new(registry)
    }

    fn make_ctx(
        pool: Arc<sqlx::SqlitePool>,
        run_id: WorkflowRunId,
        si_id: StageInstanceId,
        registry: Arc<ArtifactTypeRegistry>,
        config: Value,
    ) -> (StageContext, mpsc::Receiver<crate::executor::ExecutorEvent>) {
        let summary = StageInstanceSummary {
            stage_instance_id: si_id,
            workflow_run_id: run_id,
            stage_key: "s1".into(),
            status: StageStatus::Pending,
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
        };
        let (tx, rx) = mpsc::channel(8);
        (
            StageContext::new(summary, config, HashMap::new(), tx, pool, registry),
            rx,
        )
    }

    fn fake_bridge_script() -> String {
        r#"#!/usr/bin/env sh
set -eu
spec=""
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --spec)
      spec="$2"
      shift 2
      ;;
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_dir/cell-1/commits"
cat > "$output_dir/cell-1/events.jsonl" <<'EOF'
{"kind":"event"}
EOF
cat > "$output_dir/cell-1/eval_scores.json" <<'EOF'
{"score": 9}
EOF
printf 'noise\n'
printf 'RESULT {"artifact_path":"cell-1/final.txt","eval_scores":{"score":9}}\n'
printf 'RESULT {"artifact_path":"cell-1/ignored.txt","eval_scores":{"score":0}}\n'
printf 'artifact from %s\n' "$spec" > "$output_dir/cell-1/final.txt"
"#
        .to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_success_writes_spec_spawns_bridge_and_emits_result() {
        let pool = make_pool().await;
        let (run_id, si_id) = setup_run(&pool, "delegated_lbc_run").await;
        let registry = make_registry();
        let tempdir = TempDir::new().unwrap();
        let script_path = tempdir.path().join("fake-bridge.sh");
        tokio::fs::write(&script_path, fake_bridge_script())
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms).unwrap();
        }

        let config = serde_json::to_value(DelegatedLbcRunConfig {
            run_spec: crate::executor::delegated_lbc_run::config::DelegatedLbcRunSpec {
                task: "task".into(),
                model_pool: vec!["model".into()],
                condition: DelegatedLbcRunCondition {
                    kind: "single_agent".into(),
                    n: 1,
                },
                grade: true,
                grader: None,
                local_task_dir: None,
                local_grader_config_dir: None,
            },
            output_dir: tempdir.path().to_path_buf(),
            bridge_command: script_path.to_string_lossy().to_string(),
            bridge_args: vec![],
            result_output_slot: crate::types::OutputSlot {
                name: "result".into(),
                artifact_type: "artifact".into(),
            },
        })
        .unwrap();

        let (ctx, mut rx) = make_ctx(pool.clone(), run_id, si_id, registry.clone(), config);
        let stage = make_stage();
        let _handle = stage.execute(ctx.clone()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let si = queries::get_stage_instance_by_id(&pool, &si_id)
                    .await
                    .unwrap();
                if si.status == StageStatus::Done {
                    assert!(si.terminal_meta.is_some());
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let mut saw_artifact = false;
        let mut saw_done = false;
        while !(saw_artifact && saw_done) {
            match rx.try_recv() {
                Ok(crate::executor::ExecutorEvent::ArtifactEmitted { output_name, .. }) => {
                    assert_eq!(output_name, "result");
                    saw_artifact = true;
                }
                Ok(crate::executor::ExecutorEvent::StatusChanged {
                    status: StageStatus::Running,
                    ..
                }) => {}
                Ok(crate::executor::ExecutorEvent::StatusChanged {
                    status: StageStatus::Done,
                    ..
                }) => {
                    saw_done = true;
                }
                Ok(other) => panic!("unexpected event: {:?}", other),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    panic!("event channel closed before completion")
                }
            }
        }

        let artifacts = queries::list_artifacts_for_run(&pool, &run_id, None)
            .await
            .unwrap();
        let artifacts: Vec<_> = artifacts
            .into_iter()
            .filter(|artifact| artifact.stage_instance_id == si_id)
            .collect();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].output_name.as_deref(), Some("result"));
        assert_eq!(artifacts[0].artifact_type, "artifact");
        assert_eq!(
            artifacts[0].body["artifact_path"],
            json!("cell-1/ignored.txt")
        );
        assert_eq!(artifacts[0].body["eval_scores"], json!({"score": 0}));
        assert_eq!(
            artifacts[0].body["sidecars"]["events_jsonl_path"],
            json!(tempdir.path().join("cell-1/events.jsonl"))
        );
    }
}
