use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::db::{self, queries};
use oakridge_core::executor::delegated_session::{kbbl_client::KbblClient, DelegatedSessionStage};
use oakridge_core::http::{boot, Config};
use oakridge_core::registry::{
    register_dev_flow_types, ArtifactTypeDef, ArtifactTypeRegistry, StageTypeRegistry,
};
use oakridge_core::types::*;

#[derive(Clone, Debug)]
struct SessionInput {
    sid: String,
    text: String,
}

#[derive(Clone)]
struct FakeKbbl {
    sessions: Arc<Mutex<VecDeque<String>>>,
    input_tx: mpsc::UnboundedSender<SessionInput>,
}

async fn create_session(
    State(state): State<FakeKbbl>,
    Json(_body): Json<Value>,
) -> impl IntoResponse {
    let sid = {
        let mut sessions = state.sessions.lock().unwrap();
        let sid = format!("sid-{}", sessions.len() + 1);
        sessions.push_back(sid.clone());
        sid
    };
    Json(json!({
        "sid": sid,
        "worktreePath": format!("/tmp/{sid}"),
        "worktreeBranch": format!("cohort/{sid}"),
        "worktreeBaseRef": "main"
    }))
}

async fn send_input(
    State(state): State<FakeKbbl>,
    Path(sid): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let text = body["text"].as_str().unwrap_or_default().to_owned();
    let _ = state.input_tx.send(SessionInput { sid, text });
    Json(json!({"ok": true}))
}

async fn empty_events(Path(sid): Path<String>) -> impl IntoResponse {
    Json(json!({"session_id": sid, "events": []}))
}

