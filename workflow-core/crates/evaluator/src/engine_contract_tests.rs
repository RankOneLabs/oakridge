use super::*;
use serde_json::json;

fn source() -> Workflow {
    serde_json::from_value(json!({
        "workflow":"engine_contract", "input":{},
        "run":{"units":{"a":{"stage":"document"},"b":{"stage":"document","after":["a"]}},"outcome":{}},
        "stages":{"document":{"input":{},
            "artifacts":{"draft":{"kind":"record","schema":{"findings":"list(text)","text":"text"}},
                "assessment":{"kind":"assessment","schema":"text"}},
            "workers":{"writer":{"kind":"agent","prompts":{"initial":"write","revise":"revise"},"inputs":{},"produces":["draft"]},
                "assessor":{"kind":"agent","prompts":{"review":"review","revise":"reassess"},"inputs":{},"produces":["assessment"],"evaluates":"draft"}},
            "reviews":{"draft_review":{"of":"draft","by":"operator","prompt":"p","decisions":{
                "accept":{"effect":"approve","label":"Accept","when":{"check":"len(draft.findings) == 0","reason":"Resolve findings first"}},
                "request_changes":{"effect":"request_changes","label":"Fix","on":"draft","payload":{"entries":"list(text)","feedback":"text"}}}},
                "assessment_review":{"of":"assessment","by":"operator","prompt":"p","decisions":{
                    "request_build_changes":{"effect":"request_changes","label":"Build","on":"draft"},
                    "request_assessment_changes":{"effect":"request_changes","label":"Assess"}}}},
            "done_when":"approved(draft)","outcome":{}}}
    })).unwrap()
}

struct Run {
    program: CheckedWorkflow,
    result: StepResult,
}
impl Run {
    fn new() -> Self {
        Self::with_source(source())
    }
    fn with_source(source: Workflow) -> Self {
        Self::with_operations(source, &[])
    }
    fn with_operations(source: Workflow, operations: &[CodeOperation]) -> Self {
        let program = workflow_compiler::compile_workflow(
            &source,
            operations,
            &["p", "write", "revise", "review", "reassess"]
                .into_iter()
                .map(|path| (path.into(), String::new()))
                .collect(),
        )
        .unwrap();
        let snapshot = StepSnapshot {
            run: RunState {
                id: "run".into(),
                root: UnitId::from("run"),
            },
            units: vec![],
            attempts: vec![],
            revisions: vec![],
            decisions: vec![],
            retry_events: vec![],
        };
        let result = step(
            &program,
            &snapshot,
            &Incoming {
                event: Event::Launched { input: json!({}) },
                writer: Writer::Engine,
                ingress_id: None,
            },
        )
        .unwrap();
        Self { program, result }
    }
    fn apply(&mut self, event: Event) -> Result<(), StepError> {
        self.result = step(
            &self.program,
            &self.result.snapshot,
            &Incoming {
                event,
                writer: Writer::Engine,
                ingress_id: None,
            },
        )?;
        Ok(())
    }
    fn publish(&mut self, worker: &str, artifact: &str, body: Value) {
        let attempt = attempt(
            &self.result.snapshot,
            &UnitId::from("run/a"),
            &WorkerKey::from(worker),
        )
        .unwrap();
        let subject = if matches!(worker, "assessor" | "integrator") {
            latest(
                &self.result.snapshot,
                &UnitId::from("run/a"),
                &SymbolKey::from("draft"),
            )
            .map(|revision| revision.id.clone())
        } else {
            None
        };
        self.apply(Event::RevisionPublished {
            unit: UnitId::from("run/a"),
            artifact: SymbolKey::from(artifact),
            body,
            predecessor: latest(
                &self.result.snapshot,
                &UnitId::from("run/a"),
                &SymbolKey::from(artifact),
            )
            .map(|revision| revision.id.clone()),
            subject,
            by: Some(attempt.action_id.clone()),
        })
        .unwrap();
    }
    fn end(&mut self, worker: &str) {
        let action = attempt(
            &self.result.snapshot,
            &UnitId::from("run/a"),
            &WorkerKey::from(worker),
        )
        .unwrap()
        .action_id
        .clone();
        self.apply(Event::WorkerEnded {
            action,
            result: WorkerResult::Succeeded,
        })
        .unwrap();
    }
    fn decide(
        &mut self,
        review: &str,
        decision: &str,
        artifact: &str,
        payload: Value,
    ) -> Result<(), StepError> {
        let target = latest(
            &self.result.snapshot,
            &UnitId::from("run/a"),
            &SymbolKey::from(artifact),
        )
        .unwrap()
        .id
        .clone();
        self.apply(Event::OperatorDecided {
            unit: UnitId::from("run/a"),
            review: SymbolKey::from(review),
            decision: SymbolKey::from(decision),
            target,
            payload,
        })
    }
    fn wanted(&self, worker: &str) -> &protocol::WantedWorker {
        self.result
            .wanted
            .iter()
            .find(|wanted| wanted.unit.0 == "run/a" && wanted.worker.0 == worker)
            .unwrap()
    }
}

