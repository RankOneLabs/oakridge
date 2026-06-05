pub mod config;
pub mod routes;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use crate::executor::{StageContext, StageHandle, ResumePayload};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId, StageStatus};
use config::{SessionAgentConfig, SessionAgentDefConfig, load_template, render_template, resolve_binding};

const STAGE_INSTANCE_ID_SENTINEL: &str = "{{STAGE_INSTANCE_ID}}";

// ── RequestId / PermissionDecision ────────────────────────────────────────────

pub type RequestId = String;

#[derive(serde::Serialize, Deserialize, Debug, Clone)]
pub struct PermissionDecision {
    pub approved: bool,
}

// ── LiveStage ─────────────────────────────────────────────────────────────────

pub struct LiveStage {
    /// Subprocess handle; taken (Option→None) when cancel or wait is called.
    pub child: Option<tokio::process::Child>,
    /// Channel to the stdin writer task; send a string to inject a user message.
    pub stdin_tx: mpsc::Sender<String>,
    /// Resolved config for this stage instance.
    pub config: SessionAgentConfig,
    /// Pending PreToolUse approval requests, keyed by gate request id.
    pub pending_approvals: HashMap<RequestId, oneshot::Sender<PermissionDecision>>,
    /// Stage context for emit() and set_status().
    pub ctx: StageContext,
}

// ── SessionAgent (StageType) ──────────────────────────────────────────────────

pub struct SessionAgent {
    pub prompts_dir: PathBuf,
    pub spawn_config: SpawnConfig,
    pub live_stages: Arc<Mutex<HashMap<StageInstanceId, LiveStage>>>,
}

// ── SessionAgentHandle (StageHandle) ─────────────────────────────────────────

struct SessionAgentHandle {
    stage_instance_id: StageInstanceId,
    live_stages: Arc<Mutex<HashMap<StageInstanceId, LiveStage>>>,
}

#[derive(Deserialize)]
struct ApprovalPayload {
    request_id: RequestId,
    decision: PermissionDecision,
}

#[async_trait]
impl StageHandle for SessionAgentHandle {
    async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()> {
        match payload {
            ResumePayload::GateDecision { .. } => {
                anyhow::bail!("unexpected payload: session_agent hosts no gates")
            }
            ResumePayload::FeedbackArtifact { artifact } => {
                let stdin_tx = {
                    let map = self.live_stages.lock().unwrap();
                    map.get(&self.stage_instance_id).map(|ls| ls.stdin_tx.clone())
                };
                let tx = stdin_tx.ok_or_else(|| anyhow::anyhow!("stage not live"))?;
                let text = serde_json::to_string(&artifact.body)?;
                tx.send(text)
                    .await
                    .map_err(|_| anyhow::anyhow!("stdin closed"))?;
                Ok(())
            }
            ResumePayload::Executor { payload } => {
                let approval: ApprovalPayload = serde_json::from_value(payload)
                    .map_err(|e| anyhow::anyhow!("invalid executor payload: {}", e))?;
                let tx = {
                    let mut map = self.live_stages.lock().unwrap();
                    map.get_mut(&self.stage_instance_id)
                        .ok_or_else(|| anyhow::anyhow!("stage not live"))?
                        .pending_approvals
                        .remove(&approval.request_id)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "unknown approval request: {}",
                                approval.request_id
                            )
                        })?
                };
                tx.send(approval.decision)
                    .map_err(|_| anyhow::anyhow!("approval receiver dropped"))?;
                Ok(())
            }
        }
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        let child_opt = {
            let mut map = self.live_stages.lock().unwrap();
            map.get_mut(&self.stage_instance_id)
                .and_then(|ls| ls.child.take())
        };
        if let Some(mut child) = child_opt {
            child.kill().await?;
        }
        Ok(())
    }
}

#[async_trait]
impl StageType for SessionAgent {
    fn id(&self) -> &str {
        "session_agent"
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, Artifact>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: SessionAgentDefConfig = serde_json::from_value(def_config.clone())?;

        let template = load_template(&self.prompts_dir, &def.prompt_template_path)?;

        // Resolve user-defined slot bindings, then inject STAGE_INSTANCE_ID so
        // templates can reference it without requiring an explicit binding.
        let mut slot_values: HashMap<String, String> = HashMap::new();
        for (slot_name, binding) in &def.slot_bindings {
            let value = resolve_binding(binding, inputs, run_context)?;
            slot_values.insert(slot_name.clone(), value);
        }
        slot_values.insert(
            "STAGE_INSTANCE_ID".to_owned(),
            stage_instance_id.0.to_string(),
        );

        let rendered_prompt = render_template(&template, &slot_values)?;

        let sid_str = stage_instance_id.0.to_string();

        // Resolve workdir: binding → string → substitute sentinel → PathBuf
        let workdir_str = resolve_binding(&def.workdir, inputs, run_context)?;
        let workdir_str = workdir_str.replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str);
        let workdir = PathBuf::from(workdir_str);

