//! The development workflow's task contracts, driven through the real bundle,
//! prompts and operation registry: declared plan and brief validation, the
//! approval guard at the operator-decision boundary, and the repository's
//! briefs reaching integration.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_evaluator::*;
use workflow_model::*;

const UNKNOWN_TASK: &str =
    "Every cohort acceptance id must be the id of a task in the approved task list.";
const MISSING_TASK: &str =
    "Every task in the approved task list must appear in at least one cohort's acceptance_criteria.";
const REPEATED_TASK: &str = "A task id may appear only once within a cohort's acceptance_criteria; repeating it in another cohort is valid.";
const BRIEF_IDS: &str =
    "The brief's acceptance_criteria ids must be its plan cohort's, in the same order.";
const REFUSED: &str = "target revision failed validation";

fn development() -> CheckedWorkflow {
    let config = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let read = |path: std::path::PathBuf| std::fs::read_to_string(path).expect("readable");
    let operations: Vec<CodeOperation> =
        serde_json::from_str(&read(config.join("operation-registry.json"))).unwrap();
    let prompts: BTreeMap<String, String> = std::fs::read_dir(config.join("prompts/development"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (format!("development/{name}"), read(path))
        })
        .collect();
    let source =
        decode_workflow(include_str!("../../../fixtures/bundles/development.json").as_bytes())
            .unwrap();
    compile_workflow(&source, &operations, &prompts).unwrap()
}

fn repository(key: &str) -> Value {
    json!({
        "key": key,
        "preparation": {"repository_path": format!("/repos/{key}"), "expected_head": null},
        "forge": {"owner": "acme", "name": key, "build_base": "epic", "final_base": "main"}
    })
}

fn workspace(key: &str) -> Value {
    json!({"repository_path": format!("/repos/{key}"), "push_remote_owner": "acme",
           "head": "abc", "base_branch": "epic"})
}

fn tasks(ids: &[&str]) -> Value {
    let tasks: Vec<Value> = ids
        .iter()
        .map(|id| json!({"id": id, "description": format!("Obligation {id}"), "requirement_ids": []}))
        .collect();
    json!({ "tasks": tasks })
}

fn entries(ids: &[&str]) -> Vec<Value> {
    ids.iter()
        .map(|id| json!({"id": id, "text": format!("Deliver {id}"), "decision_ids": []}))
        .collect()
}

fn cohort(id: &str, repository_key: &str, depends_on: &[&str], task_ids: &[&str]) -> Value {
    json!({
        "id": id, "repository_key": repository_key, "title": id, "scope": "scope",
        "depends_on": depends_on, "files_in_scope": [], "decisions": [],
        "acceptance_criteria": entries(task_ids)
    })
}

fn plan(cohorts: &[Value]) -> Value {
    json!({
        "summary": "summary", "cohorts": cohorts, "dependency_order": [],
        "scope": {"in_scope": [], "out_of_scope": []},
        "acceptance_criteria": [], "risks": []
    })
}

fn brief_of(cohort: &Value) -> Value {
    json!({
        "cohort_id": cohort["id"], "repository_key": cohort["repository_key"],
        "title": cohort["title"], "depends_on": cohort["depends_on"], "goal": "goal",
        "files_in_scope": [], "decisions_made": [], "approaches_rejected": [],
        "acceptance_criteria": cohort["acceptance_criteria"], "next_action": "start"
    })
}

fn build(head_sha: &str) -> Value {
    json!({"head_sha": head_sha, "summary": "built", "changed_files": [],
           "tests": {"passed": 1, "failed": 0}, "known_issues": []})
}

fn pr(key: &str, branch: &str) -> Value {
    json!({"pr_url": format!("https://forge/{key}/{branch}"), "branch": branch, "summary": "pr"})
}

/// A run driven one event at a time, with the last step's result kept for its
/// wanted workers and awaiting reviews.
struct Run {
    program: CheckedWorkflow,
    last: StepResult,
    count: usize,
}

