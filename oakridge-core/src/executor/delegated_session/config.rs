use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::executor::prompt_config::SlotBinding;
use crate::types::{OutputSlot, StageOperatorRole};

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

// ── Effort is not validated here ──────────────────────────────────────────────
//
// oakridge-core deliberately owns no effort allowlist. Effort levels are
// declared per runtime by each kbbl adapter and published on kbbl's /config
// (claude-code: low..max; codex: minimal..max), so any list here is a copy of
// someone else's contract — and it drifted: it predated "xhigh"/"max" and
// rejected valid runs, while still admitting "minimal" for claude-code, which
// kbbl rejects. Effort is now forwarded verbatim exactly as `model` already is,
// and kbbl validates both against the selected runtime.
//
// Contrast `runtime` (see DelegatedRuntime::parse), which core *does* validate:
// its two values are core's own contract with kbbl, and model validity depends
// on it, so an unresolvable runtime cannot be deferred.

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
    /// Branch to create for the unit. A literal preserves the original template
    /// form; a binding can select repository-specific topology from run context.
    pub branch_name: Bindable,
    pub worktree_subdir: Bindable,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<Bindable>,
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
    /// Require an explicit operator admission before an otherwise eligible unit
    /// may launch. Defaults off so existing workflow definitions remain automatic.
    #[serde(default)]
    pub manual_admission: bool,
    /// Per-unit prompt slot bindings sourced from the item.
    #[serde(default)]
    pub item_bindings: std::collections::HashMap<String, SlotBinding>,
    /// Optional per-unit working-directory binding. It is resolved for every
    /// item at config-build time and persisted, so retries never re-read mutable
    /// run context. When absent, units inherit the stage-level workdir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<SlotBinding>,
    /// Worktree template; {{UNIT_ID}} and {{STAGE_INSTANCE_ID}} are substituted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeTemplate>,
    /// Reuse the completed producer unit's persisted worktree as this unit's
    /// workdir. The value names the unit-complete input that carries provenance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherit_worktree_from: Option<String>,
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

pub const VALID_RUNTIME_VALUES: &[&str] = &["claude-code", "codex"];

impl DelegatedRuntime {
    /// Parse a runtime id supplied as a definition literal or resolved from run
    /// context. Accepts exactly the strings in kbbl's runtime contract; anything
    /// else is a workflow-authoring or launch-payload error, not a default.
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => anyhow::bail!(
                "invalid runtime {:?}: must be one of {:?}",
                other,
                VALID_RUNTIME_VALUES
            ),
        }
    }
}

// ── DelegatedSessionDefConfig ────────────────────────────────────────────────

/// Definition-time config for delegated sessions.
///
/// `pre_authorized_tools` is present to mirror the future create-time allowlist
/// contract, but it remains inert until kbbl can apply it at session creation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DelegatedSessionDefConfig {
    /// Runtime id (`"claude-code"` / `"codex"`) or a SlotBinding resolved from run
    /// context at build time. Unlike model and effort this has no runtime default:
    /// which models are valid depends on it, so an unresolvable binding is an
    /// error rather than a silent fallback.
    pub runtime: Bindable,
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
    /// Output-specific gate policy. This supersedes `gate_output`, which is
    /// retained for loading existing workflow definitions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_gate: Option<OutputGateConfig>,
    /// Output whose emit hands a unit to a correlated downstream operator role
    /// without creating a human gate or marking dependencies complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_handoff: Option<OutputHandoffConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OutputGateConfig {
    pub output: String,
    pub steps: Vec<OutputGateStep>,
    #[serde(default)]
    pub requires_zero_open_review_items: bool,
    #[serde(default)]
    pub revision_target: RevisionTarget,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RevisionTarget {
    #[default]
    SelfStage,
    UpstreamHandoff,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OutputGateStep {
    #[serde(rename = "type")]
    pub gate_type: DelegatedGateKind,
    pub actions: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OutputHandoffConfig {
    pub output: String,
    pub downstream_role: StageOperatorRole,
    pub approved_wait: ExternalWaitDescriptor,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ExternalWaitDescriptor {
    /// Stable workflow-owned external boundary, for example `github_review`.
    pub kind: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DelegatedGateKind {
    ArtifactApproval,
    MergeConfirmation,
}

impl OutputGateConfig {
    pub fn legacy(output: String) -> Self {
        Self {
            output,
            steps: vec![
                OutputGateStep {
                    gate_type: DelegatedGateKind::ArtifactApproval,
                    actions: vec!["approve".into(), "request_revision".into()],
                },
                OutputGateStep {
                    gate_type: DelegatedGateKind::MergeConfirmation,
                    actions: vec!["confirm_merged".into()],
                },
            ],
            requires_zero_open_review_items: true,
            revision_target: RevisionTarget::SelfStage,
        }
    }
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
    /// Workdirs resolved from `fan_out.workdir`, keyed by materialized unit id.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub resolved_fan_out_workdirs: HashMap<String, PathBuf>,
    /// Repository-aware worktree identities resolved while activation inputs and
    /// immutable run context are available. Persisting these keeps retries from
    /// silently selecting a different base branch.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub resolved_fan_out_worktrees: HashMap<String, WorktreeIdentity>,
    /// Immutable run context retained for bindings on units delivered after activation.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub fan_out_context: serde_json::Value,
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
    /// Fan-out carried from the def config. `None` selects the implicit N=1 unit;
    /// `Some` materializes and schedules one durable session unit per selected item.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fan_out: Option<FanOut>,
    /// Resolved gate_output from the def config. Determines which output slot parks
    /// the unit; auxiliary slots store artifacts without changing stage status.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gate_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_gate: Option<OutputGateConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_handoff: Option<OutputHandoffConfig>,
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
            runtime: Bindable::Literal("claude-code".into()),
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
            output_gate: None,
            output_handoff: None,
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
            resolved_fan_out_workdirs: HashMap::new(),
            resolved_fan_out_worktrees: HashMap::new(),
            fan_out_context: serde_json::Value::Null,
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
            output_gate: None,
            output_handoff: None,
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
            manual_admission: false,
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
            workdir: None,
            worktree: Some(WorktreeTemplate {
                branch_name: Bindable::Literal("cohort/{{UNIT_ID}}".into()),
                worktree_subdir: Bindable::Literal("wt/{{UNIT_ID}}".into()),
                base_ref: Some(Bindable::Literal("main".into())),
            }),
            inherit_worktree_from: None,
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
        assert!(!fan_out.manual_admission);
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
