//! Step semantics of the constructs rescue R5 adds (part 1 §12, "Recorded
//! with rescue R5"), driven over the R5 fixture: admission as a guarded
//! worker, a guarded periodic observer, an engine review, list validations,
//! operator edits (D2), enums (D3) and agent republishes.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::compile_workflow;
use workflow_evaluator::step;
use workflow_model::*;

fn program() -> CheckedWorkflow {
    let source: Workflow =
        serde_json::from_str(include_str!("../../../fixtures/bundles/r5-cohort.json")).unwrap();
    let prompts: BTreeMap<String, String> = [
        ("plan.md", ""),
        ("build.md", "{{brief}}"),
        ("assess.md", "{{subject}}"),
        ("review.md", ""),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect();
    let ty = |text: &str| TypeExpression::Name(text.into());
    let operations = vec![
        CodeOperation {
            key: SymbolKey::from("value.publish"),
            input_schema: TypeExpression::Record(BTreeMap::from([("value".into(), ty("$value"))])),
            output_schema: ty("$value"),
            error_codes: vec![],
        },
        CodeOperation {
            key: SymbolKey::from("pull.observe"),
            input_schema: TypeExpression::Record(BTreeMap::from([("url".into(), ty("text"))])),
            output_schema: TypeExpression::Record(BTreeMap::from([(
                "state".into(),
                ty("enum(open, merged, closed_unmerged)"),
            )])),
            error_codes: vec![],
        },
    ];
    compile_workflow(&source, &operations, &prompts).unwrap()
}

const PLAN: &str = "run/plan";
const COHORT: &str = "run/cohort";
const PR_URL: &str = "https://forge/pr/1";

/// A run driven event by event, each event attested by its writer.
struct Run {
    program: CheckedWorkflow,
    state: StepSnapshot,
    last: Option<StepResult>,
    count: usize,
}
impl Run {
    fn launch(admission: bool) -> Self {
        let mut run = Self {
            program: program(),
            state: StepSnapshot {
                run: RunState {
                    id: "run".into(),
                    root: UnitId::from("run"),
                },
                units: vec![],
                attempts: vec![],
                revisions: vec![],
                decisions: vec![],
                retry_events: vec![],
            },
            last: None,
            count: 0,
        };
        run.apply(
            Event::Launched {
                input: launch_input(admission, "pass"),
            },
            Writer::Engine,
        )
        .unwrap();
        run
    }
    fn apply(&mut self, event: Event, writer: Writer) -> Result<&StepResult, StepError> {
        self.count += 1;
        let incoming = Incoming {
            event,
            writer,
            ingress_id: Some(format!("event:{}", self.count)),
        };
        let result = step(&self.program, &self.state, &incoming)?;
        self.state = result.snapshot.clone();
        self.last = Some(result);
        Ok(self.last.as_ref().unwrap())
    }
    fn action(&self, unit: &str, worker: &str) -> ActionKey {
        self.state
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.unit.0 == unit && attempt.worker.0 == worker)
            .unwrap_or_else(|| panic!("no attempt of {worker}"))
            .action_id
            .clone()
    }
    fn wanted(&self, unit: &str) -> Vec<(String, Mode)> {
        self.last
            .as_ref()
            .unwrap()
            .wanted
            .iter()
            .filter(|wanted| wanted.unit.0 == unit)
            .map(|wanted| match &wanted.action {
                Action::RunWorker { worker, mode, .. } => (worker.0.clone(), mode.clone()),
            })
            .collect()
    }
    fn wants(&self, unit: &str, worker: &str) -> bool {
        self.wanted(unit).iter().any(|(key, _)| key == worker)
    }
    fn latest(&self, unit: &str, artifact: &str) -> Option<&RevisionState> {
        self.state
            .revisions
            .iter()
            .rev()
            .find(|revision| revision.unit.0 == unit && revision.artifact.0 == artifact)
    }
    fn publish(
        &mut self,
        unit: &str,
        worker: &str,
        artifact: &str,
        body: Value,
    ) -> Result<&StepResult, StepError> {
        let by = self.action(unit, worker);
        let predecessor = self
            .latest(unit, artifact)
            .map(|revision| revision.id.clone());
        let subject =
            (worker == "assessor").then(|| self.latest(unit, "build").unwrap().id.clone());
        let writer = Writer::Executor {
            attempt: by.clone(),
        };
        self.apply(
            Event::RevisionPublished {
                unit: UnitId::from(unit),
                artifact: SymbolKey::from(artifact),
                body,
                predecessor,
                subject,
                by: Some(by),
            },
            writer,
        )
    }
    fn start(&mut self, unit: &str, worker: &str) {
        let action = self.action(unit, worker);
        self.apply(
            Event::WorkerStarted {
                action: action.clone(),
                kbbl_session_id: None,
            },
            Writer::Executor { attempt: action },
        )
        .unwrap();
    }
    fn end(&mut self, unit: &str, worker: &str) {
        let action = self.action(unit, worker);
        self.apply(
            Event::WorkerEnded {
                action: action.clone(),
                result: WorkerResult::Succeeded,
            },
            Writer::Executor { attempt: action },
        )
        .unwrap();
    }
    fn decide(
        &mut self,
        unit: &str,
        review: &str,
        decision: &str,
        artifact: &str,
        payload: Value,
    ) -> Result<&StepResult, StepError> {
        let target = self.latest(unit, artifact).unwrap().id.clone();
        self.apply(
            Event::OperatorDecided {
                unit: UnitId::from(unit),
                review: SymbolKey::from(review),
                decision: SymbolKey::from(decision),
                target,
                payload,
            },
            operator(),
        )
    }
    fn status(&self, unit: &str) -> &UnitStatus {
        &self
            .state
            .units
            .iter()
            .find(|candidate| candidate.id.0 == unit)
            .unwrap()
            .status
    }
    /// Plan published and accepted, so the cohort is active.
    fn through_plan(admission: bool) -> Self {
        let mut run = Self::launch(admission);
        run.start(PLAN, "planner");
        run.publish(PLAN, "planner", "plan", plan(&[("a", &[], "repo")]))
            .unwrap();
        run.end(PLAN, "planner");
        run.decide(PLAN, "plan_review", "accept", "plan", json!({}))
            .unwrap();
        run
    }
    /// The builder has published its build and its PR.
    fn through_build(admission: bool) -> Self {
        let mut run = Self::through_plan(admission);
        run.publish_brief();
        if admission {
            run.decide(COHORT, "admission", "admit", "brief", json!({}))
                .unwrap();
        }
        run.start(COHORT, "builder");
        run.publish(COHORT, "builder", "build", json!({ "summary": "built" }))
            .unwrap();
        run.publish(COHORT, "builder", "pr", pr_body()).unwrap();
        run.end(COHORT, "builder");
        run
    }
    fn publish_brief(&mut self) {
        self.start(COHORT, "admit");
        self.publish(COHORT, "admit", "brief", brief()).unwrap();
        self.end(COHORT, "admit");
    }
    fn observe(&mut self, state: &str) {
        self.start(COHORT, "pr_watch");
        self.publish(COHORT, "pr_watch", "pr_state", json!({ "state": state }))
            .unwrap();
        self.end(COHORT, "pr_watch");
    }
}
fn operator() -> Writer {
    Writer::Operator {
        subject: OperatorId::from("steve"),
    }
}
fn brief() -> Value {
    json!({ "title": "Cohort A", "depends_on": [], "repository_key": "repo" })
}
fn pr_body() -> Value {
    json!({ "pr_url": PR_URL, "branch": "cohort-a" })
}
fn launch_input(admission: bool, verdict: &str) -> Value {
    json!({ "brief": brief(), "admission": admission, "verdict": verdict })
}
fn plan(cohorts: &[(&str, &[&str], &str)]) -> Value {
    json!({ "cohorts": cohorts.iter().map(|(id, after, repository)| json!({
        "id": id, "depends_on": after, "repository_key": repository })).collect::<Vec<_>>() })
}
fn feedback_of(run: &Run, unit: &str) -> Vec<String> {
    run.state
        .decisions
        .iter()
        .filter(|decision| decision.unit().0 == unit)
        .map(|decision| {
            decision.payload()["feedback"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        })
        .collect()
}

#[test]
fn an_enum_input_outside_its_variants_fails_the_launch_schema() {
    let mut state = Run::launch(false).state;
    state.units.clear();
    state.attempts.clear();
    let refused = step(
        &program(),
        &state,
        &Incoming {
            event: Event::Launched {
                input: launch_input(false, "maybe"),
            },
            writer: Writer::Engine,
            ingress_id: None,
        },
    );
    assert!(
        matches!(refused, Err(StepError::Rejected { reason, .. }) if reason == "launch input fails schema")
    );
}

#[test]
fn a_valid_plan_publishes_without_validator_feedback() {
    let run = Run::through_plan(false);
    assert!(feedback_of(&run, PLAN).iter().all(String::is_empty));
    assert!(
        matches!(run.status(PLAN), UnitStatus::Done { outcome } if outcome["cohorts"] == json!(["a"]))
    );
}

#[test]
fn list_validations_name_each_broken_plan_rule() {
    for (cohorts, message) in [
        (plan(&[]), "the plan names no cohort"),
        (
            plan(&[("a", &["b"], "repo"), ("b", &["a"], "repo")]),
            "cohort ids or dependencies are invalid",
        ),
        (
            plan(&[("a", &["missing"], "repo")]),
            "cohort ids or dependencies are invalid",
        ),
        (
            plan(&[("a", &[], "repo"), ("a", &[], "repo")]),
            "cohort ids or dependencies are invalid",
        ),
        (
            plan(&[("a", &[], "elsewhere")]),
            "a cohort names an unknown repository",
        ),
    ] {
        let mut run = Run::launch(false);
        run.start(PLAN, "planner");
        run.publish(PLAN, "planner", "plan", cohorts.clone())
            .unwrap();
        assert_eq!(
            feedback_of(&run, PLAN),
            vec![message.to_owned()],
            "{cohorts}"
        );
    }
}

#[test]
fn with_admission_the_builder_waits_for_the_operator_to_admit_the_brief() {
    let mut run = Run::through_plan(true);
    assert!(run.wants(COHORT, "admit"));
    assert!(!run.wants(COHORT, "builder"));
    run.publish_brief();
    assert!(!run.wants(COHORT, "builder"));
    let awaiting: Vec<_> = run
        .last
        .as_ref()
        .unwrap()
        .reviews
        .iter()
        .map(|review| review.review.0.clone())
        .collect();
    assert_eq!(awaiting, vec!["admission".to_owned()]);
    run.decide(COHORT, "admission", "admit", "brief", json!({}))
        .unwrap();
    assert!(run.wants(COHORT, "builder"));
}

#[test]
fn without_admission_the_builder_starts_at_once_and_the_admission_review_stays_closed() {
    let mut run = Run::through_plan(false);
    assert!(run.wants(COHORT, "builder"));
    run.publish_brief();
    assert!(run.last.as_ref().unwrap().reviews.is_empty());
    let refused = run.decide(COHORT, "admission", "admit", "brief", json!({}));
    assert!(
        matches!(refused, Err(StepError::Rejected { reason, .. }) if reason == "review is not open")
    );
}

#[test]
fn a_periodic_observer_waits_until_its_guard_and_inputs_resolve() {
    let mut run = Run::through_plan(false);
    run.publish_brief();
    assert!(!run.wants(COHORT, "pr_watch"));
    run.start(COHORT, "builder");
    run.publish(COHORT, "builder", "build", json!({ "summary": "built" }))
        .unwrap();
    assert!(!run.wants(COHORT, "pr_watch"));
    run.publish(COHORT, "builder", "pr", pr_body()).unwrap();
    assert!(run.wants(COHORT, "pr_watch"));
    let resolved = run
        .last
        .as_ref()
        .unwrap()
        .wanted
        .iter()
        .find(|r| r.action_id == run.action(COHORT, "pr_watch"))
        .unwrap();
    assert_eq!(resolved.resolved.inputs, json!({ "url": PR_URL }));
}

#[test]
fn a_closed_unmerged_pr_requests_build_changes_once_per_build_revision() {
    let mut run = Run::through_build(false);
    run.observe("closed_unmerged");
    let build = run.latest(COHORT, "build").unwrap().id.clone();
    let engine: Vec<_> = run
        .state
        .decisions
        .iter()
        .filter(|d| d.review().is_some_and(|review| review.0 == "pr_closed"))
        .cloned()
        .collect();
    assert_eq!(engine.len(), 1);
    assert_eq!(engine[0].target(), &build);
    assert!(matches!(
        engine[0].effect(),
        Some(DecisionEffect::RequestChanges { .. })
    ));
    assert_eq!(
        engine[0].payload(),
        json!({ "feedback": "The PR was closed without merging. Open a new one." })
    );
    let revise = run
        .state
        .attempts
        .iter()
        .rev()
        .find(|attempt| attempt.worker.0 == "builder")
        .unwrap();
    assert_eq!(revise.mode, Mode::Revise);
    assert_eq!(
        revise.cause,
        Cause::ChangesRequested {
            decision: engine[0].id().clone()
        }
    );
    // Another observation of the same state decides nothing new.
    run.observe("closed_unmerged");
    assert_eq!(
        run.state
            .decisions
            .iter()
            .filter(|d| d.review().is_some_and(|review| review.0 == "pr_closed"))
            .count(),
        1
    );
}

#[test]
fn an_operator_cannot_decide_an_engine_review() {
    let mut run = Run::through_build(false);
    let absent = run.decide(
        COHORT,
        "pr_closed",
        "missing",
        "build",
        json!({ "feedback": "x" }),
    );
    assert!(
        matches!(absent, Err(StepError::Rejected { reason, .. }) if reason == "decision absent")
    );
    let refused = run.decide(
        COHORT,
        "pr_closed",
        "replace",
        "build",
        json!({ "feedback": "x" }),
    );
    assert!(
        matches!(refused, Err(StepError::Rejected { reason, .. }) if reason == "the engine decides this review")
    );
}

#[test]
fn the_cohort_is_done_once_its_assessment_is_accepted_and_its_pr_is_merged() {
    let mut run = Run::through_build(false);
    run.start(COHORT, "assessor");
    run.publish(
        COHORT,
        "assessor",
        "assessment",
        json!({ "verdict": "pass" }),
    )
    .unwrap();
    run.end(COHORT, "assessor");
    run.decide(
        COHORT,
        "assessment_review",
        "accept",
        "assessment",
        json!({}),
    )
    .unwrap();
    assert!(matches!(run.status(COHORT), UnitStatus::Active));
    run.observe("merged");
    assert!(matches!(run.status(COHORT), UnitStatus::Done { .. }));
    assert!(matches!(run.status("run"), UnitStatus::Done { .. }));
}

#[test]
fn an_assessment_outside_its_enum_fails_its_schema() {
    let mut run = Run::through_build(false);
    run.start(COHORT, "assessor");
    let refused = run.publish(
        COHORT,
        "assessor",
        "assessment",
        json!({ "verdict": "maybe" }),
    );
    assert!(
        matches!(refused, Err(StepError::Rejected { reason, .. }) if reason == "artifact body fails schema")
    );
}

#[test]
fn an_operator_edit_is_a_revision_no_attempt_published() {
    let mut run = Run::through_build(false);
    let predecessor = run.latest(COHORT, "build").unwrap().id.clone();
    run.apply(
        Event::RevisionPublished {
            unit: UnitId::from(COHORT),
            artifact: SymbolKey::from("build"),
            body: json!({ "summary": "edited by the operator" }),
            predecessor: Some(predecessor.clone()),
            subject: None,
            by: None,
        },
        operator(),
    )
    .unwrap();
    let edit = run.latest(COHORT, "build").unwrap();
    assert_eq!(edit.by, None);
    assert_eq!(edit.predecessor, Some(predecessor));
}

#[test]
fn a_revision_names_an_attempt_exactly_when_its_writer_is_not_the_operator() {
    let mut run = Run::through_build(false);
    let predecessor = run
        .latest(COHORT, "build")
        .map(|revision| revision.id.clone());
    let edit = |by: Option<ActionKey>| Event::RevisionPublished {
        unit: UnitId::from(COHORT),
        artifact: SymbolKey::from("build"),
        body: json!({ "summary": "edited" }),
        predecessor: predecessor.clone(),
        subject: None,
        by,
    };
    let builder = run.action(COHORT, "builder");
    for (event, writer, reason) in [
        (
            edit(Some(builder.clone())),
            operator(),
            "an operator's revision names no attempt",
        ),
        (
            edit(None),
            Writer::Executor { attempt: builder },
            "a revision that names no attempt must be the operator's",
        ),
    ] {
        let refused = run.apply(event, writer);
        assert!(
            matches!(refused, Err(StepError::Rejected { reason: actual, .. }) if actual == reason)
        );
    }
}

#[test]
fn an_operator_cannot_edit_a_code_workers_artifact() {
    let mut run = Run::through_build(false);
    let predecessor = run
        .latest(COHORT, "brief")
        .map(|revision| revision.id.clone());
    let refused = run.apply(
        Event::RevisionPublished {
            unit: UnitId::from(COHORT),
            artifact: SymbolKey::from("brief"),
            body: brief(),
            predecessor,
            subject: None,
            by: None,
        },
        operator(),
    );
    assert!(
        matches!(refused, Err(StepError::Rejected { reason, .. }) if reason.contains("code worker"))
    );
}

#[test]
fn a_revise_that_republishes_an_unchanged_artifact_still_publishes_it() {
    let mut run = Run::through_build(false);
    run.start(COHORT, "assessor");
    run.publish(
        COHORT,
        "assessor",
        "assessment",
        json!({ "verdict": "fail" }),
    )
    .unwrap();
    run.end(COHORT, "assessor");
    run.decide(
        COHORT,
        "assessment_review",
        "request_build_changes",
        "build",
        json!({ "feedback": "fix it" }),
    )
    .unwrap();
    run.start(COHORT, "builder");
    run.publish(COHORT, "builder", "build", json!({ "summary": "fixed" }))
        .unwrap();
    // The PR is the same one; the revise publishes it unchanged.
    run.publish(COHORT, "builder", "pr", pr_body()).unwrap();
    run.end(COHORT, "builder");
    let builder = run.action(COHORT, "builder");
    let attempt = run
        .state
        .attempts
        .iter()
        .rev()
        .find(|attempt| attempt.action_id == builder)
        .unwrap();
    assert_eq!(attempt.status, AttemptStatus::Succeeded);
    let prs = run
        .state
        .revisions
        .iter()
        .filter(|revision| revision.artifact.0 == "pr")
        .count();
    assert_eq!(prs, 2);
}

#[test]
fn an_engine_review_waits_for_the_revise_it_asked_for_to_publish_everything() {
    let mut run = Run::through_build(false);
    run.observe("closed_unmerged");
    let pr_closed = |run: &Run| {
        run.state
            .decisions
            .iter()
            .filter(|d| d.review().is_some_and(|review| review.0 == "pr_closed"))
            .count()
    };
    assert_eq!(pr_closed(&run), 1);
    run.start(COHORT, "builder");
    // The new build is published before the replacement PR; the old PR still reads closed.
    run.publish(COHORT, "builder", "build", json!({ "summary": "rebuilt" }))
        .unwrap();
    assert_eq!(pr_closed(&run), 1);
    run.publish(
        COHORT,
        "builder",
        "pr",
        json!({ "pr_url": "https://forge/pr/2", "branch": "cohort-a" }),
    )
    .unwrap();
    run.end(COHORT, "builder");
    assert_eq!(pr_closed(&run), 1);
}

/// The cohort's builder replaces its closed PR: build and PR republished,
/// the PR at a new url, so the watch's inputs change.
fn through_replaced_pr() -> Run {
    let mut run = Run::through_build(false);
    run.observe("closed_unmerged");
    run.start(COHORT, "builder");
    run.publish(COHORT, "builder", "build", json!({ "summary": "rebuilt" }))
        .unwrap();
    run.publish(
        COHORT,
        "builder",
        "pr",
        json!({ "pr_url": "https://forge/pr/2", "branch": "cohort-a" }),
    )
    .unwrap();
    run.end(COHORT, "builder");
    run
}
fn pr_closed_targets(run: &Run) -> Vec<RevisionId> {
    run.state
        .decisions
        .iter()
        .filter(|d| d.review().is_some_and(|review| review.0 == "pr_closed"))
        .map(|d| d.target().clone())
        .collect()
}

#[test]
fn a_replaced_pr_is_judged_only_once_the_replacing_watch_has_observed_it() {
    let mut run = through_replaced_pr();
    // The latest pr_state still reads the closed PR, but that watch is replaced.
    assert_eq!(
        run.latest(COHORT, "pr_state").unwrap().body,
        json!({ "state": "closed_unmerged" })
    );
    assert!(matches!(
        &run.state
            .attempts
            .iter()
            .rev()
            .find(|a| a.worker.0 == "pr_watch")
            .unwrap()
            .cause,
        Cause::Periodic {
            replaces: Some(_),
            ..
        }
    ));
    assert_eq!(pr_closed_targets(&run).len(), 1);
    run.observe("open");
    assert_eq!(pr_closed_targets(&run).len(), 1);
}

#[test]
fn a_replacing_pr_that_closes_unmerged_requests_changes_on_the_new_build() {
    let mut run = through_replaced_pr();
    run.observe("closed_unmerged");
    let rebuilt = run.latest(COHORT, "build").unwrap().id.clone();
    let targets = pr_closed_targets(&run);
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[1], rebuilt);
}