#[test]
fn declared_prompts_resolve_for_initial_review_and_ordinary_revision() {
    let mut run = Run::new();
    assert_eq!(
        run.wanted("writer").resolved.prompt.as_deref(),
        Some("write")
    );
    run.publish("writer", "draft", json!({"findings": [], "text": "Draft"}));
    run.end("writer");
    assert_eq!(
        run.wanted("assessor").resolved.prompt.as_deref(),
        Some("review")
    );
    run.decide(
        "draft_review",
        "request_changes",
        "draft",
        json!({"entries": [], "feedback": "Revise"}),
    )
    .unwrap();
    assert_eq!(
        run.wanted("writer").resolved.prompt.as_deref(),
        Some("revise")
    );
}

#[test]
fn blocker_answers_resume_agents_without_revise_prompts() {
    let mut bundle = source();
    let stage = bundle.stages.get_mut("document").unwrap();
    stage
        .reviews
        .get_mut("draft_review")
        .unwrap()
        .decisions
        .remove("request_changes");
    stage.reviews.remove("assessment_review");
    for worker in stage.workers.values_mut() {
        if let Worker::Agent { prompts, .. } = worker {
            prompts.revise = None;
        }
    }
    for (worker, path) in [("writer", "write"), ("assessor", "review")] {
        let mut run = Run::with_source(bundle.clone());
        if worker == "assessor" {
            run.publish("writer", "draft", json!({"findings": [], "text": "Draft"}));
            run.end("writer");
        }
        run.publish(worker, BLOCKER_ARTIFACT, json!({"text": "Clarify?"}));
        run.end(worker);
        run.decide(
            BLOCKER_REVIEW,
            "clarify",
            BLOCKER_ARTIFACT,
            json!({"answer": "Proceed"}),
        )
        .unwrap();
        let wanted = run.wanted(worker);
        assert!(matches!(
            wanted.action,
            Action::RunWorker {
                mode: Mode::Revise,
                ..
            }
        ));
        assert_eq!(wanted.resolved.prompt.as_deref(), Some(path));
    }
}

#[test]
fn ordinary_revision_without_a_declared_prompt_does_not_fall_back() {
    let prompts: Prompts =
        serde_json::from_value(json!({"initial": "write", "review": "review"})).unwrap();
    let feedback: FeedbackEntry = serde_json::from_value(json!({
        "id": "decision", "review": "draft_review", "decision": "request_changes",
        "target": "draft", "payload": {}
    }))
    .unwrap();
    assert_eq!(
        crate::wants::resolve_agent_prompt(&prompts, &Mode::Revise, &[feedback]),
        None
    );
}

