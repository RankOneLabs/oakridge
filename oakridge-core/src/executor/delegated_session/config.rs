use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::executor::prompt_config::SlotBinding;
use crate::types::OutputSlot;

// ── Bindable ──────────────────────────────────────────────────────────────────

/// A field that may be either a bare string literal or a SlotBinding resolved
/// at build_config time. Untagged so that existing literal JSON strings remain
/// valid without a wrapper object.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(untagged)]
pub enum Bindable {
    Literal(String),
    Bound(SlotBinding),
}

// ── Valid effort levels accepted by oakridge-core ─────────────────────────────

/// Canonical effort values that workflow definitions may specify for a
/// delegated session. kbbl validates the value against the chosen runtime's
/// declared effort levels; oakridge-core only enforces that a workflow author
/// hasn't used an unsupported string. Values map across runtimes (e.g.
/// "medium" is valid for both codex and claude-code).
pub const VALID_EFFORT_VALUES: &[&str] = &["minimal", "low", "medium", "high"];

pub fn validate_effort(effort: &str) -> bool {
    VALID_EFFORT_VALUES.contains(&effort)
}

// ── WorktreeIdentity ──────────────────────────────────────────────────────────

/// Managed worktree parameters forwarded verbatim to kbbl POST /sessions.
/// Matches the kbbl worktree body shape so serde produces the correct JSON.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeIdentity {
    pub branch_name: String,
    pub worktree_subdir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
}

// ── WorktreeTemplate ──────────────────────────────────────────────────────────

/// Per-unit worktree template; {{UNIT_ID}} and {{STAGE_INSTANCE_ID}} are substituted.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorktreeTemplate {
    pub branch_name: String,
    pub worktree_subdir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
}

// ── FanOut ────────────────────────────────────────────────────────────────────

/// Fan-out configuration for multi-unit stages. When present, the stage spawns
/// one kbbl session per item in the resolved array. Absent → N=1 implicit unit.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FanOut {
    /// Binding that resolves to a JSON array of items. Each item becomes a unit.
    pub over: SlotBinding,
    /// RFC-6901 pointer into each item to extract the unit_id (must be a string).
    pub unit_id_path: String,
    /// Optional RFC-6901 pointer to extract depends_on array; absent = fully parallel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on_path: Option<String>,
    /// Max concurrent units (also bounded by kbbl capacity).
    #[serde(default = "default_max_parallel")]
    pub max_parallel: usize,
    /// Per-unit prompt slot bindings sourced from the item.
    #[serde(default)]
    pub item_bindings: std::collections::HashMap<String, SlotBinding>,
    /// Worktree template; {{UNIT_ID}} and {{STAGE_INSTANCE_ID}} are substituted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeTemplate>,
}

fn default_max_parallel() -> usize {
    8
}

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
    /// Model identifier or a SlotBinding resolved from run context at build time.
    /// Omit to use the runtime default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Bindable>,
    /// Reasoning effort level or a SlotBinding resolved from run context at build
    /// time. Accepted literal values: minimal, low, medium, high. Omit to use the
    /// runtime default. Literal values are validated at def creation; bound values
    /// are validated at build_config time against the resolved string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Bindable>,
    /// Managed worktree parameters forwarded to kbbl POST /sessions. When set,
    /// kbbl creates a branch-isolated worktree instead of running under workdir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeIdentity>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
    /// Fan-out configuration. When present the stage spawns one kbbl session per
    /// item in the resolved array. When absent the stage runs a single implicit
    /// unit (unit_id="0") preserving today's single-session behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan_out: Option<FanOut>,
    /// The output slot whose emit triggers the approval gate and parks the unit.
    /// When absent, defaults to the first declared output slot. Auxiliary outputs
    /// (those not named here) are stored as artifacts without parking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_output: Option<String>,
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
    /// Lossless prompt state retained for deferred fan-out unit rendering.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fan_out_prompt_plan: Option<FanOutPromptPlan>,
    /// The value selected by `fan_out.over` while activation inputs are still
    /// available.  Execute later uses this persisted value to materialize the
    /// complete unit graph before admitting any session.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub resolved_fan_out_over: Option<serde_json::Value>,
    pub workdir: PathBuf,
    pub session_name: String,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeIdentity>,
    #[serde(default)]
    pub pre_authorized_tools: Vec<String>,
    #[serde(default)]
    pub yolo: bool,
    pub output_slots: Vec<OutputSlot>,
    /// Fan-out carried from the def config. `None` = N=1 implicit unit (current
    /// default). When `Some`, `execute` rejects with "not yet implemented" until
    /// Phase 2b wires the per-unit session scheduler. Carrying it through to the
    /// built config ensures the field is round-trippable and visible at execute time.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fan_out: Option<FanOut>,
    /// Resolved gate_output from the def config. Determines which output slot parks
    /// the unit; auxiliary slots store artifacts without changing stage status.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gate_output: Option<String>,
}