async fn fake_kbbl() -> (
    String,
    mpsc::UnboundedReceiver<SessionInput>,
    tokio::task::JoinHandle<()>,
) {
    let (input_tx, input_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/sessions", post(create_session))
        .route("/:sid/input", post(send_input))
        .route("/:sid/events", get(empty_events))
        .with_state(FakeKbbl {
            sessions: Arc::new(Mutex::new(VecDeque::new())),
            input_tx,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/"), input_rx, task)
}

async fn json_request(app: &Router, method: &str, uri: String, body: Value) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        status.is_success(),
        "unexpected response {status}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

async fn emit(
    app: &Router,
    stage_id: StageInstanceId,
    unit_id: &str,
    output: &str,
    body: Value,
) -> ArtifactId {
    let response = json_request(
        app,
        "POST",
        format!(
            "/executors/delegated_session/{}/units/{unit_id}/emit/{output}",
            stage_id.0,
        ),
        body,
    )
    .await;
    ArtifactId(Uuid::parse_str(response["artifact_id"].as_str().unwrap()).unwrap())
}

async fn pass_gate(app: &Router, stage_id: StageInstanceId, artifact_id: ArtifactId) {
    for gate_step in ["artifact_approval", "merge_confirmation"] {
        let payload = json!({
            "kind": "gate_decision",
            "decision": {"outcome": "pass", "comment": "approved", "feedback": null},
            "against_artifact_id": artifact_id.0,
            "against_gate_step": gate_step,
        });
        let mut accepted = false;
        for _ in 0..64 {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/stage_instances/{}/resume", stage_id.0))
                        .header("content-type", "application/json")
                        .body(Body::from(payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            if response.status().is_success() {
                accepted = true;
                break;
            }
            let status = response.status();
            if status != StatusCode::CONFLICT {
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                panic!(
                    "unexpected gate response {status}: {}",
                    String::from_utf8_lossy(&body)
                );
            }
            tokio::task::yield_now().await;
        }
        assert!(accepted, "gate did not become routable");
    }
}

async fn decide_artifact_gate(
    app: &Router,
    stage_id: StageInstanceId,
    artifact_id: ArtifactId,
    outcome: &str,
    feedback: Option<&str>,
) {
    let payload = json!({
        "kind": "gate_decision",
        "decision": {"outcome": outcome, "comment": null, "feedback": feedback},
        "against_artifact_id": artifact_id.0,
        "against_gate_step": "artifact_approval",
    });
    for _ in 0..64 {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/stage_instances/{}/resume", stage_id.0))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        if response.status().is_success() {
            return;
        }
        assert_eq!(response.status(), StatusCode::CONFLICT);
        tokio::task::yield_now().await;
    }
    panic!("artifact gate did not become routable");
}

async fn yield_scheduler() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

async fn stage_for_key(
    pool: &sqlx::SqlitePool,
    run_id: WorkflowRunId,
    stage_key: &str,
) -> StageInstance {
    for _ in 0..64 {
        if let Some(stage) = queries::list_stage_instances_for_run(pool, &run_id)
            .await
            .unwrap()
            .into_iter()
            .find(|stage| stage.stage_key == stage_key)
        {
            return stage;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("stage '{stage_key}' was not activated");
}

fn fan_out_definition() -> WorkflowDef {
    let mut stages = HashMap::new();
    stages.insert("build".into(), StageNodeDef {
        operator_role: None,
        stage_type: "delegated_session".into(),
        config: json!({
            "runtime": "claude-code",
            "prompt_template_path": "unit.md",
            "slot_bindings": {"UNIT_ID": {"from": "literal", "value": "0"}},
            "workdir": {"from": "literal", "value": "/tmp"},
            "session_name": "build-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}",
            "pre_authorized_tools": [], "yolo": false,
            "gate_output": "build_result",
            "fan_out": {
                "over": {"from": "literal", "value": r#"[{"id":"cohort-a","depends_on":[]},{"id":"cohort-b","depends_on":["cohort-a"]}]"#},
                "unit_id_path": "/id", "depends_on_path": "/depends_on", "max_parallel": 2,
                "item_bindings": {},
                "worktree": {"branch_name": "cohort/{{STAGE_INSTANCE_ID}}/{{UNIT_ID}}", "worktree_subdir": "{{STAGE_INSTANCE_ID}}/{{UNIT_ID}}", "base_ref": "main"}
            }
        }),
        inputs: vec![],
        outputs: vec![
            OutputSlot { name: "pr_summary".into(), artifact_type: "pr".into() },
            OutputSlot { name: "build_result".into(), artifact_type: "result".into() },
        ],
    });
    WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: "multi-session".into(),
        version: 1,
        graph: WorkflowGraph {
            stages,
            edges: vec![],
        },
        created_at: chrono::Utc::now(),
        archived: false,
    }
}

fn collect_definition() -> WorkflowDef {
    let mut stages = HashMap::new();
    stages.insert(
        "producer".into(),
        StageNodeDef {
            operator_role: None,
            stage_type: "delegated_session".into(),
            config: json!({
                "runtime": "claude-code",
                "prompt_template_path": "unit.md",
                "slot_bindings": {"UNIT_ID": {"from": "literal", "value": "0"}},
                "workdir": {"from": "literal", "value": "/tmp"},
                "session_name": "producer-{{UNIT_ID}}",
                "pre_authorized_tools": [],
                "yolo": false,
                "gate_output": "result",
                "fan_out": {
                    "over": {"from": "literal", "value": r#"[{"id":"a"},{"id":"b"}]"#},
                    "unit_id_path": "/id",
                    "max_parallel": 2
                }
            }),
            inputs: vec![],
            outputs: vec![OutputSlot {
                name: "result".into(),
                artifact_type: "result".into(),
            }],
        },
    );
    stages.insert(
        "collector".into(),
        StageNodeDef {
            operator_role: None,
            stage_type: "delegated_session".into(),
            config: json!({
                "runtime": "claude-code",
                "prompt_template_path": "collect.md",
                "slot_bindings": {"RESULTS": {"from": "input", "input_name": "results", "path": null}},
                "workdir": {"from": "literal", "value": "/tmp"},
                "session_name": "collector",
                "pre_authorized_tools": [],
                "yolo": false
            }),
            inputs: vec![InputSlot {
                name: "results".into(),
                artifact_type: "result".into(),
                optional: false,
                collect: true,
                delivery: oakridge_core::types::InputDelivery::ProducerComplete,
            }],
            outputs: vec![],
        },
    );
    WorkflowDef {
        id: WorkflowDefId(Uuid::new_v4()),
        name: "collect".into(),
        version: 1,
        graph: WorkflowGraph {
            stages,
            edges: vec![Edge {
                from: EdgeEndpoint {
                    stage: "producer".into(),
                    slot: "result".into(),
                },
                to: EdgeEndpoint {
                    stage: "collector".into(),
                    slot: "results".into(),
                },
            }],
        },
        created_at: chrono::Utc::now(),
        archived: false,
    }
}

fn incremental_definition() -> WorkflowDef {
    let mut definition = collect_definition();
    definition.name = "incremental".into();
    let consumer = definition.graph.stages.remove("collector").unwrap();
    definition.graph.stages.insert(
        "assessor".into(),
        StageNodeDef {
            operator_role: None,
            stage_type: "delegated_session".into(),
            config: json!({
                "runtime": "claude-code",
                "prompt_template_path": "assess.md",
                "slot_bindings": {
                    "UNIT_ID": {"from": "item", "path": "/unit_id"},
                    "RESULT": {"from": "input", "input_name": "results", "path": "/marker"}
                },
                "workdir": {"from": "literal", "value": "/tmp"},
                "session_name": "assessor-{{UNIT_ID}}",
                "pre_authorized_tools": [],
                "yolo": false,
                "gate_output": "assessment",
                "fan_out": {
                    "over": {"from": "input", "input_name": "results", "path": null},
                    "unit_id_path": "/unit_id",
                    "max_parallel": 2,
                    "inherit_worktree_from": "results"
                }
            }),
            inputs: vec![InputSlot {
                name: "results".into(),
                artifact_type: "result".into(),
                optional: false,
                collect: false,
                delivery: oakridge_core::types::InputDelivery::UnitComplete,
            }],
            outputs: vec![OutputSlot {
                name: "assessment".into(),
                artifact_type: "result".into(),
            }],
        },
    );
    assert_eq!(consumer.stage_type, "delegated_session");
    definition.graph.edges[0].to.stage = "assessor".into();
    definition
}

fn assessment_lifecycle_definition() -> WorkflowDef {
    let mut definition = incremental_definition();
    let producer = definition.graph.stages.get_mut("producer").unwrap();
    producer.operator_role = Some(StageOperatorRole::Build);
    let config = producer.config.as_object_mut().unwrap();
    config.remove("gate_output");
    config["fan_out"]["over"] = json!({
        "from": "literal",
        "value": r#"[{"id":"a","depends_on":[]},{"id":"b","depends_on":["a"]}]"#
    });
    config["fan_out"]["depends_on_path"] = json!("/depends_on");
    config.insert(
        "output_handoff".into(),
        json!({
            "output": "result",
            "downstream_role": "assessment",
            "approved_wait": {"kind": "github_review"}
        }),
    );
    let assessor = definition.graph.stages.get_mut("assessor").unwrap();
    assessor.operator_role = Some(StageOperatorRole::Assessment);
    let config = assessor.config.as_object_mut().unwrap();
    config.remove("gate_output");
    config.insert(
        "output_gate".into(),
        json!({
            "output": "assessment",
            "steps": [{"type": "artifact_approval", "actions": ["approve", "request_revision"]}],
            "requires_zero_open_review_items": false,
            "revision_target": "upstream_handoff"
        }),
    );
    definition
}

#[tokio::test]
async fn assessment_gate_revises_matching_builder_then_waits_for_external_review() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Build {{UNIT_ID}}").unwrap();
    std::fs::write(
        prompts.path().join("assess.md"),
        "Assess {{UNIT_ID}} {{RESULT}}",
    )
    .unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!(
        "sqlite:///tmp/oakridge-assessment-lifecycle-{}.db",
        Uuid::new_v4()
    );
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            artifacts.register(ArtifactTypeDef {
                id: "result".into(),
                validate: |_| Ok(()),
                component_id: "result".into(),
                capabilities: Default::default(),
                anchor_schema: None,
                review_items_extractor: None,
            });
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition = assessment_lifecycle_definition();
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();

    let builder_a = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        inputs.try_recv().is_err(),
        "dependent builder started before upstream completion"
    );
    let build_stage = stage_for_key(&pool, run.id, "producer").await;
    let first_build = emit(&app, build_stage.id, "a", "result", json!({"marker": "v1"})).await;
    let assessor_input =
        match tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv()).await {
            Ok(Some(input)) => input,
            other => panic!(
                "assessor handoff failed: {other:?}; stages={:?}; build_units={:?}",
                queries::list_stage_instances_for_run(&pool, &run.id)
                    .await
                    .unwrap(),
                queries::list_session_units_for_stage(&pool, &build_stage.id)
                    .await
                    .unwrap()
            ),
        };
    assert!(assessor_input.text.contains("v1"));
    assert!(
        inputs.try_recv().is_err(),
        "assessment handoff unlocked a dependent builder"
    );
    let assessment_stage = stage_for_key(&pool, run.id, "assessor").await;
    let assessment_unit = queries::get_session_unit(&pool, &assessment_stage.id, "a")
        .await
        .unwrap();
    let build_unit = queries::get_session_unit(&pool, &build_stage.id, "a")
        .await
        .unwrap();
    assert_eq!(assessment_unit.workdir_path, build_unit.worktree_path);
    assert_eq!(assessment_unit.source_artifact_id, Some(first_build));
    assert_eq!(build_unit.status, UnitStatus::Parked);

    let first_assessment = emit(
        &app,
        assessment_stage.id,
        "a",
        "assessment",
        json!({"verdict": "fail", "findings": []}),
    )
    .await;
    let interrupted_transition = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/stage_instances/{}/resume", assessment_stage.id.0))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "kind": "gate_decision",
                        "decision": {"outcome": "rerun", "comment": null, "feedback": "fix the implementation"},
                        "against_artifact_id": first_assessment.0,
                        "against_gate_step": "not_the_current_step"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(!interrupted_transition.status().is_success());
    let revision_request = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revision_request.sid, builder_a.sid);
    assert!(revision_request.text.contains("fix the implementation"));

    decide_artifact_gate(
        &app,
        assessment_stage.id,
        first_assessment,
        "rerun",
        Some("fix the implementation"),
    )
    .await;
    assert!(
        inputs.try_recv().is_err(),
        "reconciling the decision resent revision feedback"
    );

    let revised_build = emit(&app, build_stage.id, "a", "result", json!({"marker": "v2"})).await;
    let revised_assessor_input =
        tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(revised_assessor_input.sid, assessor_input.sid);
    assert!(revised_assessor_input.text.contains("v2"));
    let stale_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/stage_instances/{}/resume", assessment_stage.id.0))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "kind": "gate_decision",
                        "decision": {"outcome": "pass", "comment": null, "feedback": null},
                        "against_artifact_id": first_assessment.0,
                        "against_gate_step": "artifact_approval"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale_response.status(), StatusCode::CONFLICT);
    let revised_assessment = emit(
        &app,
        assessment_stage.id,
        "a",
        "assessment",
        json!({"verdict": "pass", "findings": []}),
    )
    .await;
    decide_artifact_gate(&app, assessment_stage.id, revised_assessment, "pass", None).await;

    let build_unit = queries::get_session_unit(&pool, &build_stage.id, "a")
        .await
        .unwrap();
    assert_eq!(build_unit.status, UnitStatus::Parked);
    assert_eq!(build_unit.artifact_id, Some(revised_build));
    assert_eq!(build_unit.gate_state.unwrap()["kind"], "awaiting_external");
    fake_task.abort();
}

#[tokio::test]
async fn unit_complete_delivery_starts_matching_consumer_before_producer_stage_finishes() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Build {{UNIT_ID}}").unwrap();
    std::fs::write(
        prompts.path().join("assess.md"),
        "Assess {{UNIT_ID}} {{RESULT}}",
    )
    .unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-incremental-{}.db", Uuid::new_v4());
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            artifacts.register(ArtifactTypeDef {
                id: "result".into(),
                validate: |_| Ok(()),
                component_id: "result".into(),
                capabilities: Default::default(),
                anchor_schema: None,
                review_items_extractor: None,
            });
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition = incremental_definition();
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();

    let _producer_a = inputs.recv().await.unwrap();
    let _producer_b = inputs.recv().await.unwrap();
    let producer = stage_for_key(&pool, run.id, "producer").await;
    let artifact_a = emit(
        &app,
        producer.id,
        "a",
        "result",
        json!({"marker": "A-READY"}),
    )
    .await;
    pass_gate(&app, producer.id, artifact_a).await;

    let assessor_a =
        match tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv()).await {
            Ok(Some(input)) => input,
            other => panic!(
                "assessor did not start: {other:?}; stages={:?}",
                queries::list_stage_instances_for_run(&pool, &run.id)
                    .await
                    .unwrap()
            ),
        };
    assert!(assessor_a.text.contains("A-READY"));
    let assessor = stage_for_key(&pool, run.id, "assessor").await;
    let units = queries::list_session_units_for_stage(&pool, &assessor.id)
        .await
        .unwrap();
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].unit_id, "a");
    assert_eq!(units[0].source_artifact_id, Some(artifact_a));
    let producer_unit = queries::get_session_unit(&pool, &producer.id, "a")
        .await
        .unwrap();
    assert_eq!(
        units[0].workdir_path, producer_unit.worktree_path,
        "consumer must reuse the completed producer checkout"
    );
    let assessment_a = emit(
        &app,
        assessor.id,
        "a",
        "assessment",
        json!({"verdict": "pass"}),
    )
    .await;
    pass_gate(&app, assessor.id, assessment_a).await;
    let mut held_assessor = queries::get_stage_instance_by_id(&pool, &assessor.id)
        .await
        .unwrap();
    for _ in 0..64 {
        if held_assessor.status == oakridge_core::types::StageStatus::Running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        held_assessor = queries::get_stage_instance_by_id(&pool, &assessor.id)
            .await
            .unwrap();
    }
    assert_eq!(
        held_assessor.status,
        oakridge_core::types::StageStatus::Running,
        "consumer stays open until the producer stream is exhausted"
    );
    assert!(
        held_assessor.started_at.is_some(),
        "holding the consumer open must preserve its start timestamp"
    );
    assert_ne!(
        queries::get_stage_instance_by_id(&pool, &producer.id)
            .await
            .unwrap()
            .status,
        oakridge_core::types::StageStatus::Done
    );
    fake_task.abort();
}