#[test]
fn blocker_is_successful_and_parks_dependants_until_normal_output_is_accepted() {
    let mut run = Run::new();
    run.publish(
        "writer",
        BLOCKER_ARTIFACT,
        json!({"text":"Which contract?","suggested_choices":["A","B"]}),
    );
    run.end("writer");
    assert!(matches!(
        attempt(
            &run.result.snapshot,
            &UnitId::from("run/a"),
            &WorkerKey::from("writer")
        )
        .unwrap()
        .status,
        AttemptStatus::Succeeded
    ));
    assert!(matches!(
        run.result
            .blocked
            .iter()
            .find(|block| block.unit.0 == "run/a")
            .unwrap()
            .reason,
        BlockedReason::Blocker { .. }
    ));
    assert_eq!(run.result.reviews[0].review.0, BLOCKER_REVIEW);
    assert!(run.result.wanted.is_empty());
    assert!(matches!(
        run.result
            .snapshot
            .units
            .iter()
            .find(|unit| unit.id.0 == "run/b")
            .unwrap()
            .status,
        UnitStatus::NotStarted
    ));
    run.decide(
        BLOCKER_REVIEW,
        "override",
        BLOCKER_ARTIFACT,
        json!({"answer":"Use A and proceed"}),
    )
    .unwrap();
    assert_eq!(
        run.wanted("writer").resolved.feedback[0].payload,
        json!({"feedback":"Use A and proceed"})
    );
    run.publish("writer", "draft", json!({"findings":[],"text":"A"}));
    run.end("writer");
    assert!(!run
        .result
        .blocked
        .iter()
        .any(|block| block.unit.0 == "run/a"));
    run.decide("draft_review", "accept", "draft", json!({}))
        .unwrap();
    assert!(run
        .result
        .wanted
        .iter()
        .any(|wanted| wanted.unit.0 == "run/b"));
}

#[test]
fn a_running_watch_keeps_observing_while_another_worker_parks_the_unit() {
    let source: Workflow = serde_json::from_value(json!({
        "workflow":"parked_watch", "input":{},
        "run":{"units":{"a":{"stage":"document"}},"outcome":{}},
        "stages":{"document":{"input":{},
            "artifacts":{"draft":{"kind":"document","schema":"text"},
                "observation":{"kind":"document","schema":"text"}},
            "workers":{"writer":{"kind":"agent","prompts":{"initial":"p","revise":"p"},"inputs":{},"produces":["draft"]},
                "observer":{"kind":"code","operation":"observe","inputs":{},"produces":["observation"],"every":"1s"}},
            "done_when":"false","outcome":{}}}
    }))
    .unwrap();
    let observe = [CodeOperation {
        key: SymbolKey::from("observe"),
        input_schema: TypeExpression::Record(BTreeMap::new()),
        output_schema: TypeExpression::Name("text".into()),
        error_codes: vec![],
    }];
    let mut run = Run::with_operations(source, &observe);
    assert_eq!(run.wanted("observer").resolved.prompt, None);
    run.publish(
        "writer",
        BLOCKER_ARTIFACT,
        json!({"text":"Which contract?","suggested_choices":["A","B"]}),
    );
    run.end("writer");
    let watch = attempt(
        &run.result.snapshot,
        &UnitId::from("run/a"),
        &WorkerKey::from("observer"),
    )
    .unwrap()
    .action_id
    .clone();
    run.apply(Event::WorkerStarted {
        action: watch,
        kbbl_session_id: None,
    })
    .unwrap();
    run.publish("observer", "observation", json!("PR open"));
    run.end("observer");
    assert!(matches!(
        run.result
            .blocked
            .iter()
            .find(|block| block.unit.0 == "run/a")
            .unwrap()
            .reason,
        BlockedReason::Blocker { .. }
    ));
}