        // Substitute sentinel in session_name
        let session_name = def.session_name.replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str);

        let config = SessionAgentConfig {
            backend: def.backend,
            rendered_prompt,
            workdir,
            session_name,
            model: def.model,
            pre_authorized_tools: def.pre_authorized_tools,
            yolo: def.yolo,
            output_slots: output_slots.to_vec(),
        };

        Ok(serde_json::to_value(config)?)
    }

    fn http_routes(&self) -> Option<axum::Router> {
        Some(routes::emit_routes(self.live_stages.clone()))
    }

    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let sid = ctx.stage_instance_id;
        let config: SessionAgentConfig = serde_json::from_value(ctx.config.clone())?;

        // 1. Write per-instance settings.json (PreToolUse gate hook) and
        //    mcp-servers.json (gated-review MCP server). Both validate
        //    stage_instance_id via validated_instance_dir before building paths.
        let settings_path =
            write_cc_settings(&self.spawn_config, &sid.0.to_string()).await?;
        let settings_path_str = settings_path.to_string_lossy().to_string();
        let mcp_config_path =
            write_cc_mcp_config(&self.spawn_config, &sid.0.to_string()).await?;
        let mcp_config_path_str = mcp_config_path.to_string_lossy().to_string();

        // 2. Read persisted parent CC sid from the sidecar (written by the prior run's
        //    stdout task). Present on cycle re-activation and crash recovery replay;
        //    None on first activation. The dir already exists from step 1.
        let parent_cc_sid = read_parent_cc_sid(
            &self.spawn_config.oakridge_data,
            &sid.0.to_string(),
        ).await;

        // 3. Build argv via cohort-3 helper.
        let session_cfg = SessionConfig {
            stage_instance_id: sid.0.to_string(),
            workdir: config.workdir.clone(),
            prompt: config.rendered_prompt.clone(),
            model: config.model.clone(),
            parent_cc_sid,
        };
        let argv = build_argv(
            &self.spawn_config,
            &session_cfg,
            &settings_path_str,
            &mcp_config_path_str,
        );

        // 4. Spawn child subprocess.
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        cmd.current_dir(&config.workdir);
        cmd.env("OAKRIDGE_PORT", self.spawn_config.port.to_string());
        cmd.env("OAKRIDGE_STAGE_INSTANCE", &sid.0.to_string());
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("stdout configured as piped");
        let stderr = child.stderr.take().expect("stderr configured as piped");
        let mut raw_stdin = child.stdin.take().expect("stdin configured as piped");

        // Stdin writer task: receives text, injects as stream-json user messages
        // via the cohort-3 inject_user_message helper. Kept open for feedback injection.
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(16);
        tokio::spawn(async move {
            while let Some(text) = stdin_rx.recv().await {
                if inject_user_message(&mut raw_stdin, &text).await.is_err() {
                    break;
                }
            }
            // When channel closes, raw_stdin drops → child receives EOF.
        });

        // Send initial prompt (non-fatal on broken pipe: child may exit quickly).
        stdin_tx.send(config.rendered_prompt.clone()).await.ok();

        // 5. Insert LiveStage into map.
        {
            let mut map = self.live_stages.lock().unwrap();
            map.insert(
                sid,
                LiveStage {
                    child: Some(child),
                    stdin_tx,
                    config: config.clone(),
                    pending_approvals: HashMap::new(),
                    ctx: ctx.clone(),
                },
            );
        }

        // 6. Transition to Running. On failure, clean up the already-spawned child
        // so it doesn't leak in the map with no scheduler handle to cancel it.
        if let Err(e) = ctx.set_status(StageStatus::Running, None).await {
            let child_opt = self.live_stages.lock().unwrap()
                .get_mut(&sid)
                .and_then(|ls| ls.child.take());
            self.live_stages.lock().unwrap().remove(&sid);
            if let Some(mut child) = child_opt {
                child.kill().await.ok();
            }
            return Err(e);
        }

        // 7. Spawn background task: event loop → terminal status → deregister.
        let oakridge_data = self.spawn_config.oakridge_data.clone();
        let live_stages = self.live_stages.clone();
        tokio::spawn(async move {
            // Drain stdout (NDJSON metadata bookkeeping).
            // Sidecar is written as soon as cc_session_id is first observed so crash
            // recovery can fork even if the substrate dies before CC exits.
            let sid_str = sid.0.to_string();
            let stdout_task = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut state = SubprocessState::default();
                let mut sidecar_write_attempted = false;
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            classify_cc_event(&line, &mut state);
                            if !sidecar_write_attempted {
                                if let Some(ref cc_sid) = state.cc_session_id {
                                    write_parent_cc_sid(&oakridge_data, &sid_str, cc_sid).await;
                                    sidecar_write_attempted = true;
                                }
                            }
                        }
                        _ => break,
                    }
                }
                state
            });

            // Drain stderr (retain last line for failure diagnostics).
            let stderr_task = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut last_line: Option<String> = None;
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => last_line = Some(line),
                        _ => break,
                    }
                }
                last_line
            });

            let _state = stdout_task.await.unwrap_or_default();
            let last_stderr = stderr_task.await.unwrap_or_default();

            // Take child from map (don't hold the lock across .await).
            let child_opt = {
                live_stages
                    .lock()
                    .unwrap()
                    .get_mut(&sid)
                    .and_then(|ls| ls.child.take())
            };

            // Derive exit code; treat cancel (None) as non-zero.
            let exit_code = match child_opt {
                Some(mut child) => child
                    .wait()
                    .await
                    .map(|s| s.code().unwrap_or(1))
                    .unwrap_or(1),
                None => 1,
            };

            // Determine terminal status using cohort-3 exit derivation.
            let (status, parked_reason) = if exit_code == 0 {
                (StageStatus::Done, None)
            } else {
                let reason = match last_stderr {
                    Some(ref line) => format!("{} + {}", exit_code, line),
                    None => format!("{}", exit_code),
                };
                (StageStatus::Failed, Some(reason))
            };

            if let Err(e) = ctx.set_status(status, parked_reason).await {
                tracing::error!(sid = %sid.0, "failed to set terminal status: {}", e);
            }

            // Deregister keeps live_stages bounded to actually-live stages.
            live_stages.lock().unwrap().remove(&sid);
        });

        Ok(Box::new(SessionAgentHandle {
            stage_instance_id: sid,
            live_stages: self.live_stages.clone(),
        }))
    }
}