#[tokio::test]
async fn zero_unit_producer_surfaces_missing_required_incremental_input() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Build {{UNIT_ID}}").unwrap();
    std::fs::write(
        prompts.path().join("assess.md"),
        "Assess {{UNIT_ID}} {{RESULT}}",
    )
    .unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, _inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-zero-unit-{}.db", Uuid::new_v4());
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            artifacts.register(ArtifactTypeDef {
                id: "result".into(),
                validate: |_| Ok(()),
                component_id: "result".into(),
                capabilities: Default::default(),
                anchor_schema: None,
                review_items_extractor: None,
            });
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let mut definition = incremental_definition();
    definition.graph.stages.get_mut("producer").unwrap().config["fan_out"]["over"]["value"] =
        json!("[]");
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();

    let assessor = stage_for_key(&pool, run.id, "assessor").await;
    assert_eq!(assessor.status, oakridge_core::types::StageStatus::Failed);
    assert!(assessor
        .terminal_meta
        .as_ref()
        .and_then(|meta| meta.get("error"))
        .and_then(Value::as_str)
        .is_some_and(|error| error.contains("required collection input 'results'")));
    fake_task.abort();
}

#[tokio::test]
async fn dependent_units_have_independent_sessions_gates_and_pr_metadata() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Unit {{UNIT_ID}}").unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-multi-session-{}.db", Uuid::new_v4());
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            for id in ["pr", "result"] {
                artifacts.register(ArtifactTypeDef {
                    id: id.into(),
                    validate: |_| Ok(()),
                    component_id: id.into(),
                    capabilities: Default::default(),
                    anchor_schema: None,
                    review_items_extractor: None,
                });
            }
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition = fan_out_definition();
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();

    let first = match tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv()).await {
        Ok(Some(input)) => input,
        _ => panic!(
            "no first unit input; stages={:?}",
            queries::list_stage_instances_for_run(&pool, &run.id)
                .await
                .unwrap()
        ),
    };
    yield_scheduler().await;
    assert!(first.text.contains("cohort-a"));
    assert!(
        inputs.try_recv().is_err(),
        "cohort-b must wait for cohort-a to be done"
    );
    let stage = queries::list_stage_instances_for_run(&pool, &run.id)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let units = queries::list_session_units_for_stage(&pool, &stage.id)
        .await
        .unwrap();
    assert_eq!(units.len(), 2);
    assert_eq!(units[0].unit_id, "cohort-a");
    assert_eq!(units[1].depends_on, vec!["cohort-a"]);
    assert_ne!(units[0].worktree_branch, units[1].worktree_branch);
    assert!(stage.external_ref.is_none(), "N>1 refs remain unit-owned");

    emit(
        &app,
        stage.id,
        "cohort-a",
        "pr_summary",
        json!({"pr_url": "https://example.test/a"}),
    )
    .await;
    let artifact_a = emit(
        &app,
        stage.id,
        "cohort-a",
        "build_result",
        json!({"unit": "a"}),
    )
    .await;
    yield_scheduler().await;
    let gates = json_request(&app, "GET", "/gates".into(), Value::Null).await;
    assert_eq!(gates.as_array().unwrap().len(), 1);
    assert_eq!(gates[0]["unit_id"], "cohort-a");
    assert_eq!(gates[0]["pr_url"], "https://example.test/a");
    pass_gate(&app, stage.id, artifact_a).await;

    let second = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first.sid, second.sid);
    assert!(second.text.contains("cohort-b"));
    yield_scheduler().await;
    emit(
        &app,
        stage.id,
        "cohort-b",
        "pr_summary",
        json!({"pr_url": "https://example.test/b"}),
    )
    .await;
    let artifact_b = emit(
        &app,
        stage.id,
        "cohort-b",
        "build_result",
        json!({"unit": "b"}),
    )
    .await;
    yield_scheduler().await;
    let gates = json_request(&app, "GET", "/gates".into(), Value::Null).await;
    assert_eq!(gates[0]["unit_id"], "cohort-b");
    assert_eq!(gates[0]["pr_url"], "https://example.test/b");
    pass_gate(&app, stage.id, artifact_b).await;
    let units = queries::list_session_units_for_stage(&pool, &stage.id)
        .await
        .unwrap();
    assert!(units.iter().all(|unit| unit.status == UnitStatus::Done));
    fake_task.abort();
}

