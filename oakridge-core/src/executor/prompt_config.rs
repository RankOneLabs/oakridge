use std::collections::HashMap;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::ResolvedInput;

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
    /// Resolve from the per-unit params blob via an RFC-6901 pointer.
    /// Only valid inside a FanOut.item_bindings block; errors if unit_params is None.
    Item { path: String },
}

// ── resolve_binding ───────────────────────────────────────────────────────────

pub fn resolve_binding(
    binding: &SlotBinding,
    inputs: &HashMap<String, ResolvedInput>,
    run_context: &Value,
    unit_params: Option<&Value>,
) -> anyhow::Result<String> {
    match binding {
        SlotBinding::Literal { value } => Ok(value.clone()),
        SlotBinding::Input { input_name, path } => {
            let input = inputs.get(input_name).ok_or_else(|| {
                anyhow::anyhow!("input '{}' not found in activation inputs", input_name)
            })?;
            let input_value = input.to_binding_value();
            let v = match path {
                None => &input_value,
                Some(ptr) => input_value.pointer(ptr).ok_or_else(|| {
                    anyhow::anyhow!("JSON pointer '{}' not found in input '{}'", ptr, input_name)
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
        SlotBinding::Item { path } => {
            let params = unit_params.ok_or_else(|| {
                anyhow::anyhow!(
                    "SlotBinding::Item used outside of a FanOut context (unit_params is None)"
                )
            })?;
            let v = params.pointer(path).ok_or_else(|| {
                anyhow::anyhow!("JSON pointer '{}' not found in unit params", path)
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

/// Resolve a slot binding for optional model/effort fields, yielding `Ok(None)`
/// when the bound context key is absent or null (lenient — falls back to the
/// runtime default). `Input`/`Item` bindings are not valid for model/effort and
/// are rejected rather than silently coerced to `None`, so a misconfigured def
/// fails workflow construction instead of quietly using the default.
pub fn resolve_optional_binding(
    binding: &SlotBinding,
    run_context: &Value,
) -> anyhow::Result<Option<String>> {
    match binding {
        SlotBinding::Literal { value } => Ok(Some(value.clone())),
        SlotBinding::Context { path } => {
            let Some(v) = run_context.pointer(path) else {
                return Ok(None);
            };
            if v.is_null() {
                return Ok(None);
            }
            Ok(value_to_string(v).ok())
        }
        SlotBinding::Input { .. } | SlotBinding::Item { .. } => anyhow::bail!(
            "model/effort binding must be a literal or a context binding; \
             input/item bindings are not supported here"
        ),
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
        let close = after_open
            .find("}}")
            .ok_or_else(|| anyhow::anyhow!("unclosed '{{{{' in prompt template"))?;
        let key = &after_open[..close];
        let value = slot_values
            .get(key)
            .ok_or_else(|| anyhow::anyhow!("template slot '{{{{{}}}}}' has no binding", key))?;
        result.push_str(value);
        remaining = &after_open[close + 2..];
    }

    result.push_str(remaining);
    Ok(result)
}

// ── load_template ─────────────────────────────────────────────────────────────

pub fn load_template(prompts_dir: &Path, rel_path: &str) -> anyhow::Result<String> {
    let rel_path = validate_relative_template_path(rel_path)?;
    let canonical_prompts_dir = std::fs::canonicalize(prompts_dir).map_err(|e| {
        anyhow::anyhow!(
            "failed to resolve prompts directory '{}': {}",
            prompts_dir.display(),
            e
        )
    })?;
    let path = prompts_dir.join(rel_path);
    let canonical_path = std::fs::canonicalize(&path)
        .map_err(|e| anyhow::anyhow!("failed to load template '{}': {}", path.display(), e))?;
    if !canonical_path.starts_with(&canonical_prompts_dir) {
        return Err(anyhow::anyhow!(
            "template path '{}' escapes prompts directory '{}'",
            path.display(),
            prompts_dir.display()
        ));
    }
    std::fs::read_to_string(&canonical_path).map_err(|e| {
        anyhow::anyhow!(
            "failed to load template '{}': {}",
            canonical_path.display(),
            e
        )
    })
}

fn validate_relative_template_path(rel_path: &str) -> anyhow::Result<&Path> {
    let path = Path::new(rel_path);
    if path.is_absolute() {
        return Err(anyhow::anyhow!(
            "template path must be relative to the prompts directory"
        ));
    }

    for component in path.components() {
        match component {
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(anyhow::anyhow!(
                    "template path must not escape the prompts directory"
                ));
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }

    Ok(path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Artifact, ArtifactId, StageInstanceId, WorkflowRunId};
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

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
        let b = SlotBinding::Input {
            input_name: "doc".into(),
            path: None,
        };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "input");
        assert!(v.get("path").is_none() || v["path"].is_null());
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn slot_binding_context_roundtrip() {
        let b = SlotBinding::Context {
            path: "/project_id".into(),
        };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "context");
        assert_eq!(v["path"], "/project_id");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn slot_binding_literal_roundtrip() {
        let b = SlotBinding::Literal {
            value: "hello world".into(),
        };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "literal");
        assert_eq!(v["value"], "hello world");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    // ── resolve_binding ───────────────────────────────────────────────────────

    #[test]
    fn resolve_literal() {
        let b = SlotBinding::Literal {
            value: "abc".into(),
        };
        let res = resolve_binding(&b, &HashMap::new(), &json!({}), None).unwrap();
        assert_eq!(res, "abc");
    }

    #[test]
    fn resolve_input_whole_body_string() {
        let artifact = make_artifact(json!("the content"));
        let mut inputs = HashMap::new();
        inputs.insert("doc".into(), ResolvedInput::Single(artifact));
        let b = SlotBinding::Input {
            input_name: "doc".into(),
            path: None,
        };
        let res = resolve_binding(&b, &inputs, &json!({}), None).unwrap();
        assert_eq!(res, "the content");
    }

    #[test]
    fn resolve_collection_input_uses_ordered_provenance_envelopes() {
        let mut artifacts = std::collections::BTreeMap::new();
        artifacts.insert("b".into(), make_artifact(json!({"value": 2})));
        artifacts.insert("a".into(), make_artifact(json!({"value": 1})));
        let mut inputs = HashMap::new();
        inputs.insert("items".into(), ResolvedInput::Collection(artifacts));
        let binding = SlotBinding::Input {
            input_name: "items".into(),
            path: None,
        };

        let resolved = resolve_binding(&binding, &inputs, &json!({}), None).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&resolved).unwrap(),
            json!([
                {"unit_id": "a", "artifact": {"value": 1}},
                {"unit_id": "b", "artifact": {"value": 2}}
            ])
        );
    }

    #[test]
    fn resolve_input_pointer() {
        let artifact = make_artifact(json!({"notes": "my notes"}));
        let mut inputs = HashMap::new();
        inputs.insert("spec".into(), ResolvedInput::Single(artifact));
        let b = SlotBinding::Input {
            input_name: "spec".into(),
            path: Some("/notes".into()),
        };
        let res = resolve_binding(&b, &inputs, &json!({}), None).unwrap();
        assert_eq!(res, "my notes");
    }

    #[test]
    fn resolve_input_missing_returns_err() {
        let b = SlotBinding::Input {
            input_name: "missing".into(),
            path: None,
        };
        assert!(resolve_binding(&b, &HashMap::new(), &json!({}), None).is_err());
    }

    #[test]
    fn resolve_input_bad_pointer_returns_err() {
        let artifact = make_artifact(json!({"x": 1}));
        let mut inputs = HashMap::new();
        inputs.insert("a".into(), ResolvedInput::Single(artifact));
        let b = SlotBinding::Input {
            input_name: "a".into(),
            path: Some("/missing_field".into()),
        };
        assert!(resolve_binding(&b, &inputs, &json!({}), None).is_err());
    }

    #[test]
    fn resolve_context_pointer() {
        let ctx = json!({"project_id": "proj-123"});
        let b = SlotBinding::Context {
            path: "/project_id".into(),
        };
        let res = resolve_binding(&b, &HashMap::new(), &ctx, None).unwrap();
        assert_eq!(res, "proj-123");
    }

    #[test]
    fn resolve_context_bad_pointer_returns_err() {
        let b = SlotBinding::Context {
            path: "/missing".into(),
        };
        assert!(resolve_binding(&b, &HashMap::new(), &json!({}), None).is_err());
    }

    // ── SlotBinding::Item ─────────────────────────────────────────────────────

    #[test]
    fn slot_binding_item_roundtrip() {
        let b = SlotBinding::Item {
            path: "/title".into(),
        };
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["from"], "item");
        assert_eq!(v["path"], "/title");
        let back: SlotBinding = serde_json::from_value(v).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn resolve_item_with_params() {
        let b = SlotBinding::Item {
            path: "/name".into(),
        };
        let params = json!({"name": "widget-42"});
        let res = resolve_binding(&b, &HashMap::new(), &json!({}), Some(&params)).unwrap();
        assert_eq!(res, "widget-42");
    }

    #[test]
    fn resolve_item_missing_path_returns_err() {
        let b = SlotBinding::Item {
            path: "/missing".into(),
        };
        let params = json!({"name": "widget-42"});
        assert!(resolve_binding(&b, &HashMap::new(), &json!({}), Some(&params)).is_err());
    }

    #[test]
    fn resolve_item_without_params_returns_err() {
        let b = SlotBinding::Item {
            path: "/name".into(),
        };
        assert!(resolve_binding(&b, &HashMap::new(), &json!({}), None).is_err());
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

    #[test]
    fn load_template_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let res = load_template(dir.path(), "../secrets.md");
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("prompts directory"));
    }

    #[test]
    fn load_template_rejects_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let res = load_template(dir.path(), "/etc/passwd");
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("relative"));
    }

    #[cfg(unix)]
    #[test]
    fn load_template_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir(&prompts_dir).unwrap();

        let outside = dir.path().join("outside.md");
        std::fs::write(&outside, "secret").unwrap();
        symlink(&outside, prompts_dir.join("leak.md")).unwrap();

        let res = load_template(&prompts_dir, "leak.md");
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("escapes prompts directory"));
    }
}
