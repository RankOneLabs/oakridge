use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::executor::session_agent::config::{
    load_template, render_template, resolve_binding, SlotBinding,
};
use crate::executor::{ResumePayload, StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId, StageStatus};

// ── Config ────────────────────────────────────────────────────────────────────

/// Definition-time config; embedded in the workflow graph node's `config` field.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DelegatedSessionDefConfig {
    /// Backend identifier forwarded verbatim to kbbl (e.g. "claude-code", "codex").
    pub backend: String,
    pub prompt_template_path: String,
    #[serde(default)]
    pub slot_bindings: HashMap<String, SlotBinding>,
    pub workdir: SlotBinding,
    pub model: Option<String>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
    /// Base URL of the kbbl execution service (e.g. "http://otto:8788").
    pub execution_service_url: String,
    /// Oakridge's own base URL used as the callback origin in the kbbl request.
    pub callback_base_url: String,
}

/// Resolved config stored on the stage instance; received by `execute`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DelegatedSessionConfig {
    pub backend: String,
    pub rendered_prompt: String,
    pub workdir: PathBuf,
    pub model: Option<String>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
    pub execution_service_url: String,
    pub callback_base_url: String,
    pub output_slots: Vec<OutputSlot>,
}

// ── Live context map ──────────────────────────────────────────────────────────

/// Shared map of stage instance ID → live StageContext for inbound callbacks.
pub type LiveContexts = Arc<Mutex<HashMap<StageInstanceId, StageContext>>>;

// ── DelegatedSession (StageType) ──────────────────────────────────────────────

/// Shape of the 201 response from kbbl POST /sessions.
#[derive(Deserialize)]
struct SessionsResponse {
    sid: String,
}

pub struct DelegatedSession {
    pub prompts_dir: PathBuf,
    pub live_ctxs: LiveContexts,
    pub client: reqwest::Client,
}

// ── DelegatedSessionHandle ────────────────────────────────────────────────────

struct DelegatedSessionHandle {
    stage_instance_id: StageInstanceId,
    kbbl_sid: String,
    execution_service_url: String,
    client: reqwest::Client,
    live_ctxs: LiveContexts,
}

#[async_trait]
impl StageHandle for DelegatedSessionHandle {
    async fn resume(&self, payload: ResumePayload) -> anyhow::Result<()> {
        match payload {
            ResumePayload::GateDecision { .. } => {
                anyhow::bail!("delegated_session does not host gates")
            }
            ResumePayload::FeedbackArtifact { .. } => {
                // kbbl owns feedback injection; nothing to do here.
                Ok(())
            }
            ResumePayload::Executor { payload } => {
                // Forward the approval decision to kbbl so the CC/Codex hook
                // handler can unblock. Best-effort: log failures but don't
                // propagate — the substrate has already accepted the decision.
                let request_id = payload
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("ResumePayload::Executor missing required field: request_id"))?
                    .to_string();
                let approved = payload
                    .get("decision")
                    .and_then(|d| d.get("approved"))
                    .and_then(|v| v.as_bool())
                    .ok_or_else(|| anyhow::anyhow!("ResumePayload::Executor missing required field: decision.approved"))?;
                let approval_url = format!(
                    "{}/{}/approval",
                    self.execution_service_url.trim_end_matches('/'),
                    self.kbbl_sid,
                );
                let approval_body = serde_json::json!({
                    "request_id": request_id,
                    "decision": if approved { "approve" } else { "deny" },
                    "scope": "once",
                });
                match self
                    .client
                    .post(&approval_url)
                    .timeout(std::time::Duration::from_secs(10))
                    .json(&approval_body)
                    .send()
                    .await
                {
                    Err(e) => tracing::warn!(
                        error = %e,
                        kbbl_sid = %self.kbbl_sid,
                        "failed to forward approval decision to kbbl (transport error)"
                    ),
                    Ok(resp) if !resp.status().is_success() => tracing::warn!(
                        status = %resp.status(),
                        kbbl_sid = %self.kbbl_sid,
                        "kbbl rejected approval decision; remote session may remain blocked"
                    ),
                    Ok(_) => {}
                }

                // Clear park state.
                let ctx = self
                    .live_ctxs
                    .lock()
                    .unwrap()
                    .get(&self.stage_instance_id)
                    .cloned();
                if let Some(ctx) = ctx {
                    ctx.set_parked_meta(None).await?;
                    ctx.set_status(StageStatus::Running, None).await?;
                }
                Ok(())
            }
        }
    }

    async fn cancel(&self) -> anyhow::Result<()> {
        // Best-effort: tell kbbl to stop the remote session. Log on all failure
        // modes (transport error or non-2xx) without propagating — the orchestrator
        // may already be tearing down and kbbl handles orphaned sessions via its
        // own session lifecycle.
        let delete_url = format!(
            "{}/sessions/{}",
            self.execution_service_url.trim_end_matches('/'),
            self.kbbl_sid,
        );
        match self
            .client
            .delete(&delete_url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Err(e) => tracing::warn!(
                error = %e,
                kbbl_sid = %self.kbbl_sid,
                "failed to cancel kbbl session; it will be orphaned until kbbl cleans it up"
            ),
            Ok(resp) if !resp.status().is_success() => tracing::warn!(
                status = %resp.status(),
                kbbl_sid = %self.kbbl_sid,
                "kbbl DELETE /sessions returned non-2xx; remote session may still be running"
            ),
            Ok(_) => {}
        }
        self.live_ctxs.lock().unwrap().remove(&self.stage_instance_id);
        Ok(())
    }
}