/// Prompt material that cannot be recovered from a rendered fan-out prompt.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FanOutPromptPlan {
    pub raw_template: String,
    pub base_slot_values: HashMap<String, String>,
    /// Prompt bindings sourced from the same per-unit collection used by
    /// `fan_out.over`. They are resolved against the matching unit envelope at
    /// admission time so inherited consumers see only their own artifact.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub inherited_input_bindings: HashMap<String, InheritedInputBinding>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct InheritedInputBinding {
    /// RFC-6901 pointer into the matching producer artifact body. `None`
    /// selects the whole artifact body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
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
            workdir: SlotBinding::Literal {
                value: "/work".into(),
            },
            session_name: "delegate-1".into(),
            model: Some(Bindable::Literal("claude-sonnet-4-6".into())),
            effort: None,
            worktree: None,
            pre_authorized_tools: vec!["Bash".into()],
            yolo: false,
            fan_out: None,
            gate_output: None,
        };

        let value = serde_json::to_value(&def).unwrap();
        let back: DelegatedSessionDefConfig = serde_json::from_value(value).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn bindable_literal_serde_is_plain_string() {
        let b = Bindable::Literal("claude-sonnet-4-6".into());
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v, serde_json::json!("claude-sonnet-4-6"));
        let back: Bindable = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn bindable_bound_serde_is_slot_binding() {
        let b = Bindable::Bound(SlotBinding::Context {
            path: "/planner_model".into(),
        });
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "context");
        assert_eq!(v["path"], "/planner_model");
        let back: Bindable = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn bindable_null_model_parses_as_none() {
        let json = serde_json::json!({
            "runtime": "codex",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s",
            "model": null,
            "pre_authorized_tools": [],
            "yolo": false
        });
        let def: DelegatedSessionDefConfig = serde_json::from_value(json).unwrap();
        assert_eq!(def.model, None);
    }

    #[test]
    fn delegated_session_config_roundtrip() {
        let cfg = DelegatedSessionConfig {
            runtime: DelegatedRuntime::Codex,
            rendered_prompt: "do the thing".into(),
            fan_out_prompt_plan: None,
            resolved_fan_out_over: None,
            workdir: PathBuf::from("/workspace/abc"),
            session_name: "s1".into(),
            model: None,
            effort: None,
            worktree: None,
            pre_authorized_tools: vec![],
            yolo: true,
            output_slots: vec![OutputSlot {
                name: "out".into(),
                artifact_type: "text".into(),
            }],
            fan_out: None,
            gate_output: None,
        };

        let value = serde_json::to_value(&cfg).unwrap();
        let back: DelegatedSessionConfig = serde_json::from_value(value).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn fan_out_roundtrip() {
        let fan_out = FanOut {
            over: SlotBinding::Input {
                input_name: "items".into(),
                path: None,
            },
            unit_id_path: "/id".into(),
            depends_on_path: Some("/depends_on".into()),
            max_parallel: 4,
            item_bindings: {
                let mut m = std::collections::HashMap::new();
                m.insert(
                    "ITEM_NAME".to_owned(),
                    SlotBinding::Item {
                        path: "/name".into(),
                    },
                );
                m
            },
            worktree: Some(WorktreeTemplate {
                branch_name: "cohort/{{UNIT_ID}}".into(),
                worktree_subdir: "wt/{{UNIT_ID}}".into(),
                base_ref: Some("main".into()),
            }),
        };
        let v = serde_json::to_value(&fan_out).unwrap();
        let back: FanOut = serde_json::from_value(v).unwrap();
        assert_eq!(fan_out, back);
    }

    #[test]
    fn fan_out_default_max_parallel_is_8() {
        let json = serde_json::json!({
            "over": {"from": "input", "input_name": "items"},
            "unit_id_path": "/id"
        });
        let fan_out: FanOut = serde_json::from_value(json).unwrap();
        assert_eq!(fan_out.max_parallel, 8);
        assert!(fan_out.depends_on_path.is_none());
        assert!(fan_out.item_bindings.is_empty());
        assert!(fan_out.worktree.is_none());
    }

    #[test]
    fn def_config_with_fan_out_roundtrip() {
        let json = serde_json::json!({
            "runtime": "codex",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s",
            "pre_authorized_tools": [],
            "yolo": false,
            "fan_out": {
                "over": {"from": "input", "input_name": "items"},
                "unit_id_path": "/id",
                "max_parallel": 2
            }
        });
        let def: DelegatedSessionDefConfig = serde_json::from_value(json).unwrap();
        assert!(def.fan_out.is_some());
        let fo = def.fan_out.as_ref().unwrap();
        assert_eq!(fo.max_parallel, 2);
        assert_eq!(fo.unit_id_path, "/id");

        let v = serde_json::to_value(&def).unwrap();
        let back: DelegatedSessionDefConfig = serde_json::from_value(v).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn def_config_without_fan_out_omits_field() {
        let json = serde_json::json!({
            "runtime": "codex",
            "prompt_template_path": "t.md",
            "slot_bindings": {},
            "workdir": {"from": "literal", "value": "/w"},
            "session_name": "s",
            "pre_authorized_tools": [],
            "yolo": false
        });
        let def: DelegatedSessionDefConfig = serde_json::from_value(json).unwrap();
        assert!(def.fan_out.is_none());
        let v = serde_json::to_value(&def).unwrap();
        assert!(v.get("fan_out").is_none());
    }
}
