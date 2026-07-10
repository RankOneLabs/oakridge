#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::mpsc;
use uuid::Uuid;

use oakridge_core::db::queries;
use oakridge_core::executor::delegated_lbc_run::config::{
    DelegatedLbcRunCondition, DelegatedLbcRunConfig, DelegatedLbcRunSpec,
};
use oakridge_core::executor::delegated_lbc_run::DelegatedLbcRunStage;
use oakridge_core::executor::{ExecutorEvent, StageContext};
use oakridge_core::registry::stage_type::StageType;
use oakridge_core::registry::{ArtifactTypeDef, ArtifactTypeRegistry};
use oakridge_core::types::{
    RunStatus, StageInstance, StageInstanceId, StageInstanceSummary, StageKey, StageStatus,
    WorkflowDef, WorkflowDefId, WorkflowGraph, WorkflowRun, WorkflowRunId,
};

fn fixed_dt() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

async fn make_pool() -> Arc<sqlx::SqlitePool> {
    let path = format!("/tmp/oakridge_lbc_run_process_{}.db", Uuid::new_v4());
    Arc::new(
        oakridge_core::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap(),
    )
}

fn make_registry(strict: bool) -> Arc<ArtifactTypeRegistry> {
    let mut registry = ArtifactTypeRegistry::new();
    registry.register(ArtifactTypeDef {
        id: "artifact".into(),
        validate: |_| Ok(()),
        component_id: "artifact-viewer".into(),
        capabilities: Default::default(),
        anchor_schema: None,
            review_items_extractor: None,
    });
    if strict {
        #[derive(serde::Deserialize)]
        struct RequiresField {
            #[allow(dead_code)]
            required_field: String,
        }

        registry.register(ArtifactTypeDef {
            id: "strict".into(),
            validate: |value| {
                serde_json::from_value::<RequiresField>(value.clone())
                    .map(|_| ())
                    .map_err(Into::into)
            },
            component_id: "strict-viewer".into(),
            capabilities: Default::default(),
            anchor_schema: None,
            review_items_extractor: None,
        });
    }
    Arc::new(registry)
}

async fn setup_run(
    pool: &sqlx::SqlitePool,
    artifact_type: &str,
) -> (WorkflowRunId, StageInstanceId) {
    let def = WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: format!("wf-{}", Uuid::new_v4()),
        version: 1,
        graph: WorkflowGraph {
            stages: {
                let mut stages = HashMap::new();
                stages.insert(
                    "s1".into(),
                    oakridge_core::types::StageNodeDef {
                        stage_type: "delegated_lbc_run".into(),
                        config: json!({}),
                        inputs: vec![],
                        outputs: vec![oakridge_core::types::OutputSlot {
                            name: "result".into(),
                            artifact_type: artifact_type.into(),
                        }],
                    },
                );
                stages
            },
            edges: vec![],
        },
        created_at: fixed_dt(),
    };
    queries::insert_workflow_def(pool, &def).await.unwrap();

    let run = WorkflowRun {
        id: WorkflowRunId(Uuid::new_v4()),
        workflow_def_id: def.id,
        project_id: None,
        status: RunStatus::Running,
        context: json!({}),
        version: 1,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    queries::insert_workflow_run(pool, &run).await.unwrap();

    let si = StageInstance {
        id: StageInstanceId(Uuid::new_v4()),
        run_id: run.id,
        stage_key: StageKey::from("s1"),
        stage_type: "delegated_lbc_run".into(),
        status: StageStatus::Pending,
        config: json!({}),
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: None,
        started_at: None,
        ended_at: None,
        created_at: fixed_dt(),
        updated_at: fixed_dt(),
    };
    queries::insert_stage_instance(pool, &si).await.unwrap();
    (run.id, si.id)
}