#[test]
fn clarify_and_discuss_resume_the_same_worker_and_successor_blocker_history() {
    for decision in ["clarify", "discuss"] {
        let mut run = Run::new();
        run.publish("writer", BLOCKER_ARTIFACT, json!({"text":"Ambiguous"}));
        let first = run.result.snapshot.revisions[0].id.clone();
        run.decide(
            BLOCKER_REVIEW,
            decision,
            BLOCKER_ARTIFACT,
            json!({"answer":"More context"}),
        )
        .unwrap();
        assert!(matches!(
            run.wanted("writer").action,
            Action::RunWorker {
                mode: Mode::Revise,
                ..
            }
        ));
        assert_eq!(
            run.wanted("writer").resolved.feedback[0].payload,
            json!({"feedback":"More context"})
        );
        run.publish(
            "writer",
            BLOCKER_ARTIFACT,
            json!({"text":"One more question"}),
        );
        assert_eq!(
            run.result.snapshot.revisions.last().unwrap().predecessor,
            Some(first)
        );
        assert_eq!(run.result.reviews[0].review.0, BLOCKER_REVIEW);
    }
}

#[test]
fn reviewer_can_raise_a_blocker_in_review_and_revise_modes() {
    let mut run = Run::new();
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"A"}),
    );
    run.end("writer");
    assert!(matches!(
        run.wanted("assessor").action,
        Action::RunWorker {
            mode: Mode::Review,
            ..
        }
    ));
    run.publish(
        "assessor",
        BLOCKER_ARTIFACT,
        json!({"text":"Need review context"}),
    );
    run.decide(
        BLOCKER_REVIEW,
        "discuss",
        BLOCKER_ARTIFACT,
        json!({"answer":"Context"}),
    )
    .unwrap();
    assert_eq!(
        run.wanted("assessor").resolved.feedback[0].payload,
        json!({"feedback":"Context"})
    );
    run.publish(
        "assessor",
        BLOCKER_ARTIFACT,
        json!({"text":"Still contradictory"}),
    );
    run.decide(
        BLOCKER_REVIEW,
        "override",
        BLOCKER_ARTIFACT,
        json!({"answer":"Proceed"}),
    )
    .unwrap();
    run.publish("assessor", "assessment", json!("Assessment"));
    run.end("assessor");
    assert!(!run
        .result
        .blocked
        .iter()
        .any(|block| block.unit.0 == "run/a"));
}

#[test]
fn decision_guard_is_reported_with_its_reason_and_refused_at_the_authority_boundary() {
    let mut run = Run::new();
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"A"}),
    );
    run.end("writer");
    let accept = run
        .result
        .reviews
        .iter()
        .find(|review| review.review.0 == "draft_review")
        .unwrap()
        .decisions
        .iter()
        .find(|decision| decision.decision.0 == "accept")
        .unwrap();
    assert_eq!(
        (accept.is_available, accept.disabled_reason.as_deref()),
        (false, Some("Resolve findings first"))
    );
    assert!(
        matches!(run.decide("draft_review", "accept", "draft", json!({})), Err(StepError::Rejected { reason, .. }) if reason == "Resolve findings first")
    );
    run.decide(
        "draft_review",
        "request_changes",
        "draft",
        json!({"entries":["full disposition"],"feedback":"Fix X"}),
    )
    .unwrap();
    assert_eq!(
        run.wanted("writer").resolved.feedback[0].payload,
        json!({"entries":["full disposition"],"feedback":"Fix X"})
    );
    assert_eq!(
        run.wanted("writer").resolved.review_history[0].payload["entries"],
        json!(["full disposition"])
    );
    run.publish("writer", "draft", json!({"findings":[],"text":"Fixed"}));
    run.end("writer");
    run.decide("draft_review", "accept", "draft", json!({}))
        .unwrap();
}

