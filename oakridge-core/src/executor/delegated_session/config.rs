use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::executor::prompt_config::SlotBinding;
use crate::types::OutputSlot;

// ── DelegatedRuntime ──────────────────────────────────────────────────────────

/// Runtime target for delegated session execution.
///
/// Serialized strings intentionally match kbbl's runtime contract exactly.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DelegatedRuntime {
    ClaudeCode,
    Codex,
}

// ── DelegatedSessionDefConfig ────────────────────────────────────────────────

/// Definition-time config for delegated sessions.
///
/// `pre_authorized_tools` is present to mirror the future create-time allowlist
/// contract, but it remains inert until kbbl can apply it at session creation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DelegatedSessionDefConfig {
    pub runtime: DelegatedRuntime,
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

// ── DelegatedSessionConfig ───────────────────────────────────────────────────

/// Resolved config for a delegated session stage instance.
///
/// `pre_authorized_tools` is serialized for contract stability but remains inert
/// until downstream kbbl wiring can enforce it at create time.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DelegatedSessionConfig {
    pub runtime: DelegatedRuntime,
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
    use crate::executor::prompt_config::SlotBinding;
    use serde_json::json;

    #[test]
    fn delegated_runtime_serde_mapping() {
        assert_eq!(
            serde_json::to_value(DelegatedRuntime::ClaudeCode).unwrap(),
            json!("claude-code")
        );
        assert_eq!(
            serde_json::to_value(DelegatedRuntime::Codex).unwrap(),
            json!("codex")
        );

        let back: DelegatedRuntime = serde_json::from_value(json!("claude-code")).unwrap();
        assert_eq!(back, DelegatedRuntime::ClaudeCode);
    }

    #[test]
    fn delegated_session_def_config_roundtrip() {
        let mut slot_bindings = HashMap::new();
        slot_bindings.insert(
            "TASK".to_owned(),
            SlotBinding::Literal {
                value: "build the thing".into(),
            },
        );

        let def = DelegatedSessionDefConfig {
            runtime: DelegatedRuntime::ClaudeCode,
            prompt_template_path: "build.md".into(),
            slot_bindings,
            workdir: SlotBinding::Literal { value: "/work".into() },
            session_name: "delegate-1".into(),
            model: Some("claude-sonnet-4-6".into()),
            pre_authorized_tools: vec!["Bash".into()],
            yolo: false,
        };

        let value = serde_json::to_value(&def).unwrap();
        let back: DelegatedSessionDefConfig = serde_json::from_value(value).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn delegated_session_config_roundtrip() {
        let cfg = DelegatedSessionConfig {
            runtime: DelegatedRuntime::Codex,
            rendered_prompt: "do the thing".into(),
            workdir: PathBuf::from("/workspace/abc"),
            session_name: "s1".into(),
            model: None,
            pre_authorized_tools: vec![],
            yolo: true,
            output_slots: vec![OutputSlot {
                name: "out".into(),
                artifact_type: "text".into(),
            }],
        };

        let value = serde_json::to_value(&cfg).unwrap();
        let back: DelegatedSessionConfig = serde_json::from_value(value).unwrap();
        assert_eq!(cfg, back);
    }
}