fn make_ctx(
    pool: Arc<sqlx::SqlitePool>,
    run_id: WorkflowRunId,
    si_id: StageInstanceId,
    registry: Arc<ArtifactTypeRegistry>,
    config: Value,
) -> (StageContext, mpsc::Receiver<ExecutorEvent>) {
    let summary = StageInstanceSummary {
        stage_instance_id: si_id,
        workflow_run_id: run_id,
        stage_key: "s1".into(),
        status: StageStatus::Pending,
        parked_reason: None,
        parked_meta: None,
        terminal_meta: None,
        external_ref: None,
    };
    let (tx, rx) = mpsc::channel(16);
    (
        StageContext::new(summary, config, HashMap::new(), tx, pool, registry),
        rx,
    )
}

async fn write_script(tempdir: &TempDir, name: &str, script: &str) -> PathBuf {
    let path = tempdir.path().join(name);
    tokio::fs::write(&path, script).await.unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
    }
    path
}

async fn wait_for_status(
    pool: &sqlx::SqlitePool,
    si_id: StageInstanceId,
    expected: StageStatus,
) -> oakridge_core::types::StageInstance {
    for _ in 0..250 {
        let si = queries::get_stage_instance_by_id(pool, &si_id)
            .await
            .unwrap();
        if si.status == expected {
            return si;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("stage did not reach {:?} in time", expected);
}

async fn wait_for_path(path: &PathBuf) {
    for _ in 0..250 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("path did not appear in time: {}", path.display());
}

async fn assert_path_absent_for(path: &PathBuf, duration: Duration) {
    let deadline = tokio::time::Instant::now() + duration;
    while tokio::time::Instant::now() < deadline {
        assert!(
            !path.exists(),
            "path appeared unexpectedly: {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn success_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
spec=""
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --spec)
      spec="$2"
      shift 2
      ;;
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_dir/cell-1/commits"
cat > "$output_dir/cell-1/events.jsonl" <<'EOF'
{"kind":"event"}
EOF
cat > "$output_dir/cell-1/eval_scores.json" <<'EOF'
{"score": 9}
EOF
printf 'noise\n'
printf 'RESULT {"artifact_path":"cell-1/final.txt","eval_scores":{"score":9}}\n'
printf 'RESULT {"artifact_path":"cell-1/ignored.txt","eval_scores":{"score":0}}\n'
printf 'artifact from %s\n' "$spec" > "$output_dir/cell-1/final.txt"
printf 'artifact from %s\n' "$spec" > "$output_dir/cell-1/ignored.txt"
"#
}

fn missing_result_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
printf 'noise only\n'
"#
}

fn invalid_json_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
printf 'RESULT {not-json}\n'
"#
}

fn invalid_payload_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
printf 'RESULT {"artifact_path": 1, "eval_scores": null}\n'
"#
}

fn non_zero_exit_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
printf 'noise\n'
exit 7
"#
}

fn cancellation_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_dir/cell-1"
printf 'started\n' > "$output_dir/started.txt"
while :; do
  sleep 1
done
"#
}

fn cancellation_child_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_dir/cell-1"
(
  printf 'child started\n' > "$output_dir/child-started.txt"
  sleep 2
  printf 'child survived\n' > "$output_dir/child-survived.txt"
) &
printf 'parent started\n' > "$output_dir/started.txt"
wait
"#
}

fn artifact_emit_failure_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_dir/cell-1"
printf 'RESULT {"artifact_path":"cell-1/final.txt","eval_scores":null}\n'
printf 'artifact from strict type\n' > "$output_dir/cell-1/final.txt"
"#
}

#[tokio::test]
async fn success_writes_run_spec_emits_one_artifact_and_records_sidecars() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(&tempdir, "fake-success.sh", success_script()).await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Done).await;
    let run_spec_path = tempdir.path().join("run-spec.json");
    let run_spec_json = tokio::fs::read_to_string(&run_spec_path).await.unwrap();
    let run_spec: Value = serde_json::from_str(&run_spec_json).unwrap();
    assert_eq!(run_spec["task"], json!("task"));
    assert_eq!(run_spec["model_pool"], json!(["model"]));
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("completed")
    );

    let artifacts = queries::list_artifacts_for_run(&pool, &run_id, None)
        .await
        .unwrap();
    let artifacts: Vec<_> = artifacts
        .into_iter()
        .filter(|artifact| artifact.stage_instance_id == si_id)
        .collect();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].output_name.as_deref(), Some("result"));
    assert_eq!(artifacts[0].artifact_type, "artifact");
    assert_eq!(
        artifacts[0].body["artifact_path"],
        json!("cell-1/ignored.txt")
    );
    assert_eq!(artifacts[0].body["eval_scores"], json!({"score": 0}));
    assert_eq!(
        artifacts[0].body["sidecars"]["events_jsonl_path"],
        json!(tempdir.path().join("cell-1/events.jsonl"))
    );
    assert_eq!(
        artifacts[0].body["sidecars"]["eval_scores_json_path"],
        json!(tempdir.path().join("cell-1/eval_scores.json"))
    );
    assert_eq!(
        artifacts[0].body["sidecars"]["commits_dir"],
        json!(tempdir.path().join("cell-1/commits"))
    );
}