#[test]
fn assessor_review_history_spans_rounds_and_preserves_full_payloads() {
    let mut run = Run::new();
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"A"}),
    );
    run.end("writer");
    run.publish("assessor", "assessment", json!("First"));
    run.end("assessor");
    run.decide(
        "assessment_review",
        "request_build_changes",
        "draft",
        json!({"entries":["disposition"],"feedback":"Fix build"}),
    )
    .unwrap();
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"B"}),
    );
    run.end("writer");
    assert_eq!(
        run.wanted("assessor").resolved.review_history[0].payload["entries"],
        json!(["disposition"])
    );
    run.publish("assessor", "assessment", json!("Second"));
    run.end("assessor");
    run.decide(
        "assessment_review",
        "request_assessment_changes",
        "assessment",
        json!({"feedback":"Reassess"}),
    )
    .unwrap();
    let resolved = &run.wanted("assessor").resolved;
    assert_eq!(
        resolved
            .review_history
            .iter()
            .map(|entry| entry.decision.0.as_str())
            .collect::<Vec<_>>(),
        ["request_build_changes", "request_assessment_changes"]
    );
    assert_eq!(resolved.feedback[0].payload, json!({"feedback":"Reassess"}));
}

#[test]
fn integrator_review_mode_receives_integration_decisions_across_rounds() {
    let mut source = source();
    let stage = source.stages.get_mut("document").unwrap();
    let integrator = stage.workers.remove("assessor").unwrap();
    stage.workers.insert("integrator".into(), integrator);
    let review = stage.reviews.remove("assessment_review").unwrap();
    stage.reviews.insert("integration_review".into(), review);
    let mut run = Run::with_source(source);
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"A"}),
    );
    run.end("writer");
    run.publish("integrator", "assessment", json!("First"));
    run.end("integrator");
    run.decide(
        "integration_review",
        "request_build_changes",
        "draft",
        json!({"entries":["integration disposition"],"feedback":"Fix integration"}),
    )
    .unwrap();
    run.publish(
        "writer",
        "draft",
        json!({"findings":["blocking"],"text":"B"}),
    );
    run.end("writer");
    let wanted = run.wanted("integrator");
    assert!(matches!(
        wanted.action,
        Action::RunWorker {
            mode: Mode::Review,
            ..
        }
    ));
    assert_eq!(
        wanted.resolved.review_history[0].review.0,
        "integration_review"
    );
    assert_eq!(
        wanted.resolved.review_history[0].payload["entries"],
        json!(["integration disposition"])
    );
}

#[test]
fn cancelling_a_parked_run_clears_its_open_blocker_attention() {
    let mut run = Run::new();
    run.publish("writer", BLOCKER_ARTIFACT, json!({"text":"Question"}));
    run.apply(Event::CancelRequested).unwrap();
    assert!(run.result.blocked.is_empty());
    assert!(run.result.reviews.is_empty());
    assert!(run.result.wanted.is_empty());
}

#[test]
fn retrying_a_failed_blocker_resume_retains_the_operator_answer() {
    let mut run = Run::new();
    run.publish("writer", BLOCKER_ARTIFACT, json!({"text":"Question"}));
    run.decide(
        BLOCKER_REVIEW,
        "clarify",
        BLOCKER_ARTIFACT,
        json!({"answer":"Use A"}),
    )
    .unwrap();
    let action = run.wanted("writer").action_id.clone();
    run.apply(Event::WorkerEnded {
        action,
        result: WorkerResult::Failed {
            code: "test_failure".into(),
            detail: "try again".into(),
        },
    })
    .unwrap();
    run.result = step(
        &run.program,
        &run.result.snapshot,
        &Incoming {
            event: Event::RetryRequested {
                unit: UnitId::from("run/a"),
                worker: WorkerKey::from("writer"),
            },
            writer: Writer::Engine,
            ingress_id: Some("retry-1".into()),
        },
    )
    .unwrap();
    assert!(matches!(
        run.wanted("writer").action,
        Action::RunWorker {
            cause: Cause::Retry { .. },
            ..
        }
    ));
    assert_eq!(
        run.wanted("writer").resolved.feedback[0].payload,
        json!({"feedback":"Use A"})
    );
}