// ── StageType impl ────────────────────────────────────────────────────────────

#[async_trait]
impl StageType for DelegatedSession {
    fn id(&self) -> &str {
        "delegated_session"
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, Artifact>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: DelegatedSessionDefConfig = serde_json::from_value(def_config.clone())?;
        let template = load_template(&self.prompts_dir, &def.prompt_template_path)?;

        let mut slot_values: HashMap<String, String> = HashMap::new();
        for (slot_name, binding) in &def.slot_bindings {
            slot_values.insert(
                slot_name.clone(),
                resolve_binding(binding, inputs, run_context)?,
            );
        }
        slot_values.insert(
            "STAGE_INSTANCE_ID".to_owned(),
            stage_instance_id.0.to_string(),
        );

        let rendered_prompt = render_template(&template, &slot_values)?;
        let workdir = PathBuf::from(resolve_binding(&def.workdir, inputs, run_context)?);

        let config = DelegatedSessionConfig {
            backend: def.backend,
            rendered_prompt,
            workdir,
            model: def.model,
            pre_authorized_tools: def.pre_authorized_tools,
            yolo: def.yolo,
            execution_service_url: def.execution_service_url,
            callback_base_url: def.callback_base_url,
            output_slots: output_slots.to_vec(),
        };

        Ok(serde_json::to_value(config)?)
    }

    fn http_routes(&self) -> Option<axum::Router> {
        None
    }

    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        let sid = ctx.stage_instance_id;
        let config: DelegatedSessionConfig = serde_json::from_value(ctx.config.clone())?;

        // Idempotency guard: Coordinator::recover() re-calls execute() for every
        // non-terminal stage on restart. If a prior execute() already persisted the
        // kbbl sid in external_ref, reuse that session instead of spawning a new one.
        if let Some(existing_sid) = ctx.get_external_ref().await? {
            tracing::info!(
                stage_instance_id = %sid.0,
                kbbl_sid = %existing_sid,
                "delegated_session: reusing existing kbbl session (crash-recovery path)"
            );
            self.live_ctxs.lock().unwrap().insert(sid, ctx.clone());
            return Ok(Box::new(DelegatedSessionHandle {
                stage_instance_id: sid,
                kbbl_sid: existing_sid,
                execution_service_url: config.execution_service_url.clone(),
                client: self.client.clone(),
                live_ctxs: self.live_ctxs.clone(),
            }));
        }

        // Be "live" before making the remote call: transition to Running and
        // register the ctx in the live map BEFORE POSTing to kbbl. kbbl learns the
        // callback URLs only from the POST body, so it cannot call back until after
        // the POST is sent — by which point the stage is already Running and the
        // ctx is discoverable. This closes the window where an early artifact/status
        // callback would 404 (and be silently lost, since callbacks are
        // fire-and-forget) or race the initial Running transition.
        //
        // The terminal-guard in StageContext::set_status is deliberately retained as
        // a centralized invariant: this ordering makes it unreachable on the happy
        // path, but it still protects any caller that does not preserve this order.
        ctx.set_status(StageStatus::Running, None).await?;
        self.live_ctxs.lock().unwrap().insert(sid, ctx.clone());

        let sid_str = sid.0.to_string();
        let body = serde_json::json!({
            "backend": config.backend,
            "prompt": config.rendered_prompt,
            "workdir": config.workdir.to_string_lossy(),
            "model": config.model,
            "pre_authorized_tools": config.pre_authorized_tools,
            "yolo": config.yolo,
            "output_slots": config.output_slots,
            "callback": {
                "base_url": config.callback_base_url.trim().trim_end_matches('/').trim(),
                "stage_instance_id": sid_str,
                "emit_path": format!("/stage_instances/{}/artifacts", sid_str),
                "status_path": format!("/stage_instances/{}/status", sid_str)
            }
        });

        let sessions_url = format!(
            "{}/sessions",
            config.execution_service_url.trim_end_matches('/')
        );

