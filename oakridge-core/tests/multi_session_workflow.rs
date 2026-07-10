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
    let sid = format!("sid-{}", state.sessions.lock().unwrap().len() + 1);
    state.sessions.lock().unwrap().push_back(sid.clone());
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
    for _ in 0..2 {
        let payload = json!({
            "kind": "gate_decision",
            "decision": {"outcome": "pass", "comment": "approved", "feedback": null},
            "against_artifact_id": artifact_id.0,
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
            assert_eq!(response.status(), StatusCode::CONFLICT);
            tokio::task::yield_now().await;
        }
        assert!(accepted, "gate did not become routable");
    }
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
        tokio::task::yield_now().await;
    }
    panic!("stage '{stage_key}' was not activated");
}

fn fan_out_definition() -> WorkflowDef {
    let mut stages = HashMap::new();
    stages.insert("build".into(), StageNodeDef {
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
    }
}

fn collect_definition() -> WorkflowDef {
    let mut stages = HashMap::new();
    stages.insert(
        "producer".into(),
        StageNodeDef {
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
    }
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
    assert!(inputs.try_recv().is_err(), "collector started before producer done");
    pass_gate(&app, producer.id, artifact_a).await;
    assert!(inputs.try_recv().is_err(), "collector started after only one unit completed");
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
async fn seeded_dev_flow_v2_inherits_only_the_matching_build_result() {
    let prompts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("prompts");
    let (base_url, mut inputs, fake_task) = fake_kbbl().await;
    let db_url = format!("sqlite:///tmp/oakridge-seeded-multi-session-{}.db", Uuid::new_v4());
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
    let definition_id = WorkflowDefId(
        Uuid::parse_str("15af5600-1aa7-4ca8-9a12-56f9b132216d").unwrap(),
    );
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
                    "worktree_path": "/tmp",
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
                    "title": "A",
                    "scope": "a",
                    "depends_on": [],
                    "description": "first",
                    "decisions": [],
                    "acceptance_criteria": []
                },
                {
                    "id": "cohort-b",
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
        tokio::task::yield_now().await;
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
