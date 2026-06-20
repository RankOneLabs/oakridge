use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::types::OutputSlot;
use crate::executor::prompt_config::SlotBinding;

// ── SessionBackend ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionBackend {
    ClaudeCode,
    /// Defined for serde stability; subprocess wiring lands in a future cohort.
    Codex,
}

// ── SessionAgentDefConfig ─────────────────────────────────────────────────────

/// Definition-time config; lives in `workflow_def.graph` as the stage's config.
/// Deserialized from `def_config` inside `build_config`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionAgentDefConfig {
    pub backend: SessionBackend,
    pub prompt_template_path: String,
    pub slot_bindings: HashMap<String, SlotBinding>,
    pub workdir: SlotBinding,
    pub session_name: String,
    pub model: Option<String>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
}

// ── SessionAgentConfig ────────────────────────────────────────────────────────

/// Resolved config persisted as `stage_instance.config`; received by `execute`.
///
/// All values are fully resolved so crash recovery can replay without re-rendering.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionAgentConfig {
    pub backend: SessionBackend,
    pub rendered_prompt: String,
    pub workdir: PathBuf,
    pub session_name: String,
    pub model: Option<String>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
    pub output_slots: Vec<OutputSlot>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn session_backend_snake_case() {
        assert_eq!(
            serde_json::to_value(SessionBackend::ClaudeCode).unwrap(),
            json!("claude_code")
        );
        assert_eq!(
            serde_json::to_value(SessionBackend::Codex).unwrap(),
            json!("codex")
        );
    }

    // ── SessionAgentDefConfig / SessionAgentConfig roundtrip ─────────────────

    #[test]
    fn session_agent_def_config_roundtrip() {
        let mut slot_bindings = HashMap::new();
        slot_bindings.insert("SPEC".to_owned(), SlotBinding::Literal { value: "val".into() });
        let def = SessionAgentDefConfig {
            backend: SessionBackend::ClaudeCode,
            prompt_template_path: "build.md".into(),
            slot_bindings,
            workdir: SlotBinding::Literal { value: "/work".into() },
            session_name: "test-session".into(),
            model: Some("claude-sonnet-4-6".into()),
            pre_authorized_tools: vec!["Bash".into()],
            yolo: false,
        };
        let v = serde_json::to_value(&def).unwrap();
        let back: SessionAgentDefConfig = serde_json::from_value(v).unwrap();
        assert_eq!(def.backend, back.backend);
        assert_eq!(def.session_name, back.session_name);
        assert_eq!(def.model, back.model);
    }

    #[test]
    fn session_agent_config_roundtrip() {
        let cfg = SessionAgentConfig {
            backend: SessionBackend::ClaudeCode,
            rendered_prompt: "do the thing".into(),
            workdir: PathBuf::from("/workspace/abc"),
            session_name: "s1".into(),
            model: None,
            pre_authorized_tools: vec![],
            yolo: true,
            output_slots: vec![OutputSlot { name: "out".into(), artifact_type: "text".into() }],
        };
        let v = serde_json::to_value(&cfg).unwrap();
        let back: SessionAgentConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.workdir, back.workdir);
        assert_eq!(cfg.session_name, back.session_name);
        assert_eq!(cfg.yolo, back.yolo);
        assert_eq!(cfg.output_slots.len(), 1);
    }
}
