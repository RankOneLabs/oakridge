pub mod config;
pub mod kbbl_client;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;

use crate::executor::prompt_config::{load_template, render_template, resolve_binding};
use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId};

use config::{DelegatedSessionConfig, DelegatedSessionDefConfig};
use kbbl_client::KbblClient;

const STAGE_INSTANCE_ID_SENTINEL: &str = "{{STAGE_INSTANCE_ID}}";

pub struct DelegatedSessionStage {
    pub prompts_dir: PathBuf,
    pub kbbl_client: Arc<KbblClient>,
    pub live_sessions: Arc<Mutex<HashMap<StageInstanceId, ()>>>,
}

impl DelegatedSessionStage {
    pub fn new(prompts_dir: PathBuf, kbbl_client: KbblClient) -> Self {
        Self {
            prompts_dir,
            kbbl_client: Arc::new(kbbl_client),
            live_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl StageType for DelegatedSessionStage {
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
        let sid_str = stage_instance_id.0.to_string();
        let workdir_str = resolve_binding(&def.workdir, inputs, run_context)?
            .replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str);

        let config = DelegatedSessionConfig {
            runtime: def.runtime,
            rendered_prompt,
            workdir: PathBuf::from(workdir_str),
            session_name: def.session_name.replace(STAGE_INSTANCE_ID_SENTINEL, &sid_str),
            model: def.model,
            pre_authorized_tools: def.pre_authorized_tools,
            yolo: def.yolo,
            output_slots: output_slots.to_vec(),
        };

        Ok(serde_json::to_value(config)?)
    }

    async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        anyhow::bail!("delegated_session lifecycle not yet implemented")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delegated_session_stage_id_is_stable() {
        let stage = DelegatedSessionStage::new(
            PathBuf::from("/tmp"),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );
        assert_eq!(stage.id(), "delegated_session");
    }

    #[tokio::test]
    async fn build_config_substitutes_stage_instance_and_carries_outputs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("delegated.md"),
            "Task {{TASK}} for {{STAGE_INSTANCE_ID}}",
        )
        .unwrap();

        let stage = DelegatedSessionStage::new(
            dir.path().to_path_buf(),
            KbblClient::new("http://127.0.0.1:8080/").unwrap(),
        );

        let def_config = json!({
            "runtime": "codex",
            "prompt_template_path": "delegated.md",
            "slot_bindings": {
                "TASK": {"from": "literal", "value": "build"}
            },
            "workdir": {"from": "literal", "value": "/work/{{STAGE_INSTANCE_ID}}"},
            "session_name": "session-{{STAGE_INSTANCE_ID}}",
            "model": "gpt-4.1",
            "pre_authorized_tools": ["Bash"],
            "yolo": true
        });
        let stage_instance_id = StageInstanceId(uuid::Uuid::parse_str(
            "00000000-0000-0000-0000-000000000042",
        )
        .unwrap());
        let output_slots = vec![OutputSlot {
            name: "out".into(),
            artifact_type: "text".into(),
        }];

        let config = stage
            .build_config(&def_config, &HashMap::new(), &output_slots, stage_instance_id, &json!({}))
            .await
            .unwrap();

        let cfg: DelegatedSessionConfig = serde_json::from_value(config).unwrap();
        assert_eq!(cfg.runtime, config::DelegatedRuntime::Codex);
        assert!(cfg.rendered_prompt.contains("build"));
        assert!(cfg.rendered_prompt.contains("00000000-0000-0000-0000-000000000042"));
        assert_eq!(
            cfg.workdir,
            PathBuf::from("/work/00000000-0000-0000-0000-000000000042")
        );
        assert_eq!(
            cfg.session_name,
            "session-00000000-0000-0000-0000-000000000042"
        );
        assert_eq!(cfg.output_slots, output_slots);
        assert_eq!(cfg.pre_authorized_tools, vec!["Bash".to_string()]);
        assert!(cfg.yolo);
    }
}