// ── Subprocess harness ────────────────────────────────────────────────────────

/// Static context set once at startup: binary path, port, data root, gate script.
pub struct SpawnConfig {
    pub claude_bin: String,
    pub port: u16,
    /// Root data dir; per-instance dirs live at <oakridge_data>/session_agent/<stage_instance_id>/
    pub oakridge_data: PathBuf,
    /// Absolute path to the PreToolUse gate script.
    pub gate_path: String,
}

/// Per-session inputs supplied when launching a subprocess.
pub struct SessionConfig {
    pub stage_instance_id: String,
    pub workdir: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    /// CC session id of the parent — enables --resume/--fork-session pair.
    pub parent_cc_sid: Option<String>,
}

/// Metadata observed from CC stdout during a run.
#[derive(Debug, Default)]
pub struct SubprocessState {
    pub cc_session_id: Option<String>,
    pub observed_model: Option<String>,
}

/// Outcome derived solely from subprocess exit code.
#[derive(Debug)]
pub enum SessionOutcome {
    Done,
    Failed { parked_reason: String },
}

/// Wrap a string in single quotes for safe inclusion in a bash command.
/// Embedded single quotes are escaped via the '\'' close-reopen idiom.
/// Port of shellQuote (spawn.ts:74-76).
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Build the CC argv with byte/arg parity to makeBuildSpawnCmd
/// (kbbl/adapters/claude-code/spawn.ts).
///
/// Static 17-element prefix:
///   [bin, --print, --input-format, stream-json, --output-format, stream-json,
///    --include-hook-events, --include-partial-messages, --replay-user-messages,
///    --verbose, --setting-sources, user, --settings, <settings_path>,
///    --mcp-config, <mcp_config_path>, --strict-mcp-config]
/// Then conditional [--model, <m>] when model is set.
/// Then [--resume, <parentCcSid>, --fork-session] as a unit when parent sid is set.
///
/// --fork-session must never appear without --resume; forking into a fresh session id
/// stops multiple live forks off the same parent from colliding on CC's internal session id.
pub fn build_argv(
    spawn: &SpawnConfig,
    session: &SessionConfig,
    settings_path: &str,
    mcp_config_path: &str,
) -> Vec<String> {
    let mut argv = vec![
        spawn.claude_bin.clone(),
        "--print".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-hook-events".into(),
        "--include-partial-messages".into(),
        "--replay-user-messages".into(),
        "--verbose".into(),
        "--setting-sources".into(),
        "user".into(),
        "--settings".into(),
        settings_path.to_string(),
        // Load gated-review independently of --setting-sources, which excludes
        // the project-scoped .mcp.json. --strict-mcp-config keeps the MCP set
        // hermetic. Mirrors makeBuildSpawnCmd (spawn.ts).
        "--mcp-config".into(),
        mcp_config_path.to_string(),
        "--strict-mcp-config".into(),
    ];

    if let Some(model) = &session.model {
        argv.push("--model".into());
        argv.push(model.clone());
    }

    if let Some(parent_sid) = &session.parent_cc_sid {
        argv.push("--resume".into());
        argv.push(parent_sid.clone());
        argv.push("--fork-session".into());
    }

    argv
}

/// Resolve and create the per-instance directory
/// `<oakridge_data>/session_agent/<stage_instance_id>`, validating the id first.
///
/// Requires exactly one Normal path component: rejects empty, ".", "..", any
/// forward-slash separator, and absolute paths. Backslash and colon are also
/// rejected explicitly: on Linux they are legal filename chars but would be path
/// separators / drive prefixes on Windows, making them unsafe to embed in a
/// directory name intended to be portable and shell-safe. Shared by
/// write_cc_settings and write_cc_mcp_config so neither can build an unvalidated
/// path, regardless of call order.
async fn validated_instance_dir(
    spawn: &SpawnConfig,
    stage_instance_id: &str,
) -> anyhow::Result<PathBuf> {
    use std::path::{Component, Path};
    let has_unsafe_char = stage_instance_id.contains(['\\', ':']);
    let mut components = Path::new(stage_instance_id).components();
    let is_single_normal = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none();
    if has_unsafe_char || !is_single_normal {
        anyhow::bail!(
            "stage_instance_id must be a single path component (no separators, '.', or '..'): {:?}",
            stage_instance_id
        );
    }
    let instance_dir = spawn
        .oakridge_data
        .join("session_agent")
        .join(stage_instance_id);
    tokio::fs::create_dir_all(&instance_dir).await?;
    Ok(instance_dir)
}

/// Write the per-instance settings.json registering the PreToolUse gate hook.
///
/// Ports writeCcSettings (spawn.ts L35-66). The file is written to
/// <oakridge_data>/session_agent/<stage_instance_id>/settings.json.
/// The gate path is shell-quoted before serialization so paths with spaces
/// or shell-significant characters are handled safely by bash.
pub async fn write_cc_settings(
    spawn: &SpawnConfig,
    stage_instance_id: &str,
) -> anyhow::Result<PathBuf> {
    let instance_dir = validated_instance_dir(spawn, stage_instance_id).await?;

    let settings_path = instance_dir.join("settings.json");
    let gate_cmd = shell_quote(&spawn.gate_path);

    let settings = serde_json::json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": ".*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": gate_cmd,
                            "timeout": 3600
                        }
                    ]
                }
            ]
        }
    });

    tokio::fs::write(&settings_path, serde_json::to_string_pretty(&settings)?).await?;
    Ok(settings_path)
}