#[tokio::test]
async fn missing_result_fails_with_terminal_meta() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path =
        write_script(&tempdir, "fake-missing-result.sh", missing_result_script()).await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("missing_result")
    );
}

#[tokio::test]
async fn invalid_result_json_fails_with_terminal_meta() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(&tempdir, "fake-invalid-json.sh", invalid_json_script()).await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("invalid_result_json")
    );
}

#[tokio::test]
async fn invalid_result_payload_fails_with_terminal_meta() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(
        &tempdir,
        "fake-invalid-payload.sh",
        invalid_payload_script(),
    )
    .await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("invalid_result_payload")
    );
}

#[tokio::test]
async fn non_zero_exit_fails_with_terminal_meta() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(&tempdir, "fake-non-zero.sh", non_zero_exit_script()).await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("non_zero_exit")
    );
}

#[tokio::test]
async fn artifact_emission_failure_is_reported_structurally() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "strict").await;
    let registry = make_registry(true);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(
        &tempdir,
        "fake-emit-failure.sh",
        artifact_emit_failure_script(),
    )
    .await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "strict".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let _handle = stage.execute(ctx).await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("artifact_emit_failed")
    );
}

#[tokio::test]
async fn cancellation_kills_bridge_and_records_cancelled_meta() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(&tempdir, "fake-cancel.sh", cancellation_script()).await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let handle = stage.execute(ctx).await.unwrap();
    wait_for_path(&tempdir.path().join("started.txt")).await;
    handle.cancel().await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("cancelled")
    );
    assert!(tempdir.path().join("started.txt").exists());
}

#[tokio::test]
async fn cancellation_kills_bridge_process_group_children() {
    let pool = make_pool().await;
    let (run_id, si_id) = setup_run(&pool, "artifact").await;
    let registry = make_registry(false);
    let tempdir = TempDir::new().unwrap();
    let script_path = write_script(
        &tempdir,
        "fake-cancel-child.sh",
        cancellation_child_script(),
    )
    .await;

    let config = serde_json::to_value(DelegatedLbcRunConfig {
        run_spec: DelegatedLbcRunSpec {
            task: "task".into(),
            model_pool: vec!["model".into()],
            condition: DelegatedLbcRunCondition {
                kind: "single_agent".into(),
                n: 1,
            },
            grade: true,
            grader: None,
            local_task_dir: None,
            local_grader_config_dir: None,
        },
        output_dir: tempdir.path().to_path_buf(),
        bridge_command: script_path.to_string_lossy().to_string(),
        bridge_args: vec![],
        result_output_slot: oakridge_core::types::OutputSlot {
            name: "result".into(),
            artifact_type: "artifact".into(),
        },
    })
    .unwrap();

    let (ctx, _rx) = make_ctx(pool.clone(), run_id, si_id, registry, config);
    let stage = DelegatedLbcRunStage::new();
    let handle = stage.execute(ctx).await.unwrap();
    wait_for_path(&tempdir.path().join("child-started.txt")).await;
    handle.cancel().await.unwrap();

    let si = wait_for_status(&pool, si_id, StageStatus::Failed).await;
    assert_eq!(
        si.terminal_meta.as_ref().unwrap()["kind"],
        json!("cancelled")
    );
    assert_path_absent_for(
        &tempdir.path().join("child-survived.txt"),
        Duration::from_millis(2500),
    )
    .await;
}
