use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::executor::prompt_config::{resolve_binding, SlotBinding};
use crate::types::OutputSlot;

/// JSON-preserving binding for structured legit-biz-club run-spec fields.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum JsonBinding {
    Input {
        input_name: String,
        path: Option<String>,
    },
    Context {
        path: String,
    },
    Literal {
        value: Value,
    },
}

/// Definition-time config for delegated legit-biz-club runs.
///
/// `task` and path-like fields reuse the existing string binding surface.
/// Structured run-spec payloads use `JsonBinding` so JSON values stay JSON
/// until the resolved config is serialized.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegatedLbcRunDefConfig {
    pub task: SlotBinding,
    pub model_pool: JsonBinding,
    pub condition: JsonBinding,
    #[serde(default)]
    pub grade: Option<JsonBinding>,
    #[serde(default)]
    pub grader: Option<JsonBinding>,
    #[serde(default)]
    pub local_task_dir: Option<SlotBinding>,
    #[serde(default)]
    pub local_grader_config_dir: Option<SlotBinding>,
    #[serde(default)]
    pub output_dir: Option<SlotBinding>,
    #[serde(default)]
    pub bridge_command: Option<String>,
    #[serde(default)]
    pub bridge_args: Option<Vec<String>>,
    #[serde(default = "default_result_output_slot")]
    pub result_output_slot: String,
}

/// Resolved legit-biz-club condition spec.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegatedLbcRunCondition {
    pub kind: String,
    pub n: u32,
}

/// Resolved legit-biz-club grader ref.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DelegatedLbcRunGraderRef {
    Registered {
        key: String,
        #[serde(default)]
        config: Option<Value>,
    },
    LocalConfig {
        name: String,
    },
}

/// Resolved run-spec passed to the delegated legit-biz-club bridge.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegatedLbcRunSpec {
    pub task: String,
    pub model_pool: Vec<String>,
    pub condition: DelegatedLbcRunCondition,
    pub grade: bool,
    #[serde(default)]
    pub grader: Option<DelegatedLbcRunGraderRef>,
    #[serde(default)]
    pub local_task_dir: Option<PathBuf>,
    #[serde(default)]
    pub local_grader_config_dir: Option<PathBuf>,
}

/// Resolved runtime config for the delegated legit-biz-club stage.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegatedLbcRunConfig {
    pub run_spec: DelegatedLbcRunSpec,
    pub output_dir: PathBuf,
    pub bridge_command: String,
    pub bridge_args: Vec<String>,
    pub result_output_slot: OutputSlot,
}

pub fn resolve_json_binding(
    binding: &JsonBinding,
    inputs: &HashMap<String, crate::types::Artifact>,
    run_context: &Value,
) -> anyhow::Result<Value> {
    match binding {
        JsonBinding::Literal { value } => Ok(value.clone()),
        JsonBinding::Input { input_name, path } => {
            let artifact = inputs.get(input_name).ok_or_else(|| {
                anyhow::anyhow!("input '{}' not found in activation inputs", input_name)
            })?;
            match path {
                None => Ok(artifact.body.clone()),
                Some(ptr) => artifact.body.pointer(ptr).cloned().ok_or_else(|| {
                    anyhow::anyhow!("JSON pointer '{}' not found in input '{}'", ptr, input_name)
                }),
            }
        }
        JsonBinding::Context { path } => run_context
            .pointer(path)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("JSON pointer '{}' not found in run context", path)),
    }
}

pub fn default_result_output_slot() -> String {
    "result".to_owned()
}

pub fn resolve_run_spec(
    def: &DelegatedLbcRunDefConfig,
    inputs: &HashMap<String, crate::types::Artifact>,
    run_context: &Value,
) -> anyhow::Result<DelegatedLbcRunSpec> {
    let task = resolve_binding(&def.task, inputs, run_context, None)?;
    let model_pool_value = resolve_json_binding(&def.model_pool, inputs, run_context)?;
    let condition_value = resolve_json_binding(&def.condition, inputs, run_context)?;
    let grade_value = match &def.grade {
        Some(binding) => Some(resolve_json_binding(binding, inputs, run_context)?),
        None => None,
    };
    let grader_value = match &def.grader {
        Some(binding) => Some(resolve_json_binding(binding, inputs, run_context)?),
        None => None,
    };

    let model_pool: Vec<String> = serde_json::from_value(model_pool_value)?;
    validate_model_pool(&model_pool)?;

    let condition = parse_condition(condition_value)?;
    let grade = match grade_value {
        Some(value) => serde_json::from_value::<bool>(value)?,
        None => true,
    };
    let grader = match grader_value {
        Some(value) => Some(parse_grader_ref(value)?),
        None => None,
    };

    let local_task_dir = def
        .local_task_dir
        .as_ref()
        .map(|binding| resolve_binding(binding, inputs, run_context, None).map(PathBuf::from))
        .transpose()?;
    let local_grader_config_dir = def
        .local_grader_config_dir
        .as_ref()
        .map(|binding| resolve_binding(binding, inputs, run_context, None).map(PathBuf::from))
        .transpose()?;

    Ok(DelegatedLbcRunSpec {
        task,
        model_pool,
        condition,
        grade,
        grader,
        local_task_dir,
        local_grader_config_dir,
    })
}