#[tokio::test]
async fn collect_consumer_waits_for_and_receives_the_complete_ordered_collection() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Unit {{UNIT_ID}}").unwrap();
    std::fs::write(prompts.path().join("collect.md"), "Results {{RESULTS}}").unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-collect-{}.db", Uuid::new_v4());
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            artifacts.register(ArtifactTypeDef {
                id: "result".into(),
                validate: |_| Ok(()),
                component_id: "result".into(),
                capabilities: Default::default(),
                anchor_schema: None,
                review_items_extractor: None,
            });
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition = collect_definition();
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();

    let _producer_a = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let _producer_b = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let producer = stage_for_key(&pool, run.id, "producer").await;
    let artifact_a = emit(
        &app,
        producer.id,
        "a",
        "result",
        json!({"marker": "A-ONLY"}),
    )
    .await;
    assert!(
        inputs.try_recv().is_err(),
        "collector started before producer done"
    );
    pass_gate(&app, producer.id, artifact_a).await;
    assert!(
        inputs.try_recv().is_err(),
        "collector started after only one unit completed"
    );
    let artifact_b = emit(
        &app,
        producer.id,
        "b",
        "result",
        json!({"marker": "B-ONLY"}),
    )
    .await;
    pass_gate(&app, producer.id, artifact_b).await;

    let collector = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(collector.text.contains("A-ONLY"));
    assert!(collector.text.contains("B-ONLY"));
    let a_index = collector.text.find("A-ONLY").unwrap();
    let b_index = collector.text.find("B-ONLY").unwrap();
    assert!(a_index < b_index, "collection must be ordered by unit id");
    fake_task.abort();
}

