pub mod config;

use std::collections::HashMap;
use std::path::PathBuf;
use async_trait::async_trait;
use serde_json::Value;
use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId};
use config::{SessionAgentConfig, SessionAgentDefConfig, load_template, render_template, resolve_binding};

const STAGE_INSTANCE_ID_SENTINEL: &str = "{{STAGE_INSTANCE_ID}}";

pub struct SessionAgent {
    pub prompts_dir: PathBuf,
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

    async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        anyhow::bail!("session_agent execute not yet implemented in this cohort")
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

    #[tokio::test]
    async fn build_config_literal_bindings() {
        let dir = tempfile::tempdir().unwrap();
        write_template(dir.path(), "test.md", "Task: {{TASK}}. Instance: {{STAGE_INSTANCE_ID}}.");

        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };

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

        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };

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
        let mut slot_values: HashMap<String, String> = HashMap::new();
        slot_values.insert("STAGE_INSTANCE_ID".into(), sid.0.to_string());

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

        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };
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

        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };
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
        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };

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

        let agent = SessionAgent { prompts_dir: dir.path().to_path_buf() };
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
}