pub fn resolve_output_dir(
    def: &DelegatedLbcRunDefConfig,
    inputs: &HashMap<String, crate::types::Artifact>,
    run_context: &Value,
) -> anyhow::Result<PathBuf> {
    let output_dir = match &def.output_dir {
        Some(binding) => resolve_binding(binding, inputs, run_context, None)?,
        None => resolve_binding(
            &SlotBinding::Context {
                path: "/workdir".to_owned(),
            },
            inputs,
            run_context,
            None,
        )?,
    };

    Ok(PathBuf::from(output_dir))
}

pub fn validate_result_output_slot(
    output_slots: &[OutputSlot],
    result_output_slot: &str,
) -> anyhow::Result<OutputSlot> {
    output_slots
        .iter()
        .find(|slot| slot.name == result_output_slot)
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "result output slot '{}' not found in workflow stage outputs",
                result_output_slot
            )
        })
}

pub fn parse_condition(value: Value) -> anyhow::Result<DelegatedLbcRunCondition> {
    let condition: DelegatedLbcRunCondition = serde_json::from_value(value)?;
    if condition.n > 16 {
        anyhow::bail!("condition.n must be in 1..=16, got {}", condition.n);
    }
    match condition.kind.as_str() {
        "single_agent" if condition.n != 1 => {
            anyhow::bail!("single_agent requires n == 1, got {}", condition.n)
        }
        "ensemble_single_round" if condition.n < 2 => {
            anyhow::bail!("ensemble_single_round requires n >= 2, got {}", condition.n)
        }
        "ensemble_multi_round" if condition.n < 2 => {
            anyhow::bail!("ensemble_multi_round requires n >= 2, got {}", condition.n)
        }
        "ensemble_incremental" if condition.n < 1 => {
            anyhow::bail!("ensemble_incremental requires n >= 1, got {}", condition.n)
        }
        "single_agent"
        | "ensemble_single_round"
        | "ensemble_multi_round"
        | "ensemble_incremental" => Ok(condition),
        other => anyhow::bail!("unknown condition.kind '{}'", other),
    }
}

pub fn parse_grader_ref(value: Value) -> anyhow::Result<DelegatedLbcRunGraderRef> {
    let grader: DelegatedLbcRunGraderRef = serde_json::from_value(value)?;
    validate_grader_ref(&grader)?;
    Ok(grader)
}

fn validate_model_pool(model_pool: &[String]) -> anyhow::Result<()> {
    if model_pool.is_empty() {
        anyhow::bail!("model_pool must be a non-empty array");
    }
    if model_pool.iter().any(|entry| entry.is_empty()) {
        anyhow::bail!("model_pool entries must be non-empty strings");
    }
    Ok(())
}

fn validate_grader_ref(grader: &DelegatedLbcRunGraderRef) -> anyhow::Result<()> {
    match grader {
        DelegatedLbcRunGraderRef::Registered { key, config } => {
            if key.is_empty() {
                anyhow::bail!("registered grader key must be a non-empty string");
            }
            if let Some(config) = config {
                if !config.is_object() {
                    anyhow::bail!("registered grader config must be a JSON object");
                }
            }
            Ok(())
        }
        DelegatedLbcRunGraderRef::LocalConfig { name } => {
            if !is_snake_case_name(name) {
                anyhow::bail!("local grader config name must be snake_case starting with a letter");
            }
            Ok(())
        }
    }
}