/// URL of the gated-review MCP server. Mirrors the repo's committed `.mcp.json`
/// and kbbl's GATED_REVIEW_MCP_URL (spawn.ts) — keep the three in sync.
const GATED_REVIEW_MCP_URL: &str = "http://willie:3555/mcp";

/// Write the per-instance mcp-servers.json registering the gated-review server,
/// read by CC via `--mcp-config <path>`. Returns the absolute path.
///
/// Ports writeCcMcpConfig (spawn.ts). The CC argv carries `--setting-sources
/// user`, which excludes the project-scoped `.mcp.json`, so gated-review is
/// loaded through `--mcp-config` instead (independent of setting sources).
pub async fn write_cc_mcp_config(
    spawn: &SpawnConfig,
    stage_instance_id: &str,
) -> anyhow::Result<PathBuf> {
    let instance_dir = validated_instance_dir(spawn, stage_instance_id).await?;

    let mcp_config_path = instance_dir.join("mcp-servers.json");
    let config = serde_json::json!({
        "mcpServers": {
            "gated-review": { "type": "http", "url": GATED_REVIEW_MCP_URL }
        }
    });
    tokio::fs::write(&mcp_config_path, serde_json::to_string_pretty(&config)?).await?;
    Ok(mcp_config_path)
}

/// Path to the per-instance parent CC session id sidecar file.
fn parent_cc_sid_path(oakridge_data: &std::path::Path, stage_instance_id: &str) -> PathBuf {
    oakridge_data
        .join("session_agent")
        .join(stage_instance_id)
        .join("parent_cc_sid")
}

/// Read the persisted parent CC sid from the sidecar written by the prior run.
/// Returns None when the file is absent (first activation) or unreadable.
async fn read_parent_cc_sid(
    oakridge_data: &std::path::Path,
    stage_instance_id: &str,
) -> Option<String> {
    let path = parent_cc_sid_path(oakridge_data, stage_instance_id);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }
        Err(_) => None,
    }
}

/// Persist the captured CC session id to the sidecar for cycle re-activation and crash recovery.
async fn write_parent_cc_sid(
    oakridge_data: &std::path::Path,
    stage_instance_id: &str,
    cc_sid: &str,
) {
    let path = parent_cc_sid_path(oakridge_data, stage_instance_id);
    if let Err(e) = tokio::fs::write(&path, cc_sid).await {
        tracing::warn!("failed to write parent_cc_sid sidecar for {}: {}", stage_instance_id, e);
    }
}

/// Write a rendered prompt to the child's stdin as a single stream-json user message.
///
/// Format: {"type":"user","message":{"role":"user","content":<text>}}\n
/// Port of writeInput (session.ts:1101-1110). Exposed as a reusable helper so
/// cohort 5 can inject feedback artifacts mid-session using the same transport.
pub async fn inject_user_message<W>(writer: &mut W, text: &str) -> anyhow::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    let mut bytes = serde_json::to_vec(&msg)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// Parse one NDJSON line from CC stdout and update metadata bookkeeping state.
///
/// Ports the metadata-bookkeeping portion of classifyCcEvent (event-classifier.ts L61-125),
/// dropping the compactor forwarding (v2 non-goal).
///
/// - system+init: captures cc_session_id; seeds observed_model first-wins (guard: null check).
/// - assistant: updates observed_model last-wins.
/// - result: observes usage only; does NOT signal completion — Done/Failed derives from exit.
///
/// Returns () in all cases. Malformed JSON or missing fields are silently ignored
/// so the caller's read loop never dies from a bad line.
pub fn classify_cc_event(line: &str, state: &mut SubprocessState) {
    let raw: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    let obj = match raw.as_object() {
        Some(o) => o,
        None => return,
    };

    match obj.get("type").and_then(|v| v.as_str()) {
        Some("system") => {
            if obj.get("subtype").and_then(|v| v.as_str()) != Some("init") {
                return;
            }
            if let Some(sid) = obj.get("session_id").and_then(|v| v.as_str()) {
                state.cc_session_id = Some(sid.to_string());
            }
            // First-wins: only seed when no model has been observed yet. Guards against
            // a stray re-init clobbering a value already updated by a later assistant turn.
            if state.observed_model.is_none() {
                if let Some(model) = obj.get("model").and_then(|v| v.as_str()) {
                    state.observed_model = Some(model.to_string());
                }
            }
        }
        Some("assistant") => {
            // Last-wins: subagent turns may fire under a different model.
            if let Some(model) = raw
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|v| v.as_str())
            {
                state.observed_model = Some(model.to_string());
            }
        }
        Some("result") => {
            // Metadata observation only. result events must NOT complete the session;
            // Done/Failed derives solely from subprocess exit.
        }
        _ => {}
    }
}

