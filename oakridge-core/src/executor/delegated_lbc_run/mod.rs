pub mod config;

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;

use crate::executor::{StageContext, StageHandle};
use crate::registry::stage_type::StageType;
use crate::types::{Artifact, OutputSlot, StageInstanceId};

use config::{
    default_result_output_slot, resolve_output_dir, resolve_run_spec, validate_result_output_slot,
    DelegatedLbcRunConfig, DelegatedLbcRunDefConfig,
};

pub struct DelegatedLbcRunStage;

impl DelegatedLbcRunStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl StageType for DelegatedLbcRunStage {
    fn id(&self) -> &str {
        "delegated_lbc_run"
    }

    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, Artifact>,
        output_slots: &[OutputSlot],
        _stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value> {
        let def: DelegatedLbcRunDefConfig = serde_json::from_value(def_config.clone())?;
        let run_spec = resolve_run_spec(&def, inputs, run_context)?;
        let output_dir = resolve_output_dir(&def, inputs, run_context)?;
        let bridge_command = def.bridge_command.unwrap_or_else(|| "uv".to_owned());
        let bridge_args = def.bridge_args.unwrap_or_else(|| {
            vec![
                "run".into(),
                "python".into(),
                "-m".into(),
                "legit_biz_club.run".into(),
            ]
        });
        let result_output_slot_name = if def.result_output_slot.is_empty() {
            default_result_output_slot()
        } else {
            def.result_output_slot
        };
        let result_output_slot =
            validate_result_output_slot(output_slots, &result_output_slot_name)?;

        let config = DelegatedLbcRunConfig {
            run_spec,
            output_dir,
            bridge_command,
            bridge_args,
            result_output_slot,
        };

        Ok(serde_json::to_value(config)?)
    }

    async fn execute(&self, _ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>> {
        anyhow::bail!("delegated_lbc_run execution is not implemented in oakridge-core yet")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::delegated_lbc_run::config::{
        DelegatedLbcRunCondition, DelegatedLbcRunConfig, DelegatedLbcRunGraderRef,
    };
    use crate::types::{ArtifactId, StageInstanceId, WorkflowRunId};
    use chrono::Utc;
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn artifact(body: Value) -> Artifact {
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

    fn make_stage() -> DelegatedLbcRunStage {
        DelegatedLbcRunStage::new()
    }

    #[tokio::test]
    async fn build_config_uses_literal_and_context_bindings() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "context", "path": "/workdir"},
        });
        let output_slots = vec![OutputSlot {
            name: "result".into(),
            artifact_type: "text".into(),
        }];

        let config = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({"workdir": "/tmp/study"}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(cfg.run_spec.task, "prose_substrate_thesis");
        assert_eq!(cfg.run_spec.model_pool, vec!["claude-sonnet-4-5"]);
        assert_eq!(
            cfg.run_spec.condition,
            DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            }
        );
        assert_eq!(cfg.output_dir, PathBuf::from("/tmp/study"));
        assert_eq!(cfg.bridge_command, "uv");
        assert_eq!(
            cfg.bridge_args,
            vec!["run", "python", "-m", "legit_biz_club.run"]
        );
        assert_eq!(cfg.result_output_slot.name, "result");
        assert_eq!(cfg.result_output_slot.artifact_type, "text");
    }

    #[tokio::test]
    async fn build_config_preserves_json_bindings_and_custom_bridge_and_slot() {
        let stage = make_stage();
        let mut inputs = HashMap::new();
        inputs.insert("spec".into(), artifact(json!({
            "task": "local_task",
            "model_pool": ["m1", "m2"],
            "condition": { "kind": "ensemble_multi_round", "n": 2 },
            "grade": false,
            "grader": { "kind": "registered", "key": "prose_substrate_thesis", "config": { "depth": 3 } },
            "local_task_dir": "/workspace/tasks",
            "local_grader_config_dir": "/workspace/graders"
        })));
        let def_config = json!({
            "task": {"from": "input", "input_name": "spec", "path": "/task"},
            "model_pool": {"from": "input", "input_name": "spec", "path": "/model_pool"},
            "condition": {"from": "input", "input_name": "spec", "path": "/condition"},
            "grade": {"from": "input", "input_name": "spec", "path": "/grade"},
            "grader": {"from": "input", "input_name": "spec", "path": "/grader"},
            "local_task_dir": {"from": "input", "input_name": "spec", "path": "/local_task_dir"},
            "local_grader_config_dir": {"from": "input", "input_name": "spec", "path": "/local_grader_config_dir"},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
            "bridge_command": "python",
            "bridge_args": ["-m", "legit_biz_club.run"],
            "result_output_slot": "artifact"
        });
        let output_slots = vec![
            OutputSlot {
                name: "artifact".into(),
                artifact_type: "json".into(),
            },
            OutputSlot {
                name: "result".into(),
                artifact_type: "text".into(),
            },
        ];

        let config = stage
            .build_config(
                &def_config,
                &inputs,
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(
            cfg.run_spec,
            crate::executor::delegated_lbc_run::config::DelegatedLbcRunSpec {
                task: "local_task".into(),
                model_pool: vec!["m1".into(), "m2".into()],
                condition: DelegatedLbcRunCondition {
                    kind: "ensemble_multi_round".into(),
                    n: 2,
                },
                grade: false,
                grader: Some(DelegatedLbcRunGraderRef::Registered {
                    key: "prose_substrate_thesis".into(),
                    config: Some(json!({"depth": 3})),
                }),
                local_task_dir: Some(PathBuf::from("/workspace/tasks")),
                local_grader_config_dir: Some(PathBuf::from("/workspace/graders")),
            }
        );
        assert_eq!(cfg.bridge_command, "python");
        assert_eq!(cfg.bridge_args, vec!["-m", "legit_biz_club.run"]);
        assert_eq!(cfg.result_output_slot.name, "artifact");
        assert_eq!(cfg.result_output_slot.artifact_type, "json");
    }

    #[tokio::test]
    async fn build_config_rejects_missing_result_slot() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
        });
        let output_slots = vec![OutputSlot {
            name: "not-result".into(),
            artifact_type: "text".into(),
        }];

        let err = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("result output slot 'result' not found"));
    }

    #[tokio::test]
    async fn build_config_accepts_custom_result_slot_type_from_workflow_outputs() {
        let stage = make_stage();
        let def_config = json!({
            "task": {"from": "literal", "value": "prose_substrate_thesis"},
            "model_pool": {"from": "literal", "value": ["claude-sonnet-4-5"]},
            "condition": {"from": "literal", "value": {"kind": "single_agent", "n": 1}},
            "output_dir": {"from": "literal", "value": "/workspace/output"},
            "result_output_slot": "final"
        });
        let output_slots = vec![OutputSlot {
            name: "final".into(),
            artifact_type: "markdown".into(),
        }];

        let config = stage
            .build_config(
                &def_config,
                &HashMap::new(),
                &output_slots,
                StageInstanceId(Uuid::new_v4()),
                &json!({}),
            )
            .await
            .unwrap();
        let cfg: DelegatedLbcRunConfig = serde_json::from_value(config).unwrap();

        assert_eq!(cfg.result_output_slot.artifact_type, "markdown");
    }
}