fn is_snake_case_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::prompt_config::SlotBinding;
    use crate::types::{ArtifactId, StageInstanceId, WorkflowRunId};
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    fn artifact(body: Value) -> crate::types::Artifact {
        crate::types::Artifact {
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

    #[test]
    fn json_binding_input_and_context_roundtrip() {
        let binding = JsonBinding::Input {
            input_name: "spec".into(),
            path: Some("/nested".into()),
        };
        let json = serde_json::to_value(&binding).unwrap();
        assert_eq!(json["from"], "input");
        let back: JsonBinding = serde_json::from_value(json).unwrap();
        assert_eq!(binding, back);

        let binding = JsonBinding::Context {
            path: "/run/spec".into(),
        };
        let json = serde_json::to_value(&binding).unwrap();
        assert_eq!(json["from"], "context");
        let back: JsonBinding = serde_json::from_value(json).unwrap();
        assert_eq!(binding, back);
    }

    #[test]
    fn resolve_json_binding_preserves_structured_values() {
        let mut inputs = HashMap::new();
        inputs.insert(
            "spec".into(),
            artifact(json!({"task": "alpha", "flags": [1, 2]})),
        );

        let value = resolve_json_binding(
            &JsonBinding::Input {
                input_name: "spec".into(),
                path: Some("/flags".into()),
            },
            &inputs,
            &json!({}),
        )
        .unwrap();

        assert_eq!(value, json!([1, 2]));
    }

    #[test]
    fn resolve_condition_enforces_known_shape() {
        let condition = parse_condition(json!({ "kind": "single_agent", "n": 1 })).unwrap();
        assert_eq!(condition.kind, "single_agent");
        assert_eq!(condition.n, 1);
        assert!(parse_condition(json!({ "kind": "single_agent", "n": 2 })).is_err());
        assert!(parse_condition(json!({ "kind": "single_agent", "n": 17 })).is_err());
    }

    #[test]
    fn resolve_run_spec_rejects_empty_model_entries() {
        let def = DelegatedLbcRunDefConfig {
            task: SlotBinding::Literal {
                value: "task".into(),
            },
            model_pool: JsonBinding::Literal {
                value: json!(["alpha", ""]),
            },
            condition: JsonBinding::Literal {
                value: json!({"kind": "single_agent", "n": 1}),
            },
            grade: None,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
            output_dir: None,
            bridge_command: None,
            bridge_args: None,
            result_output_slot: "result".into(),
        };

        let err = resolve_run_spec(&def, &HashMap::new(), &json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("model_pool entries must be non-empty strings"));
    }

    #[test]
    fn parse_grader_ref_rejects_invalid_values() {
        assert!(parse_grader_ref(json!({"kind": "registered", "key": ""})).is_err());
        assert!(parse_grader_ref(json!({"kind": "registered", "key": "k", "config": []})).is_err());
        assert!(parse_grader_ref(json!({"kind": "local_config", "name": "NotSnake"})).is_err());
    }

    #[test]
    fn validate_result_output_slot_returns_the_declared_slot() {
        let slots = vec![
            OutputSlot {
                name: "summary".into(),
                artifact_type: "text".into(),
            },
            OutputSlot {
                name: "result".into(),
                artifact_type: "json".into(),
            },
        ];

        let slot = validate_result_output_slot(&slots, "result").unwrap();
        assert_eq!(slot.artifact_type, "json");
    }

    #[test]
    fn delegated_lbc_run_def_config_roundtrip() {
        let def = DelegatedLbcRunDefConfig {
            task: SlotBinding::Literal {
                value: "prose_substrate_thesis".into(),
            },
            model_pool: JsonBinding::Literal {
                value: json!(["claude-sonnet-4-5"]),
            },
            condition: JsonBinding::Literal {
                value: json!({ "kind": "single_agent", "n": 1 }),
            },
            grade: Some(JsonBinding::Literal { value: json!(true) }),
            grader: Some(JsonBinding::Literal {
                value: json!({ "kind": "registered", "key": "prose_substrate_thesis" }),
            }),
            local_task_dir: Some(SlotBinding::Context {
                path: "/workdir/tasks".into(),
            }),
            local_grader_config_dir: Some(SlotBinding::Context {
                path: "/workdir/graders".into(),
            }),
            output_dir: Some(SlotBinding::Context {
                path: "/workdir".into(),
            }),
            bridge_command: Some("uv".into()),
            bridge_args: Some(vec![
                "run".into(),
                "python".into(),
                "-m".into(),
                "legit_biz_club.run".into(),
            ]),
            result_output_slot: "result".into(),
        };

        let json = serde_json::to_value(&def).unwrap();
        let back: DelegatedLbcRunDefConfig = serde_json::from_value(json).unwrap();
        assert_eq!(def, back);
    }
}