        // From here the stage is Running with no remote session yet. Any failure
        // before the kbbl sid is persisted must drop the ctx from the live map and
        // return Err. The Coordinator owns the Err → Failed transition for every
        // stage type (scheduler.rs), so the executor does NOT set the terminal
        // status itself — its only extra responsibility is the live map the
        // Coordinator cannot see. (Pre-reorder this returned with the stage still
        // Pending; it now returns Running, which the Coordinator then marks Failed.
        // The Coordinator's Failed write passes started_at=None, but the query
        // COALESCEs it, so the started_at this Running transition seeded is
        // preserved — a POST-failure Failed stage keeps its real start time.)
        let response = match self
            .client
            .post(&sessions_url)
            .timeout(std::time::Duration::from_secs(30))
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                self.live_ctxs.lock().unwrap().remove(&sid);
                return Err(anyhow::anyhow!("POST {} failed: {}", sessions_url, e));
            }
        };

        if !response.status().is_success() {
            let http_status = response.status();
            let text = response.text().await.unwrap_or_default();
            self.live_ctxs.lock().unwrap().remove(&sid);
            return Err(anyhow::anyhow!(
                "execution service returned {}: {}",
                http_status,
                text
            ));
        }

        let resp_body: SessionsResponse = match response.json().await {
            Ok(b) => b,
            Err(e) => {
                self.live_ctxs.lock().unwrap().remove(&sid);
                return Err(anyhow::anyhow!(
                    "failed to parse POST /sessions response: {}",
                    e
                ));
            }
        };
        let kbbl_sid = resp_body.sid;

        // Persist the kbbl sid so crash-recovery (Coordinator::recover) rebinds to
        // this session instead of spawning a new one. NOTE: a crash in the window
        // between session creation (above) and this write loses the sid and causes a
        // re-POST on recovery; that duplicate-session window is closed on the kbbl
        // side by making POST /sessions idempotent on stage_instance_id (follow-up).
        if let Err(e) = ctx.set_external_ref(Some(&kbbl_sid)).await {
            // The kbbl session exists but we could not persist its sid. Best-effort
            // cancel it so it doesn't leak, drop the ctx from the live map, and
            // return Err (the Coordinator marks the stage Failed).
            let delete_url = format!(
                "{}/sessions/{}",
                config.execution_service_url.trim_end_matches('/'),
                &kbbl_sid
            );
            if let Err(ce) = self
                .client
                .delete(&delete_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                tracing::warn!(error = %ce, kbbl_sid = %kbbl_sid, "best-effort cancel failed after set_external_ref error");
            }
            self.live_ctxs.lock().unwrap().remove(&sid);
            return Err(e);
        }

        Ok(Box::new(DelegatedSessionHandle {
            stage_instance_id: sid,
            kbbl_sid,
            execution_service_url: config.execution_service_url.clone(),
            client: self.client.clone(),
            live_ctxs: self.live_ctxs.clone(),
        }))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    use crate::types::{ArtifactId, WorkflowRunId};

    fn make_executor(prompts_dir: &std::path::Path) -> DelegatedSession {
        DelegatedSession {
            prompts_dir: prompts_dir.to_path_buf(),
            live_ctxs: Arc::new(Mutex::new(HashMap::new())),
            client: reqwest::Client::new(),
        }
    }

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

    // ── Serde ─────────────────────────────────────────────────────────────────

    #[test]
    fn def_config_roundtrip() {
        let mut slot_bindings = HashMap::new();
        slot_bindings.insert(
            "TASK".to_owned(),
            SlotBinding::Literal { value: "review code".into() },
        );
        let def = DelegatedSessionDefConfig {
            backend: "claude-code".into(),
            prompt_template_path: "delegate.md".into(),
            slot_bindings,
            workdir: SlotBinding::Literal { value: "/workspace".into() },
            model: Some("claude-sonnet-4-6".into()),
            pre_authorized_tools: vec!["Bash".into()],
            yolo: false,
            execution_service_url: "http://otto:8788".into(),
            callback_base_url: "http://frink:8790".into(),
        };
        let v = serde_json::to_value(&def).unwrap();
        let back: DelegatedSessionDefConfig = serde_json::from_value(v).unwrap();
        assert_eq!(def.backend, back.backend);
        assert_eq!(def.execution_service_url, back.execution_service_url);
        assert_eq!(def.callback_base_url, back.callback_base_url);
        assert_eq!(def.pre_authorized_tools, back.pre_authorized_tools);
        assert_eq!(def.model, back.model);
    }

    #[test]
    fn config_roundtrip() {
        let cfg = DelegatedSessionConfig {
            backend: "claude-code".into(),
            rendered_prompt: "do the work".into(),
            workdir: PathBuf::from("/workspace/run-123"),
            model: None,
            pre_authorized_tools: vec![],
            yolo: false,
            execution_service_url: "http://otto:8788".into(),
            callback_base_url: "http://frink:8790".into(),
            output_slots: vec![OutputSlot {
                name: "result".into(),
                artifact_type: "text".into(),
            }],
        };
        let v = serde_json::to_value(&cfg).unwrap();
        let back: DelegatedSessionConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.workdir, back.workdir);
        assert_eq!(cfg.output_slots.len(), 1);
        assert_eq!(cfg.output_slots[0].name, "result");
        assert_eq!(cfg.backend, back.backend);
    }

    // ── build_config ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn build_config_renders_prompt_and_injects_stage_instance_id() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("task.md"),
            "Review {{TOPIC}} in {{STAGE_INSTANCE_ID}}",
        )
        .unwrap();

        let exec = make_executor(tmp.path());
        let sid =
            StageInstanceId(Uuid::parse_str("00000000-0000-0000-0000-000000000042").unwrap());
        let output_slots =
            vec![OutputSlot { name: "result".into(), artifact_type: "any".into() }];

        let mut slot_bindings = HashMap::new();
        slot_bindings.insert(
            "TOPIC".to_owned(),
            SlotBinding::Literal { value: "security".into() },
        );
        let def = DelegatedSessionDefConfig {
            backend: "claude-code".into(),
            prompt_template_path: "task.md".into(),
            slot_bindings,
            workdir: SlotBinding::Literal { value: "/work".into() },
            model: None,
            pre_authorized_tools: vec![],
            yolo: false,
            execution_service_url: "http://otto:8788".into(),
            callback_base_url: "http://frink:8790".into(),
        };
        let def_v = serde_json::to_value(&def).unwrap();
        let config_v = exec
            .build_config(&def_v, &HashMap::new(), &output_slots, sid, &json!({}))
            .await
            .unwrap();

        let config: DelegatedSessionConfig = serde_json::from_value(config_v).unwrap();
        assert_eq!(
            config.rendered_prompt,
            "Review security in 00000000-0000-0000-0000-000000000042"
        );
        assert_eq!(config.workdir, PathBuf::from("/work"));
        assert_eq!(config.output_slots.len(), 1);
        assert_eq!(config.backend, "claude-code");
        assert_eq!(config.execution_service_url, "http://otto:8788");
        assert_eq!(config.callback_base_url, "http://frink:8790");
    }

    #[tokio::test]
    async fn build_config_resolves_workdir_from_input() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("t.md"), "hello").unwrap();

        let exec = make_executor(tmp.path());
        let sid = StageInstanceId(Uuid::new_v4());

        let artifact = make_artifact(json!("/repos/my-proj"));
        let mut inputs = HashMap::new();
        inputs.insert("source".to_owned(), artifact);

        let def = DelegatedSessionDefConfig {
            backend: "codex".into(),
            prompt_template_path: "t.md".into(),
            slot_bindings: HashMap::new(),
            workdir: SlotBinding::Input { input_name: "source".into(), path: None },
            model: None,
            pre_authorized_tools: vec![],
            yolo: true,
            execution_service_url: "http://otto:8788".into(),
            callback_base_url: "http://frink:8790".into(),
        };
        let def_v = serde_json::to_value(&def).unwrap();
        let config_v = exec
            .build_config(&def_v, &inputs, &[], sid, &json!({}))
            .await
            .unwrap();
        let config: DelegatedSessionConfig = serde_json::from_value(config_v).unwrap();
        assert_eq!(config.workdir, PathBuf::from("/repos/my-proj"));
        assert!(config.yolo);
        assert_eq!(config.backend, "codex");
    }

    #[tokio::test]
    async fn build_config_resolves_workdir_from_run_context() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("t.md"), "hello").unwrap();

        let exec = make_executor(tmp.path());
        let sid = StageInstanceId(Uuid::new_v4());

        let def = DelegatedSessionDefConfig {
            backend: "claude-code".into(),
            prompt_template_path: "t.md".into(),
            slot_bindings: HashMap::new(),
            workdir: SlotBinding::Context { path: "/workdir".into() },
            model: None,
            pre_authorized_tools: vec![],
            yolo: false,
            execution_service_url: "http://otto:8788".into(),
            callback_base_url: "http://frink:8790".into(),
        };
        let def_v = serde_json::to_value(&def).unwrap();
        let run_ctx = json!({"workdir": "/context/dir"});
        let config_v = exec
            .build_config(&def_v, &HashMap::new(), &[], sid, &run_ctx)
            .await
            .unwrap();
        let config: DelegatedSessionConfig = serde_json::from_value(config_v).unwrap();
        assert_eq!(config.workdir, PathBuf::from("/context/dir"));
    }
}