impl Run {
    fn launch(repositories: &[&str]) -> Self {
        let program = development();
        let input = json!({
            "title": "t", "spec": "s",
            "repositories": repositories.iter().map(|key| repository(key)).collect::<Vec<_>>(),
            "primary_repository_key": repositories[0],
            "final_merge_policy": "require_merge"
        });
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
        let last = step(
            &program,
            &snapshot,
            &Incoming {
                event: Event::Launched { input },
                writer: Writer::Engine,
                ingress_id: Some("launch".into()),
            },
        )
        .unwrap();
        Self {
            program,
            last,
            count: 0,
        }
    }

    fn apply(&mut self, event: Event, writer: Writer) -> Result<(), StepError> {
        self.count += 1;
        let incoming = Incoming {
            event,
            writer,
            ingress_id: Some(format!("event:{}", self.count)),
        };
        self.last = step(&self.program, &self.last.snapshot, &incoming)?;
        Ok(())
    }

    fn state(&self) -> &StepSnapshot {
        &self.last.snapshot
    }

    fn action(&self, unit: &str, worker: &str) -> ActionKey {
        self.state()
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.unit.0 == unit && attempt.worker.0 == worker)
            .unwrap_or_else(|| panic!("no attempt of {unit} {worker}: {:?}", self.units()))
            .action_id
            .clone()
    }

    fn units(&self) -> Vec<String> {
        self.state()
            .units
            .iter()
            .map(|unit| unit.id.0.clone())
            .collect()
    }

    fn has_unit(&self, id: &str) -> bool {
        self.state().units.iter().any(|unit| unit.id.0 == id)
    }

    fn is_done(&self, id: &str) -> bool {
        self.state()
            .units
            .iter()
            .any(|unit| unit.id.0 == id && matches!(unit.status, UnitStatus::Done { .. }))
    }

    fn latest_id(&self, unit: &str, artifact: &str) -> Option<RevisionId> {
        latest(
            self.state(),
            &UnitId::from(unit),
            &SymbolKey::from(artifact),
        )
        .map(|revision| revision.id.clone())
    }

    fn publish(
        &mut self,
        unit: &str,
        worker: &str,
        artifact: &str,
        body: Value,
        subject: Option<RevisionId>,
    ) {
        let event = Event::RevisionPublished {
            unit: UnitId::from(unit),
            artifact: SymbolKey::from(artifact),
            body,
            predecessor: self.latest_id(unit, artifact),
            subject,
            by: Some(self.action(unit, worker)),
        };
        self.apply(event, Writer::Engine).unwrap();
    }

    fn end(&mut self, unit: &str, worker: &str) {
        let event = Event::WorkerEnded {
            action: self.action(unit, worker),
            result: WorkerResult::Succeeded,
        };
        self.apply(event, Writer::Engine).unwrap();
    }

    fn write(&mut self, unit: &str, worker: &str, artifact: &str, body: Value) {
        self.publish(unit, worker, artifact, body, None);
        self.end(unit, worker);
    }

    fn decide(
        &mut self,
        unit: &str,
        review: &str,
        decision: &str,
        artifact: &str,
        payload: Value,
    ) -> Result<(), StepError> {
        let event = Event::OperatorDecided {
            unit: UnitId::from(unit),
            review: SymbolKey::from(review),
            decision: SymbolKey::from(decision),
            target: self.latest_id(unit, artifact).expect("published"),
            payload,
        };
        self.apply(event, Writer::Engine)
    }

    fn accept(&mut self, unit: &str, review: &str, artifact: &str) -> Result<(), StepError> {
        self.decide(unit, review, "accept", artifact, json!({}))
    }

    fn request_changes(&mut self, unit: &str, review: &str, artifact: &str) {
        self.decide(
            unit,
            review,
            "request_changes",
            artifact,
            json!({"feedback": "Correct it"}),
        )
        .unwrap();
    }

    /// Messages recorded by validation on the artifact's latest revision.
    fn validation_messages(&self, unit: &str, artifact: &str) -> Vec<String> {
        let latest = self.latest_id(unit, artifact).expect("published");
        self.state()
            .decisions
            .iter()
            .filter_map(|decision| match decision {
                DecisionState::Validation {
                    target, messages, ..
                } if *target == latest => Some(messages.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn review_decisions(&self, unit: &str) -> usize {
        self.state()
            .decisions
            .iter()
            .filter(|decision| {
                decision.unit().0 == unit && matches!(decision, DecisionState::Review { .. })
            })
            .count()
    }

    fn prepare_and_analyze(&mut self, repositories: &[&str], task_ids: &[&str]) {
        for key in repositories {
            self.write(
                &format!("run/prepare/{key}"),
                "git",
                "workspace",
                workspace(key),
            );
        }
        let analysis = "run/analysis";
        self.write(
            analysis,
            "author",
            "analysis",
            json!({
                "summary": "s", "source_spec_refs": [], "findings": [], "requirements": [],
                "risks": [], "proposed_spec_updates": []
            }),
        );
        self.accept(analysis, "analysis_review", "analysis")
            .unwrap();
        self.publish(analysis, "spec_editor", "spec", json!("revised"), None);
        self.write(analysis, "spec_editor", "tasks", tasks(task_ids));
        self.accept(analysis, "spec_review", "spec").unwrap();
        self.accept(analysis, "tasks_review", "tasks").unwrap();
    }

    fn accepted_plan(&mut self, cohorts: &[Value]) {
        self.write("run/planning", "planner", "plan", plan(cohorts));
        self.accept("run/planning", "plan_review", "plan").unwrap();
    }

    fn accepted_brief(&mut self, cohort: &Value) {
        let unit = format!("run/briefs/{}", cohort["id"].as_str().unwrap());
        self.write(&unit, "writer", "brief", brief_of(cohort));
        self.accept(&unit, "brief_review", "brief").unwrap();
    }

    fn completed_cohort(&mut self, id: &str, key: &str) {
        let unit = format!("run/implementation/{id}");
        self.publish(&unit, "builder", "pr", pr(key, id), None);
        self.write(&unit, "builder", "build_result", build("build-sha"));
        let subject = self.latest_id(&unit, "build_result");
        self.publish(
            &unit,
            "assessor",
            "assessment",
            assessment("build-sha", json!([])),
            subject,
        );
        self.end(&unit, "assessor");
        self.accept(&unit, "assessment_review", "assessment")
            .unwrap();
        self.decide(
            &unit,
            "merge_confirmation",
            "confirm_merged",
            "pr",
            json!({}),
        )
        .unwrap();
    }
}

fn assessment(head_sha: &str, findings: Value) -> Value {
    json!({"head_sha": head_sha, "verdict": "pass", "findings": findings,
           "recommended_next_actions": []})
}

fn at_planning(task_ids: &[&str]) -> Run {
    let mut run = Run::launch(&["oakridge"]);
    run.prepare_and_analyze(&["oakridge"], task_ids);
    run
}

/// The messages a published plan fails with.
fn plan_failures(task_ids: &[&str], cohorts: &[Value]) -> Vec<String> {
    let mut run = at_planning(task_ids);
    run.publish("run/planning", "planner", "plan", plan(cohorts), None);
    run.validation_messages("run/planning", "plan")
}

#[test]
fn a_plan_naming_a_task_off_the_approved_list_fails() {
    let cohorts = [cohort("a", "oakridge", &[], &["T1", "AC9"])];
    assert_eq!(plan_failures(&["T1"], &cohorts), [UNKNOWN_TASK]);
}

#[test]
fn a_plan_leaving_a_task_uncovered_fails() {
    let cohorts = [cohort("a", "oakridge", &[], &["T1"])];
    assert_eq!(plan_failures(&["T1", "T2"], &cohorts), [MISSING_TASK]);
}

#[test]
fn a_plan_repeating_a_task_within_a_cohort_fails() {
    let cohorts = [cohort("a", "oakridge", &[], &["T1", "T1"])];
    assert_eq!(plan_failures(&["T1"], &cohorts), [REPEATED_TASK]);
}

#[test]
fn a_task_shared_by_two_cohorts_passes() {
    let cohorts = [
        cohort("a", "oakridge", &[], &["T1", "T7"]),
        cohort("b", "oakridge", &["a"], &["T2", "T7"]),
    ];
    assert_eq!(
        plan_failures(&["T1", "T2", "T7"], &cohorts),
        Vec::<String>::new()
    );
}

#[test]
fn a_plan_keeps_its_metadata_checks_beside_the_task_checks() {
    let cohorts = [cohort("a", "elsewhere", &["a"], &["T1"])];
    assert_eq!(
        plan_failures(&["T1"], &cohorts),
        [
            "Every cohort's repository_key must be the key of one of the run's repositories.",
            "Cohort ids must be unique idents, and each depends_on must name other cohorts without repeats or a cycle."
        ]
    );
    assert_eq!(
        plan_failures(&["T1"], &[]),
        ["The plan must name at least one cohort.", MISSING_TASK]
    );
}

#[test]
fn an_operator_cannot_accept_a_failed_plan_until_a_corrected_revision_passes() {
    let mut run = at_planning(&["T1", "T2"]);
    let unit = "run/planning";
    let good = cohort("a", "oakridge", &[], &["T1", "T2"]);
    run.write(
        unit,
        "planner",
        "plan",
        plan(&[cohort("a", "oakridge", &[], &["T1"])]),
    );

    let [awaiting] = run.last.reviews.as_slice() else {
        panic!(
            "the plan review stays open for feedback: {:?}",
            run.last.reviews
        )
    };
    let offered: Vec<&str> = awaiting
        .decisions
        .iter()
        .map(|decision| decision.decision.0.as_str())
        .collect();
    assert_eq!(offered, ["request_changes"]);

    let refusal = run.accept(unit, "plan_review", "plan").unwrap_err();
    assert!(
        matches!(&refusal, StepError::Rejected { reason, .. } if reason == REFUSED),
        "{refusal:?}"
    );
    assert_eq!(run.review_decisions(unit), 0);
    assert!(!run.is_done(unit));
    assert!(!run.has_unit("run/briefs/a"));

    run.request_changes(unit, "plan_review", "plan");
    assert!(!run.is_done(unit));
    run.write(unit, "planner", "plan", plan(std::slice::from_ref(&good)));
    assert!(run.validation_messages(unit, "plan").is_empty());
    run.accept(unit, "plan_review", "plan").unwrap();
    assert!(run.is_done(unit));
    assert!(run.has_unit("run/briefs/a"));
}

#[test]
fn the_earlier_failed_revision_stays_history_and_stays_unacceptable() {
    let mut run = at_planning(&["T1"]);
    let unit = "run/planning";
    run.write(
        unit,
        "planner",
        "plan",
        plan(&[cohort("a", "oakridge", &[], &["T9", "T1"])]),
    );
    let failed = run.latest_id(unit, "plan").unwrap();
    run.write(
        unit,
        "planner",
        "plan",
        plan(&[cohort("a", "oakridge", &[], &["T1"])]),
    );

    let stale = run.apply(
        Event::OperatorDecided {
            unit: UnitId::from(unit),
            review: SymbolKey::from("plan_review"),
            decision: SymbolKey::from("accept"),
            target: failed.clone(),
            payload: json!({}),
        },
        Writer::Engine,
    );
    assert!(
        matches!(stale, Err(StepError::Rejected { reason, .. }) if reason == "target is not latest revision")
    );
    assert!(run.state().decisions.iter().any(|decision| {
        matches!(decision, DecisionState::Validation { target, .. } if *target == failed)
    }));
    run.accept(unit, "plan_review", "plan").unwrap();
    assert!(run.is_done(unit));
}

#[test]
fn an_operator_edit_is_validated_and_refused_like_an_agent_revision() {
    let mut run = at_planning(&["T1"]);
    let unit = "run/planning";
    run.write(
        unit,
        "planner",
        "plan",
        plan(&[cohort("a", "oakridge", &[], &["T1"])]),
    );
    let predecessor = run.latest_id(unit, "plan");
    run.apply(
        Event::RevisionPublished {
            unit: UnitId::from(unit),
            artifact: SymbolKey::from("plan"),
            body: plan(&[cohort("a", "oakridge", &[], &["T2"])]),
            predecessor,
            subject: None,
            by: None,
        },
        Writer::Operator {
            subject: "steve".into(),
        },
    )
    .unwrap();
    assert_eq!(
        run.validation_messages(unit, "plan"),
        [UNKNOWN_TASK, MISSING_TASK]
    );
    assert!(run.accept(unit, "plan_review", "plan").is_err());
    assert!(!run.is_done(unit));
}

fn at_briefs(cohorts: &[Value], task_ids: &[&str]) -> Run {
    let mut run = at_planning(task_ids);
    run.accepted_plan(cohorts);
    run
}

/// The messages a brief with the given acceptance ids fails with, for a
/// cohort planned as T1, T2.
fn brief_failures(ids: &[&str]) -> Vec<String> {
    let planned = cohort("a", "oakridge", &[], &["T1", "T2"]);
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let mut brief = brief_of(&planned);
    brief["acceptance_criteria"] = json!(entries(ids));
    run.publish("run/briefs/a", "writer", "brief", brief, None);
    run.validation_messages("run/briefs/a", "brief")
}

#[test]
fn a_brief_with_its_cohort_ids_in_order_passes_with_rewritten_text() {
    let planned = cohort("a", "oakridge", &[], &["T1", "T2"]);
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let mut brief = brief_of(&planned);
    brief["acceptance_criteria"][0]["text"] =
        json!("Self-contained wording of the same obligation");
    run.publish("run/briefs/a", "writer", "brief", brief, None);
    assert!(run.validation_messages("run/briefs/a", "brief").is_empty());
}

#[test]
fn a_brief_missing_a_cohort_id_fails() {
    assert_eq!(brief_failures(&["T1"]), [BRIEF_IDS]);
}

#[test]
fn a_brief_adding_an_id_fails() {
    assert_eq!(brief_failures(&["T1", "T2", "T3"]), [BRIEF_IDS]);
}

#[test]
fn a_brief_replacing_an_id_fails() {
    assert_eq!(brief_failures(&["T1", "AC2"]), [BRIEF_IDS]);
}

#[test]
fn a_brief_reordering_its_ids_fails() {
    assert_eq!(brief_failures(&["T2", "T1"]), [BRIEF_IDS]);
}

#[test]
fn a_brief_keeps_its_cohort_metadata_checks() {
    let planned = cohort("a", "oakridge", &[], &["T1"]);
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1"]);
    let mut brief = brief_of(&planned);
    brief["cohort_id"] = json!("other");
    brief["repository_key"] = json!("elsewhere");
    brief["depends_on"] = json!(["z"]);
    run.publish("run/briefs/a", "writer", "brief", brief, None);
    assert_eq!(
        run.validation_messages("run/briefs/a", "brief"),
        [
            "The brief's cohort_id must be its plan cohort's id.",
            "The brief's repository_key must be its plan cohort's.",
            "The brief's depends_on must be its plan cohort's, in the same order."
        ]
    );
}

#[test]
fn an_operator_cannot_accept_a_failed_brief_or_release_its_builder_until_corrected() {
    let planned = cohort("a", "oakridge", &[], &["T1", "T2"]);
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let unit = "run/briefs/a";
    let mut reordered = brief_of(&planned);
    reordered["acceptance_criteria"] = json!(entries(&["T2", "T1"]));
    run.write(unit, "writer", "brief", reordered);

    let refusal = run.accept(unit, "brief_review", "brief").unwrap_err();
    assert!(
        matches!(&refusal, StepError::Rejected { reason, .. } if reason == REFUSED),
        "{refusal:?}"
    );
    assert_eq!(run.review_decisions(unit), 0);
    assert!(!run.is_done(unit));
    assert!(!run.has_unit("run/implementation/a"));

    run.request_changes(unit, "brief_review", "brief");
    run.write(unit, "writer", "brief", brief_of(&planned));
    run.accept(unit, "brief_review", "brief").unwrap();
    assert!(run.is_done(unit));
    assert!(run.state().attempts.iter().any(|attempt| {
        attempt.unit.0 == "run/implementation/a" && attempt.worker.0 == "builder"
    }));
}

/// Two repositories, with task T1 shared by two cohorts of `alpha`.
fn at_integration() -> Run {
    let repositories = ["alpha", "beta"];
    let task_ids = ["T1", "T2", "T3", "T4"];
    let cohorts = [
        cohort("a1", "alpha", &[], &["T1", "T2"]),
        cohort("a2", "alpha", &["a1"], &["T1", "T3"]),
        cohort("b1", "beta", &[], &["T4"]),
    ];
    let mut run = Run::launch(&repositories);
    run.prepare_and_analyze(&repositories, &task_ids);
    run.accepted_plan(&cohorts);
    for planned in &cohorts {
        run.accepted_brief(planned);
    }
    run.completed_cohort("a1", "alpha");
    run.completed_cohort("a2", "alpha");
    run.completed_cohort("b1", "beta");
    run
}

fn integrator_briefs(run: &Run, unit: &str) -> Value {
    let action = run.action(unit, "integrator");
    run.last
        .wanted
        .iter()
        .find(|wanted| wanted.action_id == action)
        .expect("integrator wanted")
        .resolved
        .inputs["briefs"]
        .clone()
}

fn cohort_ids(briefs: &Value) -> Vec<&str> {
    briefs
        .as_array()
        .unwrap()
        .iter()
        .map(|brief| brief["cohort_id"].as_str().unwrap())
        .collect()
}

#[test]
fn integration_receives_exactly_its_repositorys_briefs() {
    let run = at_integration();
    assert_eq!(
        cohort_ids(&integrator_briefs(&run, "run/integration/alpha")),
        ["a1", "a2"]
    );
    assert_eq!(
        cohort_ids(&integrator_briefs(&run, "run/integration/beta")),
        ["b1"]
    );
}

#[test]
fn a_shared_task_reaches_integration_with_every_cohorts_contribution() {
    let run = at_integration();
    let briefs = integrator_briefs(&run, "run/integration/alpha");
    let entries: Vec<(&str, &str)> = briefs
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|brief| {
            let cohort = brief["cohort_id"].as_str().unwrap();
            brief["acceptance_criteria"]
                .as_array()
                .unwrap()
                .iter()
                .map(move |entry| (entry["id"].as_str().unwrap(), cohort))
        })
        .collect();
    assert_eq!(
        entries,
        [("T1", "a1"), ("T2", "a1"), ("T1", "a2"), ("T3", "a2")]
    );
}

#[test]
fn integration_findings_link_tasks_many_to_many_without_a_build_subject() {
    let mut run = at_integration();
    let unit = "run/integration/alpha";
    let head = "integration-sha";
    let findings = json!([
        {"task_ids": ["T1"], "description": "First half", "status": "met",
         "evidence": [{"kind": "file", "ref": "src/a.rs:1-9"}]},
        {"task_ids": ["T1"], "description": "Second half", "status": "partial",
         "evidence": [{"kind": "test", "ref": "suite::case"}]},
        {"task_ids": ["T2", "T3"], "description": "Shared", "status": "not_met",
         "evidence": [{"kind": "output", "ref": "cargo test", "detail": "1 failed"}]},
        {"task_ids": [], "description": "Unlinked note", "evidence": []}
    ]);
    run.publish(
        unit,
        "integrator",
        "assessment",
        assessment(head, findings.clone()),
        None,
    );
    run.write(unit, "integrator", "pr", pr("alpha", "integration"));

    let revision = latest(
        run.state(),
        &UnitId::from(unit),
        &SymbolKey::from("assessment"),
    )
    .unwrap();
    assert_eq!(
        (
            revision.subject.as_ref(),
            &revision.body["head_sha"],
            &revision.body["findings"]
        ),
        (None, &json!(head), &findings)
    );
    assert!(run.validation_messages(unit, "assessment").is_empty());
}

#[test]
fn the_integration_review_and_revise_read_the_same_briefs() {
    let mut run = at_integration();
    let unit = "run/integration/alpha";
    run.publish(
        unit,
        "integrator",
        "assessment",
        assessment("sha", json!([])),
        None,
    );
    run.write(unit, "integrator", "pr", pr("alpha", "integration"));

    let review = run
        .last
        .reviews
        .iter()
        .find(|review| review.unit.0 == unit && review.review.0 == "integration_review")
        .expect("integration review awaits");
    assert_eq!(cohort_ids(&review.inputs["briefs"]), ["a1", "a2"]);

    run.request_changes(unit, "integration_review", "pr");
    assert_eq!(cohort_ids(&integrator_briefs(&run, unit)), ["a1", "a2"]);
}

#[test]
fn finding_links_are_a_required_list_of_ids() {
    let mut run = at_integration();
    let unit = "run/integration/alpha";
    let action = run.action(unit, "integrator");
    for findings in [
        json!([{"evidence": []}]),
        json!([{"task_ids": "T1", "evidence": []}]),
    ] {
        let refusal = run.apply(
            Event::RevisionPublished {
                unit: UnitId::from(unit),
                artifact: SymbolKey::from("assessment"),
                body: assessment("sha", findings),
                predecessor: None,
                subject: None,
                by: Some(action.clone()),
            },
            Writer::Engine,
        );
        assert!(
            matches!(refusal, Err(StepError::Rejected { reason, .. }) if reason == "artifact body fails schema")
        );
    }
}

fn declared_fields(schema: &str) -> Vec<String> {
    let bundle: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/development.json")).unwrap();
    let mut fields: Vec<String> = bundle["schemas"][schema]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    fields.sort();
    fields
}

#[test]
fn acceptance_entries_declare_exactly_id_text_and_decision_ids() {
    assert_eq!(
        declared_fields("task_acceptance"),
        ["decision_ids", "id", "text"]
    );
}

#[test]
fn assessment_findings_declare_task_links_and_no_criterion_fields() {
    assert_eq!(
        declared_fields("assessment_finding"),
        ["description", "evidence", "status", "task_ids"]
    );
}

#[test]
fn an_acceptance_entry_without_its_decision_links_fails_schema() {
    let mut run = at_planning(&["T1"]);
    let mut partial = cohort("a", "oakridge", &[], &["T1"]);
    partial["acceptance_criteria"] = json!([{"id": "T1", "text": "Deliver T1"}]);
    let refusal = run.apply(
        Event::RevisionPublished {
            unit: UnitId::from("run/planning"),
            artifact: SymbolKey::from("plan"),
            body: plan(&[partial]),
            predecessor: None,
            subject: None,
            by: Some(run.action("run/planning", "planner")),
        },
        Writer::Engine,
    );
    assert!(
        matches!(refusal, Err(StepError::Rejected { reason, .. }) if reason == "artifact body fails schema")
    );
}