#[test]
fn a_merge_observed_of_a_replaced_pr_does_not_complete_the_cohort() {
    let mut run = Run::through_build(false);
    run.start(COHORT, "assessor");
    run.publish(
        COHORT,
        "assessor",
        "assessment",
        json!({ "verdict": "pass" }),
    )
    .unwrap();
    run.end(COHORT, "assessor");
    // The PR moves to a new url before the assessment is accepted; the old watch saw a merge.
    run.observe("merged");
    run.decide(
        COHORT,
        "assessment_review",
        "request_build_changes",
        "build",
        json!({ "feedback": "redo" }),
    )
    .unwrap();
    run.start(COHORT, "builder");
    run.publish(COHORT, "builder", "build", json!({ "summary": "redone" }))
        .unwrap();
    run.publish(
        COHORT,
        "builder",
        "pr",
        json!({ "pr_url": "https://forge/pr/2", "branch": "cohort-a" }),
    )
    .unwrap();
    run.end(COHORT, "builder");
    run.start(COHORT, "assessor");
    run.publish(
        COHORT,
        "assessor",
        "assessment",
        json!({ "verdict": "pass" }),
    )
    .unwrap();
    run.end(COHORT, "assessor");
    run.decide(
        COHORT,
        "assessment_review",
        "accept",
        "assessment",
        json!({}),
    )
    .unwrap();
    assert!(matches!(run.status(COHORT), UnitStatus::Active));
    run.observe("open");
    assert!(matches!(run.status(COHORT), UnitStatus::Active));
    run.observe("merged");
    assert!(matches!(run.status(COHORT), UnitStatus::Done { .. }));
}