#[tokio::test]
async fn targeted_retry_restarts_only_the_failed_unit() {
    let prompts = tempfile::tempdir().unwrap();
    std::fs::write(prompts.path().join("unit.md"), "Unit {{UNIT_ID}}").unwrap();
    std::fs::write(prompts.path().join("collect.md"), "Results {{RESULTS}}").unwrap();
    let prompt_dir = prompts.path().to_path_buf();
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-retry-unit-{}.db", Uuid::new_v4());
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            artifacts.register(ArtifactTypeDef {
                id: "result".into(),
                validate: |_| Ok(()),
                component_id: "result".into(),
                capabilities: Default::default(),
                anchor_schema: None,
                review_items_extractor: None,
            });
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompt_dir,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition = collect_definition();
    queries::insert_workflow_def(&pool, &definition)
        .await
        .unwrap();
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({"workflow_def_id": definition.id, "project_id": null, "context": {}}),
        )
        .await,
    )
    .unwrap();
    let _first = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let _second = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let producer = stage_for_key(&pool, run.id, "producer").await;
    let before = queries::list_session_units_for_stage(&pool, &producer.id)
        .await
        .unwrap();
    let sibling_ref = before
        .iter()
        .find(|unit| unit.unit_id == "b")
        .unwrap()
        .external_ref
        .clone();
    queries::set_session_unit_status(
        &pool,
        &producer.id,
        "a",
        UnitStatus::Failed,
        Some(json!({"kind": "session_ended_without_emit"})),
    )
    .await
    .unwrap();

    json_request(
        &app,
        "POST",
        format!("/stage_instances/{}/retry_stuck", producer.id.0),
        json!({"unit_id": "a"}),
    )
    .await;
    let retried = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(retried.text.contains("a"));
    let after = queries::list_session_units_for_stage(&pool, &producer.id)
        .await
        .unwrap();
    let unit_a = after.iter().find(|unit| unit.unit_id == "a").unwrap();
    let unit_b = after.iter().find(|unit| unit.unit_id == "b").unwrap();
    assert_eq!(unit_a.status, UnitStatus::Running);
    assert_ne!(unit_a.external_ref, before[0].external_ref);
    assert_eq!(unit_b.status, UnitStatus::Running);
    assert_eq!(unit_b.external_ref, sibling_ref);
    fake_task.abort();
}

