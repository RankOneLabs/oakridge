use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::types::{Artifact, OutputSlot};

// ── SessionBackend ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionBackend {
    ClaudeCode,
    /// Defined for serde stability; subprocess wiring lands in a future cohort.
    Codex,
}

// ── SlotBinding ───────────────────────────────────────────────────────────────

/// Where a prompt slot's value comes from at activation time.
///
/// `path` fields are RFC-6901 JSON pointers into the referenced body.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum SlotBinding {
    /// Resolve from a named input artifact's body (optional pointer into the body).
    Input {
        input_name: String,
        /// RFC-6901 pointer into the artifact body; None means the entire body.
        path: Option<String>,
    },
    /// Resolve from the workflow run context via an RFC-6901 pointer.
    Context { path: String },
    /// A static string value.
    Literal { value: String },
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

// ── resolve_binding ───────────────────────────────────────────────────────────

pub fn resolve_binding(
    binding: &SlotBinding,
    inputs: &HashMap<String, Artifact>,
    run_context: &Value,
) -> anyhow::Result<String> {
    match binding {
        SlotBinding::Literal { value } => Ok(value.clone()),
        SlotBinding::Input { input_name, path } => {
            let artifact = inputs.get(input_name).ok_or_else(|| {
                anyhow::anyhow!("input '{}' not found in activation inputs", input_name)
            })?;
            let v = match path {
                None => &artifact.body,
                Some(ptr) => artifact.body.pointer(ptr).ok_or_else(|| {
                    anyhow::anyhow!(
                        "JSON pointer '{}' not found in input '{}'",
                        ptr,
                        input_name
                    )
                })?,
            };
            value_to_string(v)
        }
        SlotBinding::Context { path } => {
            let v = run_context.pointer(path).ok_or_else(|| {
                anyhow::anyhow!("JSON pointer '{}' not found in run context", path)
            })?;
            value_to_string(v)
        }
    }
}

fn value_to_string(v: &Value) -> anyhow::Result<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok("null".to_owned()),
        _ => Ok(v.to_string()),
    }
}

// ── render_template ───────────────────────────────────────────────────────────

/// Replace every `{{KEY}}` in `template` with the corresponding value from
/// `slot_values`.  v1 strictness: any `{{KEY}}` with no entry in `slot_values`
/// is an error — it signals a misconfigured binding, not a missing-optional.
pub fn render_template(
    template: &str,
    slot_values: &HashMap<String, String>,
) -> anyhow::Result<String> {
    let mut result = String::with_capacity(template.len());
    let mut remaining = template;

    while let Some(open) = remaining.find("{{") {
        result.push_str(&remaining[..open]);
        let after_open = &remaining[open + 2..];
        let close = after_open.find("}}").ok_or_else(|| {
            anyhow::anyhow!("unclosed '{{{{' in prompt template")
        })?;
        let key = &after_open[..close];
        let value = slot_values.get(key).ok_or_else(|| {
            anyhow::anyhow!("template slot '{{{{{}}}}}' has no binding", key)
        })?;
        result.push_str(value);
        remaining = &after_open[close + 2..];
    }

    result.push_str(remaining);
    Ok(result)
}

// ── load_template ─────────────────────────────────────────────────────────────