/// Run a session_agent subprocess to completion.
///
/// Ports _runAttachedLoop (session.ts:716-779) and the CC events loop (index.ts:172-253).
/// Lifecycle:
///   1. Write per-instance settings.json (PreToolUse gate hook) and
///      mcp-servers.json (gated-review MCP server).
///   2. Build argv with byte/arg parity to makeBuildSpawnCmd.
///   3. Spawn child with OAKRIDGE_PORT and OAKRIDGE_STAGE_INSTANCE set.
///   4. Write the rendered prompt to stdin once as a stream-json user message; close stdin.
///   5. Drain stdout (NDJSON metadata bookkeeping) and stderr concurrently.
///   6. Read subprocess exit; derive Done (code 0) or Failed (non-zero/crash).
///      Failed carries parked_reason = "<exit_code> + <last_stderr_line>".
///
/// Returns the outcome and the observed metadata state so callers can access
/// the captured cc_session_id and observed_model.
pub async fn run(
    spawn: &SpawnConfig,
    session: &SessionConfig,
) -> anyhow::Result<(SessionOutcome, SubprocessState)> {
    let settings_path = write_cc_settings(spawn, &session.stage_instance_id).await?;
    let settings_path_str = settings_path.to_string_lossy().to_string();
    let mcp_config_path = write_cc_mcp_config(spawn, &session.stage_instance_id).await?;
    let mcp_config_path_str = mcp_config_path.to_string_lossy().to_string();
    let argv = build_argv(spawn, session, &settings_path_str, &mcp_config_path_str);

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.current_dir(&session.workdir);
    cmd.env("OAKRIDGE_PORT", spawn.port.to_string());
    cmd.env("OAKRIDGE_STAGE_INSTANCE", &session.stage_instance_id);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Ensure the child is killed if this future is dropped (cancelled).
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn()?;

    // Write the prompt then close stdin (sends EOF to the child).
    // Swallow broken-pipe: if the child exits before we write (e.g. spawn_failure),
    // the exit code already encodes the outcome; propagating the write error would
    // mask it with an Err and hide the real parked_reason.
    {
        let mut stdin = child.stdin.take().expect("stdin configured as piped");
        let write_result = inject_user_message(&mut stdin, &session.prompt).await;
        if let Err(ref e) = write_result {
            let is_broken_pipe = e
                .downcast_ref::<std::io::Error>()
                .map(|io| io.kind() == std::io::ErrorKind::BrokenPipe)
                .unwrap_or(false);
            if !is_broken_pipe {
                write_result?;
            }
        }
    }

    let stdout = child.stdout.take().expect("stdout configured as piped");
    let stderr = child.stderr.take().expect("stderr configured as piped");

    // Drain stdout: parse NDJSON and update metadata state.
    // Classifier errors are swallowed; a malformed line must not kill the pump.
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut state = SubprocessState::default();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => classify_cc_event(&line, &mut state),
                _ => break,
            }
        }
        state
    });

    // Drain stderr: retain the last line for failure diagnostics.
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut last_line: Option<String> = None;
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => last_line = Some(line),
                _ => break,
            }
        }
        last_line
    });

    // Drain both pipes then read exit status.
    let state = stdout_task.await?;
    let last_stderr = stderr_task.await?;
    let status = child.wait().await?;
    let exit_code = status.code().unwrap_or(1);

    if exit_code == 0 {
        Ok((SessionOutcome::Done, state))
    } else {
        let parked_reason = match last_stderr {
            Some(line) => format!("{} + {}", exit_code, line),
            None => format!("{}", exit_code),
        };
        Ok((SessionOutcome::Failed { parked_reason }, state))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use serde_json::json;
    use uuid::Uuid;
    use chrono::Utc;
    use crate::types::{ArtifactId, OutputSlot, StageInstanceId, WorkflowRunId};
    use crate::executor::session_agent::config::SessionBackend;

    fn make_artifact(body: Value) -> Artifact {
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

    fn write_template(dir: &std::path::Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    fn make_agent(dir: &std::path::Path) -> SessionAgent {
        SessionAgent {
            prompts_dir: dir.to_path_buf(),
            spawn_config: SpawnConfig {
                claude_bin: "claude".into(),
                port: 8790,
                oakridge_data: dir.to_path_buf(),
                gate_path: "/usr/local/bin/gate.sh".into(),
            },
            live_stages: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // ── SessionAgent::build_config ────────────────────────────────────────────

    #[tokio::test]
    async fn build_config_literal_bindings() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "test.md", "Task: {{TASK}}. Instance: {{STAGE_INSTANCE_ID}}.");

        let agent = make_agent(dir.path());

        let mut slot_bindings = serde_json::Map::new();
        slot_bindings.insert(
            "TASK".into(),
            json!({"from": "literal", "value": "build the thing"}),
        );
        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "test.md",
            "slot_bindings": slot_bindings,
            "workdir": {"from": "literal", "value": "/workspace/{{STAGE_INSTANCE_ID}}"},
            "session_name": "run-{{STAGE_INSTANCE_ID}}",
            "model": null,
            "pre_authorized_tools": [],
            "yolo": false
        });

        let sid = StageInstanceId(Uuid::parse_str("00000000-0000-0000-0000-000000000042").unwrap());
        let output_slots = vec![OutputSlot { name: "out".into(), artifact_type: "text".into() }];

        let config_val = agent
            .build_config(&def_config, &HashMap::new(), &output_slots, sid, &json!({}))
            .await
            .unwrap();

        let cfg: config::SessionAgentConfig = serde_json::from_value(config_val).unwrap();

        assert!(cfg.rendered_prompt.contains("build the thing"));
        assert!(cfg.rendered_prompt.contains("00000000-0000-0000-0000-000000000042"));
        assert_eq!(
            cfg.workdir,
            PathBuf::from("/workspace/00000000-0000-0000-0000-000000000042")
        );
        assert_eq!(cfg.session_name, "run-00000000-0000-0000-0000-000000000042");
        assert_eq!(cfg.output_slots.len(), 1);
        assert_eq!(cfg.backend, SessionBackend::ClaudeCode);
    }

    #[tokio::test]
    async fn build_config_input_binding() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "tmpl.md", "Spec: {{SPEC_NOTES}}");

        let agent = make_agent(dir.path());

        let mut inputs = HashMap::new();
        inputs.insert(
            "spec".into(),
            make_artifact(json!({"notes": "do the work"})),
        );

        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "tmpl.md",
            "slot_bindings": {
                "SPEC_NOTES": {"from": "input", "input_name": "spec", "path": "/notes"}
            },
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s",
            "model": "claude-sonnet-4-6"
        });

        let sid = StageInstanceId(Uuid::new_v4());

        let config_val = agent
            .build_config(&def_config, &inputs, &[], sid, &json!({}))
            .await
            .unwrap();

        let cfg: config::SessionAgentConfig = serde_json::from_value(config_val).unwrap();
        assert_eq!(cfg.rendered_prompt, "Spec: do the work");
        assert_eq!(cfg.model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[tokio::test]
    async fn build_config_context_binding() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "t.md", "Project: {{PROJECT}}");

        let agent = make_agent(dir.path());
        let run_context = json!({"project_id": "proj-abc"});

        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "t.md",
            "slot_bindings": {
                "PROJECT": {"from": "context", "path": "/project_id"}
            },
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s"
        });

        let sid = StageInstanceId(Uuid::new_v4());
        let config_val = agent
            .build_config(&def_config, &HashMap::new(), &[], sid, &run_context)
            .await
            .unwrap();
        let cfg: config::SessionAgentConfig = serde_json::from_value(config_val).unwrap();
        assert_eq!(cfg.rendered_prompt, "Project: proj-abc");
    }

    #[tokio::test]
    async fn build_config_unfilled_slot_errors() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "t.md", "{{MISSING_SLOT}}");

        let agent = make_agent(dir.path());
        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s"
        });

        let sid = StageInstanceId(Uuid::new_v4());
        let res = agent
            .build_config(&def_config, &HashMap::new(), &[], sid, &json!({}))
            .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("MISSING_SLOT"));
    }

    #[tokio::test]
    async fn build_config_missing_template_errors() {
        let dir = tempfile::tempdir().unwrap();
        let agent = make_agent(dir.path());

        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "does_not_exist.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s"
        });

        let sid = StageInstanceId(Uuid::new_v4());
        let res = agent
            .build_config(&def_config, &HashMap::new(), &[], sid, &json!({}))
            .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn build_config_carries_output_slots() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "t.md", "hello");

        let agent = make_agent(dir.path());
        let output_slots = vec![
            OutputSlot { name: "a".into(), artifact_type: "text".into() },
            OutputSlot { name: "b".into(), artifact_type: "json".into() },
        ];

        let def_config = json!({
            "backend": "claude_code",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s"
        });

        let sid = StageInstanceId(Uuid::new_v4());
        let config_val = agent
            .build_config(&def_config, &HashMap::new(), &output_slots, sid, &json!({}))
            .await
            .unwrap();
        let cfg: config::SessionAgentConfig = serde_json::from_value(config_val).unwrap();
        assert_eq!(cfg.output_slots.len(), 2);
        assert_eq!(cfg.output_slots[0].name, "a");
        assert_eq!(cfg.output_slots[1].name, "b");
    }

    // ── shell_quote ───────────────────────────────────────────────────────────

    #[test]
    fn shell_quote_no_special_chars() {
        assert_eq!(shell_quote("/usr/local/bin/gate.sh"), "'/usr/local/bin/gate.sh'");
    }

    #[test]
    fn shell_quote_with_single_quote() {
        assert_eq!(shell_quote("/path/with'quote"), "'/path/with'\\''quote'");
    }

    // ── build_argv ────────────────────────────────────────────────────────────

    fn spawn_cfg() -> SpawnConfig {
        SpawnConfig {
            claude_bin: "claude".into(),
            port: 8788,
            oakridge_data: "/tmp/oakridge".into(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        }
    }

    fn session_cfg() -> SessionConfig {
        SessionConfig {
            stage_instance_id: "test-instance".into(),
            workdir: "/tmp/work".into(),
            prompt: "hello".into(),
            model: None,
            parent_cc_sid: None,
        }
    }

    #[test]
    fn build_argv_static_prefix_is_17_elements() {
        let argv = build_argv(
            &spawn_cfg(),
            &session_cfg(),
            "/tmp/settings.json",
            "/tmp/mcp-servers.json",
        );
        assert_eq!(argv.len(), 17);
        assert_eq!(argv[0], "claude");
        assert_eq!(argv[1], "--print");
        assert_eq!(argv[2], "--input-format");
        assert_eq!(argv[3], "stream-json");
        assert_eq!(argv[4], "--output-format");
        assert_eq!(argv[5], "stream-json");
        assert_eq!(argv[6], "--include-hook-events");
        assert_eq!(argv[7], "--include-partial-messages");
        assert_eq!(argv[8], "--replay-user-messages");
        assert_eq!(argv[9], "--verbose");
        assert_eq!(argv[10], "--setting-sources");
        assert_eq!(argv[11], "user");
        assert_eq!(argv[12], "--settings");
        assert_eq!(argv[13], "/tmp/settings.json");
        assert_eq!(argv[14], "--mcp-config");
        assert_eq!(argv[15], "/tmp/mcp-servers.json");
        assert_eq!(argv[16], "--strict-mcp-config");
    }

    #[test]
    fn build_argv_with_model_appends_two_elements() {
        let session = SessionConfig {
            model: Some("claude-opus-4-7".into()),
            ..session_cfg()
        };
        let argv = build_argv(
            &spawn_cfg(),
            &session,
            "/tmp/settings.json",
            "/tmp/mcp-servers.json",
        );
        assert_eq!(argv.len(), 19);
        assert_eq!(argv[17], "--model");
        assert_eq!(argv[18], "claude-opus-4-7");
    }

    #[test]
    fn build_argv_with_parent_sid_appends_resume_fork_unit() {
        let session = SessionConfig {
            parent_cc_sid: Some("parent-sid-abc".into()),
            ..session_cfg()
        };
        let argv = build_argv(
            &spawn_cfg(),
            &session,
            "/tmp/settings.json",
            "/tmp/mcp-servers.json",
        );
        assert_eq!(argv.len(), 20);
        assert_eq!(argv[17], "--resume");
        assert_eq!(argv[18], "parent-sid-abc");
        assert_eq!(argv[19], "--fork-session");
    }

    #[test]
    fn build_argv_fork_session_never_appears_without_resume() {
        let argv = build_argv(
            &spawn_cfg(),
            &session_cfg(),
            "/tmp/settings.json",
            "/tmp/mcp-servers.json",
        );
        assert!(!argv.contains(&"--fork-session".to_string()));
        assert!(!argv.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_argv_model_and_parent_sid_correct_order() {
        let session = SessionConfig {
            model: Some("claude-sonnet-4-6".into()),
            parent_cc_sid: Some("parent-sid-xyz".into()),
            ..session_cfg()
        };
        let argv = build_argv(
            &spawn_cfg(),
            &session,
            "/tmp/settings.json",
            "/tmp/mcp-servers.json",
        );
        assert_eq!(argv.len(), 22);
        assert_eq!(argv[17], "--model");
        assert_eq!(argv[18], "claude-sonnet-4-6");
        assert_eq!(argv[19], "--resume");
        assert_eq!(argv[20], "parent-sid-xyz");
        assert_eq!(argv[21], "--fork-session");
    }

    // ── classify_cc_event ─────────────────────────────────────────────────────

    #[test]
    fn classify_captures_session_id_from_system_init() {
        let mut state = SubprocessState::default();
        classify_cc_event(
            r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-opus-4-7"}"#,
            &mut state,
        );
        assert_eq!(state.cc_session_id.as_deref(), Some("abc-123"));
        assert_eq!(state.observed_model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn classify_system_init_first_wins_on_model() {
        let mut state = SubprocessState::default();
        state.observed_model = Some("already-set".into());
        classify_cc_event(
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"new-model"}"#,
            &mut state,
        );
        assert_eq!(state.observed_model.as_deref(), Some("already-set"));
        assert_eq!(state.cc_session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn classify_assistant_last_wins_on_model() {
        let mut state = SubprocessState::default();
        state.observed_model = Some("init-model".into());
        classify_cc_event(
            r#"{"type":"assistant","message":{"role":"assistant","model":"subagent-model"}}"#,
            &mut state,
        );
        assert_eq!(state.observed_model.as_deref(), Some("subagent-model"));
    }

    #[test]
    fn classify_result_does_not_complete_session() {
        let mut state = SubprocessState::default();
        classify_cc_event(
            r#"{"type":"result","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50}}"#,
            &mut state,
        );
        assert!(state.cc_session_id.is_none());
        assert!(state.observed_model.is_none());
    }

    #[test]
    fn classify_swallows_malformed_json() {
        let mut state = SubprocessState::default();
        classify_cc_event("this is not { json }", &mut state);
        classify_cc_event("", &mut state);
        classify_cc_event("{}", &mut state);
        assert!(state.cc_session_id.is_none());
        assert!(state.observed_model.is_none());
    }

    #[test]
    fn classify_ignores_non_init_system_events() {
        let mut state = SubprocessState::default();
        classify_cc_event(
            r#"{"type":"system","subtype":"other","session_id":"should-not-capture"}"#,
            &mut state,
        );
        assert!(state.cc_session_id.is_none());
    }

    // ── write_cc_settings (async) ─────────────────────────────────────────────

    #[tokio::test]
    async fn write_cc_settings_creates_file_with_correct_structure() {
        let tmp = std::env::temp_dir().join(format!("oak-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "claude".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        let path = write_cc_settings(&spawn, "inst-001").await.unwrap();

        assert!(path.exists());
        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&contents).unwrap();

        let hooks = &v["hooks"]["PreToolUse"][0]["hooks"][0];
        assert_eq!(hooks["type"], "command");
        assert_eq!(hooks["command"], "'/usr/local/bin/gate.sh'");
        assert_eq!(hooks["timeout"], 3600);

        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    #[tokio::test]
    async fn write_cc_settings_rejects_path_separator_in_id() {
        let tmp = std::env::temp_dir().join(format!("oak-guard-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "claude".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        for bad_id in &["../escape", "a/b", "a\\b", "a:b", "..", ".", "", "a/b/c"] {
            let result = write_cc_settings(&spawn, bad_id).await;
            assert!(result.is_err(), "expected Err for id {:?}", bad_id);
            let msg = result.unwrap_err().to_string();
            assert!(msg.contains("single path component"), "unexpected error for {:?}: {}", bad_id, msg);
        }
        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    // ── write_cc_mcp_config (async) ───────────────────────────────────────────

    #[tokio::test]
    async fn write_cc_mcp_config_creates_file_with_correct_structure() {
        let tmp = std::env::temp_dir().join(format!("oak-mcp-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "claude".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        let path = write_cc_mcp_config(&spawn, "inst-001").await.unwrap();

        assert!(path.exists());
        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&contents).unwrap();

        let gated = &v["mcpServers"]["gated-review"];
        assert_eq!(gated["type"], "http");
        assert_eq!(gated["url"], GATED_REVIEW_MCP_URL);

        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    #[tokio::test]
    async fn write_cc_mcp_config_rejects_path_separator_in_id() {
        let tmp = std::env::temp_dir().join(format!("oak-mcp-guard-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "claude".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        for bad_id in &["../escape", "a/b", "a\\b", "a:b", "..", ".", "", "a/b/c"] {
            let result = write_cc_mcp_config(&spawn, bad_id).await;
            assert!(result.is_err(), "expected Err for id {:?}", bad_id);
            let msg = result.unwrap_err().to_string();
            assert!(msg.contains("single path component"), "unexpected error for {:?}: {}", bad_id, msg);
        }
        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    // ── inject_user_message (async) ───────────────────────────────────────────

    #[tokio::test]
    async fn inject_user_message_writes_stream_json_line() {
        let mut buf = Vec::new();
        inject_user_message(&mut buf, "hello world").await.unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hello world");
    }

    // ── sidecar helpers ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn read_parent_cc_sid_returns_none_when_absent() {
        let tmp = std::env::temp_dir().join(format!("oak-sidecar-test-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        let result = read_parent_cc_sid(&tmp, "inst-missing").await;
        assert!(result.is_none());
        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    #[tokio::test]
    async fn write_and_read_parent_cc_sid_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("oak-sidecar-test-{}", Uuid::new_v4()));
        let inst_dir = tmp.join("session_agent").join("inst-001");
        tokio::fs::create_dir_all(&inst_dir).await.unwrap();

        write_parent_cc_sid(&tmp, "inst-001", "abc-session-xyz").await;

        let result = read_parent_cc_sid(&tmp, "inst-001").await;
        assert_eq!(result.as_deref(), Some("abc-session-xyz"));

        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    #[tokio::test]
    async fn read_parent_cc_sid_trims_whitespace() {
        let tmp = std::env::temp_dir().join(format!("oak-sidecar-test-{}", Uuid::new_v4()));
        let inst_dir = tmp.join("session_agent").join("inst-002");
        tokio::fs::create_dir_all(&inst_dir).await.unwrap();

        let sidecar = inst_dir.join("parent_cc_sid");
        tokio::fs::write(&sidecar, "  sid-with-spaces  \n").await.unwrap();

        let result = read_parent_cc_sid(&tmp, "inst-002").await;
        assert_eq!(result.as_deref(), Some("sid-with-spaces"));

        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    #[tokio::test]
    async fn read_parent_cc_sid_returns_none_for_empty_file() {
        let tmp = std::env::temp_dir().join(format!("oak-sidecar-test-{}", Uuid::new_v4()));
        let inst_dir = tmp.join("session_agent").join("inst-003");
        tokio::fs::create_dir_all(&inst_dir).await.unwrap();

        let sidecar = inst_dir.join("parent_cc_sid");
        tokio::fs::write(&sidecar, "   ").await.unwrap();

        let result = read_parent_cc_sid(&tmp, "inst-003").await;
        assert!(result.is_none());

        tokio::fs::remove_dir_all(&tmp).await.ok();
    }

    // ── subprocess integration (uses POSIX `true`/`false` binaries) ─────────────

    #[tokio::test]
    async fn run_exit_zero_returns_done() {
        let tmp = std::env::temp_dir().join(format!("oak-run-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "true".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        let session = SessionConfig {
            stage_instance_id: "run-inst-ok".into(),
            workdir: std::env::temp_dir(),
            prompt: "hello".into(),
            model: None,
            parent_cc_sid: None,
        };
        let (outcome, _state) = run(&spawn, &session).await.unwrap();
        tokio::fs::remove_dir_all(&tmp).await.ok();
        assert!(matches!(outcome, SessionOutcome::Done));
    }

    #[tokio::test]
    async fn run_exit_nonzero_returns_failed_with_reason() {
        let tmp = std::env::temp_dir().join(format!("oak-run-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "false".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        let session = SessionConfig {
            stage_instance_id: "run-inst-fail".into(),
            workdir: std::env::temp_dir(),
            prompt: "hello".into(),
            model: None,
            parent_cc_sid: None,
        };
        let (outcome, _state) = run(&spawn, &session).await.unwrap();
        tokio::fs::remove_dir_all(&tmp).await.ok();
        match outcome {
            SessionOutcome::Failed { parked_reason } => {
                assert!(parked_reason.starts_with('1'), "parked_reason should start with exit code: {}", parked_reason);
            }
            SessionOutcome::Done => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn run_zero_exit_returns_done_no_stdout() {
        let tmp = std::env::temp_dir().join(format!("oak-run-test-{}", Uuid::new_v4()));
        let spawn = SpawnConfig {
            claude_bin: "true".into(),
            port: 8788,
            oakridge_data: tmp.clone(),
            gate_path: "/usr/local/bin/gate.sh".into(),
        };
        let session = SessionConfig {
            stage_instance_id: "run-inst-ndjson".into(),
            workdir: std::env::temp_dir(),
            prompt: "hello".into(),
            model: None,
            parent_cc_sid: None,
        };
        let (outcome, _state) = run(&spawn, &session).await.unwrap();
        tokio::fs::remove_dir_all(&tmp).await.ok();
        assert!(matches!(outcome, SessionOutcome::Done));
    }
}