#[tokio::test]
async fn seeded_multi_repository_dev_flow_inherits_only_the_matching_build_result() {
    let prompts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("prompts");
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!(
        "sqlite:///tmp/oakridge-seeded-multi-session-{}.db",
        Uuid::new_v4()
    );
    let (app, _coordinator) = boot(
        Config {
            port: 0,
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            db_url: db_url.clone(),
            pwa_dir: PathBuf::from("/tmp"),
            cors_origins: vec![],
            auth_policy: oakridge_core::config::AuthPolicy::Loopback,
            stage_timeout_secs: 3600,
            stuck_sweep_interval_secs: 3600,
        },
        move |stages: &mut StageTypeRegistry, artifacts: &mut ArtifactTypeRegistry| {
            register_dev_flow_types(artifacts);
            stages.register(Arc::new(DelegatedSessionStage::new(
                prompts,
                KbblClient::new(base_url).unwrap(),
            )));
        },
    )
    .await
    .unwrap();
    let pool = db::init_pool(&db_url).await.unwrap();
    let definition_id =
        WorkflowDefId(Uuid::parse_str("7f80ea26-a412-46fa-9446-0d8a84cd92b8").unwrap());
    let run: WorkflowRun = serde_json::from_value(
        json_request(
            &app,
            "POST",
            "/workflow_runs".into(),
            json!({
                "workflow_def_id": definition_id,
                "project_id": null,
                "context": {
                    "brief_notes": "implement two cohorts",
                    "repositories": [
                        {"key": "api", "path": "/tmp/repo-api"},
                        {"key": "web", "path": "/tmp/repo-web"}
                    ],
                    "oakridge_url": "http://oakridge.test",
                    "planner_model": "planner",
                    "worker_model": "worker",
                    "worker_effort": "medium"
                }
            }),
        )
        .await,
    )
    .unwrap();

    let spec_input = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(spec_input.text.contains("implement two cohorts"));
    let spec_stage = stage_for_key(&pool, run.id, "spec_analyzer").await;
    let spec_artifact = emit(
        &app,
        spec_stage.id,
        "0",
        "spec_analysis",
        json!({
            "summary": "spec",
            "source_spec_refs": [],
            "findings": [],
            "requirements": [],
            "risks": []
        }),
    )
    .await;
    pass_gate(&app, spec_stage.id, spec_artifact).await;

    let plan_input = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(plan_input.text.contains("spec"));
    let plan_stage = stage_for_key(&pool, run.id, "plan_writer").await;
    let plan_artifact = emit(
        &app,
        plan_stage.id,
        "0",
        "plan",
        json!({
            "summary": "two cohorts",
            "cohorts": [
                {
                    "id": "cohort-a",
                    "repository_key": "api",
                    "title": "A",
                    "scope": "a",
                    "depends_on": [],
                    "description": "first",
                    "decisions": [],
                    "acceptance_criteria": []
                },
                {
                    "id": "cohort-b",
                    "repository_key": "web",
                    "title": "B",
                    "scope": "b",
                    "depends_on": ["cohort-a"],
                    "description": "second",
                    "decisions": [],
                    "acceptance_criteria": []
                }
            ],
            "dependency_order": ["cohort-a", "cohort-b"],
            "scope": {},
            "acceptance_criteria": [],
            "risks": []
        }),
    )
    .await;
    pass_gate(&app, plan_stage.id, plan_artifact).await;

    let build_a = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(build_a.text.contains("cohort-a"));
    assert!(inputs.try_recv().is_err(), "dependent cohort started early");
    let build_stage = stage_for_key(&pool, run.id, "build").await;
    emit(
        &app,
        build_stage.id,
        "cohort-a",
        "pr_summary",
        json!({
            "pr_url": "https://example.test/a",
            "branch": "cohort-a",
            "summary": "A"
        }),
    )
    .await;
    let result_a = emit(
        &app,
        build_stage.id,
        "cohort-a",
        "build_result",
        json!({
            "repository_key": "api",
            "summary": "RESULT-A-ONLY",
            "changed_files": ["a.rs"],
            "tests": {},
            "known_issues": []
        }),
    )
    .await;
    pass_gate(&app, build_stage.id, result_a).await;

    let build_b = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(build_b.text.contains("cohort-b"));
    emit(
        &app,
        build_stage.id,
        "cohort-b",
        "pr_summary",
        json!({
            "pr_url": "https://example.test/b",
            "branch": "cohort-b",
            "summary": "B"
        }),
    )
    .await;
    let result_b = emit(
        &app,
        build_stage.id,
        "cohort-b",
        "build_result",
        json!({
            "repository_key": "web",
            "summary": "RESULT-B-ONLY",
            "changed_files": ["b.rs"],
            "tests": {},
            "known_issues": []
        }),
    )
    .await;
    pass_gate(&app, build_stage.id, result_b).await;

    let assessor_one = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let assessor_two = tokio::time::timeout(std::time::Duration::from_secs(3), inputs.recv())
        .await
        .unwrap()
        .unwrap();
    let assessor_inputs = [assessor_one, assessor_two];
    let assessor_a = assessor_inputs
        .iter()
        .find(|input| input.text.contains("RESULT-A-ONLY"))
        .expect("missing cohort-a assessor");
    let assessor_b = assessor_inputs
        .iter()
        .find(|input| input.text.contains("RESULT-B-ONLY"))
        .expect("missing cohort-b assessor");
    assert!(!assessor_a.text.contains("RESULT-B-ONLY"));
    assert!(!assessor_b.text.contains("RESULT-A-ONLY"));

    let assessor_stage = stage_for_key(&pool, run.id, "assessor").await;
    for unit_id in ["cohort-a", "cohort-b"] {
        let artifact = emit(
            &app,
            assessor_stage.id,
            unit_id,
            "assessment",
            json!({
                "verdict": "pass",
                "findings": [],
                "recommended_next_actions": []
            }),
        )
        .await;
        pass_gate(&app, assessor_stage.id, artifact).await;
    }
    let mut finished = queries::get_workflow_run_by_id(&pool, &run.id)
        .await
        .unwrap();
    for _ in 0..64 {
        if finished.status == RunStatus::Done {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        finished = queries::get_workflow_run_by_id(&pool, &run.id)
            .await
            .unwrap();
    }
    assert_eq!(finished.status, RunStatus::Done);
    assert!(spec_stage.external_ref.is_some());
    assert!(plan_stage.external_ref.is_some());
    assert!(build_stage.external_ref.is_none());
    for stage in [&spec_stage, &plan_stage] {
        let units = queries::list_session_units_for_stage(&pool, &stage.id)
            .await
            .unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit_id, "0");
        assert_eq!(units[0].external_ref, stage.external_ref);
    }
    fake_task.abort();
}