pub fn load_template(prompts_dir: &Path, rel_path: &str) -> anyhow::Result<String> {
    let path = prompts_dir.join(rel_path);
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("failed to load template '{}': {}", path.display(), e))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;
    use chrono::Utc;
    use crate::types::{ArtifactId, StageInstanceId, WorkflowRunId};

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

    // ── SlotBinding serde ─────────────────────────────────────────────────────

    #[test]
    fn slot_binding_input_roundtrip() {
        let b = SlotBinding::Input {
            input_name: "spec".into(),
            path: Some("/notes".into()),
        };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "input");
        assert_eq!(v["input_name"], "spec");
        assert_eq!(v["path"], "/notes");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn slot_binding_input_no_path_roundtrip() {
        let b = SlotBinding::Input { input_name: "doc".into(), path: None };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "input");
        assert!(v.get("path").is_none() || v["path"].is_null());
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn slot_binding_context_roundtrip() {
        let b = SlotBinding::Context { path: "/project_id".into() };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "context");
        assert_eq!(v["path"], "/project_id");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn slot_binding_literal_roundtrip() {
        let b = SlotBinding::Literal { value: "hello world".into() };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "literal");
        assert_eq!(v["value"], "hello world");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

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

    // ── resolve_binding ───────────────────────────────────────────────────────

    #[test]
    fn resolve_literal() {
        let b = SlotBinding::Literal { value: "abc".into() };
        let res = resolve_binding(&b, &HashMap::new(), &json!({})).unwrap();
        assert_eq!(res, "abc");
    }

    #[test]
    fn resolve_input_whole_body_string() {
        let artifact = make_artifact(json!("the content"));
        let mut inputs = HashMap::new();
        inputs.insert("doc".into(), artifact);
        let b = SlotBinding::Input { input_name: "doc".into(), path: None };
        let res = resolve_binding(&b, &inputs, &json!({})).unwrap();
        assert_eq!(res, "the content");
    }

    #[test]
    fn resolve_input_pointer() {
        let artifact = make_artifact(json!({"notes": "my notes"}));
        let mut inputs = HashMap::new();
        inputs.insert("spec".into(), artifact);
        let b = SlotBinding::Input { input_name: "spec".into(), path: Some("/notes".into()) };
        let res = resolve_binding(&b, &inputs, &json!({})).unwrap();
        assert_eq!(res, "my notes");
    }

    #[test]
    fn resolve_input_missing_returns_err() {
        let b = SlotBinding::Input { input_name: "missing".into(), path: None };
        assert!(resolve_binding(&b, &HashMap::new(), &json!({})).is_err());
    }

    #[test]
    fn resolve_input_bad_pointer_returns_err() {
        let artifact = make_artifact(json!({"x": 1}));
        let mut inputs = HashMap::new();
        inputs.insert("a".into(), artifact);
        let b = SlotBinding::Input { input_name: "a".into(), path: Some("/missing_field".into()) };
        assert!(resolve_binding(&b, &inputs, &json!({})).is_err());
    }

    #[test]
    fn resolve_context_pointer() {
        let ctx = json!({"project_id": "proj-123"});
        let b = SlotBinding::Context { path: "/project_id".into() };
        let res = resolve_binding(&b, &HashMap::new(), &ctx).unwrap();
        assert_eq!(res, "proj-123");
    }

    #[test]
    fn resolve_context_bad_pointer_returns_err() {
        let b = SlotBinding::Context { path: "/missing".into() };
        assert!(resolve_binding(&b, &HashMap::new(), &json!({})).is_err());
    }

    // ── render_template ───────────────────────────────────────────────────────

    #[test]
    fn render_template_substitutes_all_slots() {
        let mut vals = HashMap::new();
        vals.insert("NAME".into(), "Alice".into());
        vals.insert("TASK".into(), "review".into());
        let out = render_template("Hello {{NAME}}, please do {{TASK}}.", &vals).unwrap();
        assert_eq!(out, "Hello Alice, please do review.");
    }

    #[test]
    fn render_template_repeated_slot() {
        let mut vals = HashMap::new();
        vals.insert("X".into(), "foo".into());
        let out = render_template("{{X}} and {{X}}", &vals).unwrap();
        assert_eq!(out, "foo and foo");
    }

    #[test]
    fn render_template_no_slots() {
        let vals: HashMap<String, String> = HashMap::new();
        let out = render_template("no slots here", &vals).unwrap();
        assert_eq!(out, "no slots here");
    }

    #[test]
    fn render_template_unfilled_slot_errors() {
        let vals: HashMap<String, String> = HashMap::new();
        let res = render_template("Hello {{NAME}}", &vals);
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("NAME"));
    }

    #[test]
    fn render_template_unclosed_brace_errors() {
        let vals: HashMap<String, String> = HashMap::new();
        let res = render_template("Hello {{NAME", &vals);
        assert!(res.is_err());
    }

    // ── load_template ─────────────────────────────────────────────────────────

    #[test]
    fn load_template_reads_file() {
        let dir = tempfile::tempdir().unwrap();
        let content = "Hello {{WORLD}}";
        std::fs::write(dir.path().join("t.md"), content).unwrap();
        let loaded = load_template(dir.path(), "t.md").unwrap();
        assert_eq!(loaded, content);
    }

    #[test]
    fn load_template_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let res = load_template(dir.path(), "nope.md");
        assert!(res.is_err());
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
