//! Replay the launchable study workflow through its public event interface.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_compiler::{compile_workflow, decode_workflow};
use workflow_evaluator::*;
use workflow_model::*;

fn study_definition() -> (Value, CheckedWorkflow) {
    let config = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../workflow-config");
    let read = |path: std::path::PathBuf| std::fs::read_to_string(path).expect("readable");
    let store = config.join("definitions");
    let launchable: Value = serde_json::from_str(&read(store.join("launchable.json"))).unwrap();
    let id = launchable["study"]["definition_id"].as_str().unwrap();
    let definition: Value =
        serde_json::from_str(&read(store.join(format!("workflows/{id}.json")))).unwrap();
    let registry = definition["operation_registry_id"].as_str().unwrap();
    let operations: Vec<CodeOperation> =
        serde_json::from_str(&read(store.join(format!("operations/{registry}.json")))).unwrap();
    let prompts: BTreeMap<String, String> = definition["prompts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, digest)| {
            let digest = digest.as_str().unwrap();
            (
                name.clone(),
                read(store.join(format!("prompts/{digest}.md"))),
            )
        })
        .collect();
    let source = decode_workflow(&serde_json::to_vec(&definition["source"]).unwrap()).unwrap();
    let checked = compile_workflow(&source, &operations, &prompts).expect("study compiles");
    (definition, checked)
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

/// An artifact one worker of a unit produces.
#[derive(Clone, Copy)]
struct WorkerOutput<'a> {
    unit: &'a str,
    worker: &'a str,
    artifact: &'a str,
}

/// A worker's revision of its artifact, reviewing `subject` when it has one.
struct Publication<'a> {
    output: WorkerOutput<'a>,
    body: Value,
    subject: Option<RevisionId>,
}

/// A review of the latest revision of a unit's artifact.
#[derive(Clone, Copy)]
struct ReviewOf<'a> {
    unit: &'a str,
    review: &'a str,
    artifact: &'a str,
}

/// An operator's decision on a review.
struct Decision<'a> {
    review: ReviewOf<'a>,
    decision: &'a str,
    payload: Value,
}

/// A run driven one event at a time, with the last step's result kept for its
/// wanted workers and awaiting reviews.
struct Run {
    program: CheckedWorkflow,
    last: StepResult,
    count: usize,
}

impl Run {
    fn launch() -> Self {
        let (_, program) = study_definition();
        let input = json!({
            "title": "t", "spec": "s",
            "repositories": [repository("oakridge")],
            "primary_repository_key": "oakridge",
            "final_merge_policy": "require_merge",
            "slice_case_limit": 6,
            "slice_cap_cents": 1000,
            "approved_plan": null
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

    fn publish(&mut self, publication: Publication<'_>) {
        let Publication {
            output,
            body,
            subject,
        } = publication;
        let event = Event::RevisionPublished {
            unit: UnitId::from(output.unit),
            artifact: SymbolKey::from(output.artifact),
            body,
            predecessor: self.latest_id(output.unit, output.artifact),
            subject,
            by: Some(self.action(output.unit, output.worker)),
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

    fn write(&mut self, output: WorkerOutput<'_>, body: Value) {
        self.publish(Publication {
            output,
            body,
            subject: None,
        });
        self.end(output.unit, output.worker);
    }

    fn decide(&mut self, decision: Decision<'_>) -> Result<(), StepError> {
        let Decision {
            review,
            decision,
            payload,
        } = decision;
        let event = Event::OperatorDecided {
            unit: UnitId::from(review.unit),
            review: SymbolKey::from(review.review),
            decision: SymbolKey::from(decision),
            target: self
                .latest_id(review.unit, review.artifact)
                .expect("published"),
            payload,
        };
        self.apply(event, Writer::Engine)
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

    fn wants(&self, unit: &str, worker: &str) -> bool {
        self.last
            .wanted
            .iter()
            .any(|wanted| wanted.unit.0 == unit && wanted.worker.0 == worker)
    }
}

const DESIGN: &str = "run/design";
const FREEZE: &str = "run/freeze";
const SLICE_CASES: &[&str] = &["g1_a", "g1_b"];
const G2_CASES: &[&str] = &["g2_a", "g2_b"];
const G3_CASES: &[&str] = &["g3_a"];
const MODEL: &str = "model_a";

const PLACEHOLDER: &str =
    "No paid results yet: this offline report waits for the spend request's approval.";
const UNAPPROVED_SPEND: &str = "Paid results need an approved spend request.";
const MISSING_CRITERION: &str = "Every plan slice criterion must be marked.";
const MISSING_TRIGGER: &str = "Every plan iteration trigger must be marked.";
const REPORT_CASES: &str = "The report's case ids must equal the plan's slice ids.";
const SPEND_DIGEST: &str =
    "The spend request's generator digest must equal the latest slice build's.";
const SPEND_CASES: &str = "The spend request's case ids must equal the latest slice build's.";
const EXPANSION_DIGEST: &str = "The expansion's generator digest must equal the approved slice's.";
const EXPANSION_CASES: &str = "The expansion's case ids must be exactly its allocated cases.";

const PLAN: WorkerOutput<'static> = WorkerOutput {
    unit: DESIGN,
    worker: "designer",
    artifact: "plan",
};
const PLAN_REVIEW: ReviewOf<'static> = ReviewOf {
    unit: DESIGN,
    review: "plan_review",
    artifact: "plan",
};

fn plan() -> Value {
    json!({
        "question": "Do the omissions affect the outcome?",
        "hypotheses": [{"id": "h1", "statement": "Isolated omissions reduce scores."}],
        "cases": [
            {"id": "g1_a", "group": "g1", "is_control": true},
            {"id": "g1_b", "group": "g1", "is_control": false},
            {"id": "g2_a", "group": "g2", "is_control": false},
            {"id": "g2_b", "group": "g2", "is_control": false},
            {"id": "g3_a", "group": "g3", "is_control": false}
        ],
        "groups": [
            {"id": "g1", "case_ids": SLICE_CASES},
            {"id": "g2", "case_ids": G2_CASES},
            {"id": "g3", "case_ids": G3_CASES}
        ],
        "outcomes": [{"id": "o1", "rule": "Compare scores with the control."}],
        "decision_rule": [{"condition": "Slice criteria met", "next_step": "Expand"}],
        "models": [{
            "id": MODEL, "route": "test/model", "per_attempt_cap_cents": 100,
            "expected_cost_per_attempt": {"cents": 50, "basis": "assumption"}
        }],
        "slice": {
            "case_ids": SLICE_CASES, "risk_reason": "Qualify the control and one omission.",
            "criteria": [{"id": "sc1", "text": "Both slice cases produce scores."}]
        },
        "slice_paid": {"models": [MODEL], "repeats": 1, "cap_cents": 200},
        "iteration_triggers": [{"id": "it1", "text": "Check that controls replay."}]
    })
}

fn qualifications(case_ids: &[&str]) -> Vec<Value> {
    case_ids
        .iter()
        .map(|id| {
            json!({
                "case_id": id, "reference_passes": true, "omissions_isolated": true,
                "controls_replayed": true, "detail": "Qualified offline"
            })
        })
        .collect()
}

fn slice_build(digest: &str) -> Value {
    expansion("slice", digest, SLICE_CASES)
}

fn spend_request(digest: &str, case_ids: &[&str]) -> Value {
    json!({
        "cohort_file": "slice.json", "attempt_count": case_ids.len(), "cap_cents": 200,
        "generator_digest": digest, "case_ids": case_ids
    })
}

fn placeholder_report(digest: &str) -> Value {
    json!({
        "run_key": "", "generator_digest": digest, "qualifications": qualifications(SLICE_CASES),
        "paid_results": [],
        "criteria_marks": [{"id": "sc1", "status": "not_met", "evidence": "awaiting the paid run"}],
        "trigger_marks": [{"id": "it1", "status": "not_met", "evidence": "awaiting the paid run"}],
        "proposed_changes": []
    })
}

fn paid_report(digest: &str, run_key: &str) -> Value {
    let results: Vec<_> = SLICE_CASES
        .iter()
        .map(|id| {
            json!({
                "case_id": id, "model_id": MODEL, "outcome": "scored",
                "detail": "Score recorded", "spend_cents": 50,
                "launch_command": "run-cohort slice.json", "store_path": format!("{run_key}/{id}")
            })
        })
        .collect();
    json!({
        "run_key": run_key, "generator_digest": digest,
        "qualifications": qualifications(SLICE_CASES), "paid_results": results,
        "criteria_marks": [{"id": "sc1", "status": "met", "evidence": "Both cases scored"}],
        "trigger_marks": [{"id": "it1", "status": "met", "evidence": "Control replayed"}],
        "proposed_changes": []
    })
}

fn met_item(kind: &str, id: &str) -> Value {
    json!({
        "subject": {"kind": kind, "id": id}, "status": "met",
        "observation": "Evidence verified", "evidence": [{"kind": "test", "ref": id}]
    })
}

fn assessment(head_sha: &str, items: Vec<Value>) -> Value {
    json!({
        "head_sha": head_sha, "item_assessments": items, "additional_findings": [],
        "next_actions": [], "test_evidence": {"passed": 1, "failed": 0}, "verdict": "pass"
    })
}

fn slice_assessment(run_key: &str) -> Value {
    let mut body = assessment(
        "slice_head",
        vec![met_item("criterion", "sc1"), met_item("trigger", "it1")],
    );
    body["run_key"] = json!(run_key);
    body
}

fn expansion(group: &str, digest: &str, case_ids: &[&str]) -> Value {
    json!({
        "build": {
            "cohort_id": group, "title": group, "head_sha": format!("{group}_head"),
            "summary": "Fixtures and qualifications", "changed_files": []
        },
        "generator_digest": digest, "case_ids": case_ids,
        "qualifications": qualifications(case_ids)
    })
}

fn expansion_assessment(head_sha: &str, case_ids: &[&str]) -> Value {
    assessment(
        head_sha,
        case_ids.iter().map(|id| met_item("case", id)).collect(),
    )
}

fn pr(branch: &str) -> Value {
    json!({"pr_url": format!("https://forge/oakridge/{branch}"), "branch": branch, "summary": "Study fixtures"})
}

fn adjudication() -> Value {
    json!({"entries": [], "added_actions": [], "rework_feedback": ""})
}

fn slice_output(artifact: &str) -> WorkerOutput<'_> {
    WorkerOutput {
        unit: DESIGN,
        worker: "slice_builder",
        artifact,
    }
}

impl Run {
    fn prepared() -> Self {
        let mut run = Self::launch();
        run.write(
            WorkerOutput {
                unit: "run/prepare/oakridge",
                worker: "git",
                artifact: "workspace",
            },
            workspace("oakridge"),
        );
        run
    }

    fn approved_plan(&mut self, body: Value) {
        self.write(PLAN, body);
        self.accept_plan();
    }

    fn accept_plan(&mut self) {
        self.decide(Decision {
            review: PLAN_REVIEW,
            decision: "accept",
            payload: json!({}),
        })
        .unwrap();
    }

    fn slice_publish(&mut self, artifact: &str, body: Value) {
        self.publish(Publication {
            output: slice_output(artifact),
            body,
            subject: None,
        });
    }

    fn request_spend(&mut self, digest: &str) {
        self.slice_publish("slice_build", slice_build(digest));
        self.slice_publish("spend_request", spend_request(digest, SLICE_CASES));
    }

    fn finish_slice_attempt(&mut self) {
        self.slice_publish("pr", pr("slice"));
        self.end(DESIGN, "slice_builder");
    }

    fn offline_cycle(&mut self, digest: &str) {
        self.request_spend(digest);
        self.slice_publish("slice_report", placeholder_report(digest));
        self.finish_slice_attempt();
    }

    fn paid_cycle(&mut self, digest: &str, run_key: &str) {
        // The approved spend request must still be latest when validation runs.
        self.slice_publish("slice_report", paid_report(digest, run_key));
        self.request_spend(digest);
        self.finish_slice_attempt();
    }

    fn assessed(&mut self, run_key: &str) {
        self.publish(Publication {
            output: WorkerOutput {
                unit: DESIGN,
                worker: "slice_assessor",
                artifact: "slice_assessment",
            },
            body: slice_assessment(run_key),
            subject: Some(self.latest_id(DESIGN, "slice_report").unwrap()),
        });
        self.end(DESIGN, "slice_assessor");
    }

    fn approve_spend(&mut self) {
        self.decide(Decision {
            review: ReviewOf {
                unit: DESIGN,
                review: "spend_request_review",
                artifact: "spend_request",
            },
            decision: "approve",
            payload: json!({}),
        })
        .unwrap();
    }

    fn confirm_merged(&mut self, unit: &str) {
        self.decide(Decision {
            review: ReviewOf {
                unit,
                review: "merge_confirmation",
                artifact: "pr",
            },
            decision: "confirm_merged",
            payload: json!({}),
        })
        .unwrap();
    }

    fn offers(&self, unit: &str, review: &str) -> bool {
        self.last
            .reviews
            .iter()
            .any(|candidate| candidate.unit.0 == unit && candidate.review.0 == review)
    }

    fn assert_validation(&self, unit: &str, artifact: &str, expected: &str) {
        let messages = self.validation_messages(unit, artifact);
        assert!(
            messages.iter().any(|message| message == expected),
            "{artifact} expected {expected:?}, got {messages:?}"
        );
    }
}

fn at_slice_builder() -> Run {
    let mut run = Run::prepared();
    run.approved_plan(plan());
    run
}

#[test]
fn slice_builder_waits_for_spend_approval_then_runs_paid() {
    let mut run = at_slice_builder();
    let wanted_after_plan_approval = run.wants(DESIGN, "slice_builder");

    run.offline_cycle("d1");
    run.assert_validation(DESIGN, "slice_report", PLACEHOLDER);
    assert!(
        !run.wants(DESIGN, "slice_builder"),
        "offline revision must wait for spend approval"
    );
    // Removing the guard also changes when the first attempt is dispatched.
    // Check the spend hold first so that regression points to the missing hold.
    assert!(wanted_after_plan_approval);
    assert!(run.offers(DESIGN, "spend_request_review"));

    run.approve_spend();
    assert!(run.wants(DESIGN, "slice_builder"));
    assert!(run.last.wanted.iter().any(|wanted| matches!(&wanted.action,
        Action::RunWorker { unit, worker, mode: Mode::Revise, .. }
        if unit.0 == DESIGN && worker.0 == "slice_builder"
    )));

    run.paid_cycle("d1", "r1");
    assert!(run.validation_messages(DESIGN, "slice_report").is_empty());
    assert!(!run.wants(DESIGN, "slice_builder"));
    assert!(!run.offers(DESIGN, "spend_request_review"));
    assert!(run.wants(DESIGN, "slice_assessor"));
}

#[test]
fn paid_results_are_refused_without_an_approved_spend_request() {
    let mut run = at_slice_builder();
    run.request_spend("d1");
    run.slice_publish("slice_report", paid_report("d1", "r1"));
    run.assert_validation(DESIGN, "slice_report", UNAPPROVED_SPEND);
    assert!(!run
        .validation_messages(DESIGN, "slice_report")
        .iter()
        .any(|message| message == PLACEHOLDER));
}

fn assert_slice_report_refusal(report: Value, message: &str) {
    let mut run = at_slice_builder();
    run.request_spend("d1");
    run.slice_publish("slice_report", report);
    run.assert_validation(DESIGN, "slice_report", message);
}

#[test]
fn slice_report_refuses_a_missing_criterion_mark() {
    let mut report = placeholder_report("d1");
    report["criteria_marks"] = json!([]);
    assert_slice_report_refusal(report, MISSING_CRITERION);
}

#[test]
fn slice_report_refuses_a_missing_trigger_mark() {
    let mut report = placeholder_report("d1");
    report["trigger_marks"] = json!([]);
    assert_slice_report_refusal(report, MISSING_TRIGGER);
}

#[test]
fn slice_report_refuses_incomplete_case_qualifications() {
    let mut report = placeholder_report("d1");
    report["qualifications"] = json!(qualifications(&["g1_a"]));
    assert_slice_report_refusal(report, REPORT_CASES);
}

fn assessed_slice() -> Run {
    let mut run = at_slice_builder();
    run.offline_cycle("d1");
    run.approve_spend();
    run.paid_cycle("d1", "r1");
    run.assessed("r1");
    run
}

#[test]
fn send_to_builder_rebuilds_and_needs_a_fresh_spend_approval() {
    let mut run = assessed_slice();
    let first_paid_report = run.latest_id(DESIGN, "slice_report").unwrap();
    let feedback = "Fix the omission patch for g1_b";
    run.decide(Decision {
        review: ReviewOf {
            unit: DESIGN,
            review: "slice_report_review",
            artifact: "slice_build",
        },
        decision: "send_to_builder",
        payload: json!({"feedback": feedback}),
    })
    .unwrap();
    assert!(run.wants(DESIGN, "slice_builder"));

    run.slice_publish("slice_build", slice_build("d2"));
    run.slice_publish("spend_request", spend_request("d1", SLICE_CASES));
    run.assert_validation(DESIGN, "spend_request", SPEND_DIGEST);
    run.slice_publish("spend_request", spend_request("d2", &["g1_a"]));
    run.assert_validation(DESIGN, "spend_request", SPEND_CASES);
    run.slice_publish("spend_request", spend_request("d2", SLICE_CASES));
    assert!(run.validation_messages(DESIGN, "spend_request").is_empty());
    run.slice_publish("slice_report", placeholder_report("d2"));
    run.finish_slice_attempt();

    assert!(!run.wants(DESIGN, "slice_builder"));
    assert!(run.offers(DESIGN, "spend_request_review"));
    assert!(!run.offers(DESIGN, "slice_report_review"));

    run.approve_spend();
    run.paid_cycle("d2", "r2");
    assert!(run.validation_messages(DESIGN, "slice_report").is_empty());

    let mut reports: Vec<_> = run
        .state()
        .revisions
        .iter()
        .filter(|revision| revision.unit.0 == DESIGN && revision.artifact.0 == "slice_report")
        .collect();
    reports.sort_by_key(|revision| revision.seq);
    let rounds: Vec<_> = reports
        .iter()
        .map(|revision| {
            (
                revision.body["generator_digest"].as_str().unwrap(),
                revision.body["run_key"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(rounds, [("d1", ""), ("d1", "r1"), ("d2", ""), ("d2", "r2")]);
    let retained = run
        .state()
        .revisions
        .iter()
        .find(|revision| revision.id == first_paid_report)
        .expect("first paid report is still readable by id");
    assert_eq!(retained.body, paid_report("d1", "r1"));
    assert!(run.state().decisions.iter().any(|entry| matches!(entry,
        DecisionState::Review { unit, review, decision, payload, .. }
        if unit.0 == DESIGN && review.0 == "slice_report_review"
            && decision.0 == "send_to_builder" && payload["feedback"] == feedback
    )));
}

#[test]
fn slice_adjudication_sends_only_rework_feedback_to_the_builder() {
    let mut run = assessed_slice();
    let mut payload = adjudication();
    payload["rework_feedback"] = json!("Fix X");
    run.decide(Decision {
        review: ReviewOf {
            unit: DESIGN,
            review: "slice_report_review",
            artifact: "slice_build",
        },
        decision: "send_feedback_to_builder",
        payload,
    })
    .unwrap();
    let wanted = run
        .last
        .wanted
        .iter()
        .find(|wanted| {
            matches!(&wanted.action,
                Action::RunWorker { unit, worker, mode: Mode::Revise, .. }
                if unit.0 == DESIGN && worker.0 == "slice_builder"
            )
        })
        .expect("slice builder revises");
    let feedback: Vec<_> = wanted
        .resolved
        .feedback
        .iter()
        .map(|entry| &entry.payload)
        .collect();
    assert_eq!(feedback, vec![&json!({"feedback": "Fix X"})]);
}

#[test]
fn change_design_reruns_the_slice_after_the_plan_is_reapproved() {
    let mut run = assessed_slice();
    run.decide(Decision {
        review: ReviewOf {
            unit: DESIGN,
            review: "slice_report_review",
            artifact: "plan",
        },
        decision: "change_design",
        payload: json!({"feedback": "Clarify the slice scoring criterion."}),
    })
    .unwrap();
    assert!(run.wants(DESIGN, "designer"));
    assert!(!run.wants(DESIGN, "slice_builder"));
    assert!(!run.offers(DESIGN, "slice_report_review"));

    let mut revised = plan();
    revised["slice"]["criteria"][0]["text"] = json!("Both slice cases produce numeric scores.");
    run.write(PLAN, revised);
    assert!(!run.wants(DESIGN, "slice_builder"));

    run.accept_plan();
    assert!(run.wants(DESIGN, "slice_builder"));
    run.offline_cycle("d2");
    assert!(!run.wants(DESIGN, "slice_builder"));
    assert!(run.offers(DESIGN, "spend_request_review"));

    run.approve_spend();
    assert!(run.wants(DESIGN, "slice_builder"));
    run.paid_cycle("d2", "r2");
    assert!(run.validation_messages(DESIGN, "slice_report").is_empty());
    let report = latest(
        run.state(),
        &UnitId::from(DESIGN),
        &SymbolKey::from("slice_report"),
    )
    .unwrap();
    assert_eq!(report.body["run_key"], "r2");
}

fn slice_approved() -> Run {
    let mut run = assessed_slice();
    run.decide(Decision {
        review: ReviewOf {
            unit: DESIGN,
            review: "slice_report_review",
            artifact: "slice_report",
        },
        decision: "expand",
        payload: adjudication(),
    })
    .unwrap();
    run.confirm_merged(DESIGN);
    assert!(run.is_done(DESIGN));
    run
}

impl Run {
    fn complete_expansion(&mut self, group: &str) {
        let unit = format!("run/expansion/{group}");
        let input = self
            .state()
            .units
            .iter()
            .find(|candidate| candidate.id.0 == unit)
            .and_then(|candidate| candidate.input.as_ref())
            .expect("allocated expansion input");
        let case_ids: Vec<_> = input["case_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        let body = expansion(
            group,
            input["generator_digest"].as_str().unwrap(),
            &case_ids,
        );
        let assessed_body =
            expansion_assessment(body["build"]["head_sha"].as_str().unwrap(), &case_ids);

        self.publish(Publication {
            output: WorkerOutput {
                unit: &unit,
                worker: "expander",
                artifact: "expansion",
            },
            body,
            subject: None,
        });
        self.write(
            WorkerOutput {
                unit: &unit,
                worker: "expander",
                artifact: "pr",
            },
            pr(group),
        );
        self.publish(Publication {
            output: WorkerOutput {
                unit: &unit,
                worker: "assessor",
                artifact: "assessment",
            },
            body: assessed_body,
            subject: Some(self.latest_id(&unit, "expansion").unwrap()),
        });
        self.end(&unit, "assessor");
        self.decide(Decision {
            review: ReviewOf {
                unit: &unit,
                review: "expansion_review",
                artifact: "assessment",
            },
            decision: "accept",
            payload: adjudication(),
        })
        .unwrap();
        self.confirm_merged(&unit);
    }
}

#[test]
fn expansion_units_cover_groups_with_non_slice_cases() {
    let run = slice_approved();
    assert!(!run.has_unit("run/expansion/g1"));
    for (unit, case_ids) in [
        ("run/expansion/g2", G2_CASES),
        ("run/expansion/g3", G3_CASES),
    ] {
        assert!(run.has_unit(unit));
        let input = run
            .state()
            .units
            .iter()
            .find(|candidate| candidate.id.0 == unit)
            .unwrap()
            .input
            .as_ref()
            .unwrap();
        assert_eq!(input["generator_digest"], "d1");
        assert_eq!(input["case_ids"], json!(case_ids));
    }
}

#[test]
fn expansion_digest_mismatch_is_refused_then_the_unit_blocks() {
    let mut run = slice_approved();
    let unit = "run/expansion/g2";
    let output = WorkerOutput {
        unit,
        worker: "expander",
        artifact: "expansion",
    };
    run.publish(Publication {
        output,
        body: expansion("g2", "d9", G2_CASES),
        subject: None,
    });
    run.assert_validation(unit, "expansion", EXPANSION_DIGEST);
    run.publish(Publication {
        output,
        body: expansion("g2", "d1", &["g2_a"]),
        subject: None,
    });
    run.assert_validation(unit, "expansion", EXPANSION_CASES);
    run.write(
        WorkerOutput {
            artifact: "blocker",
            ..output
        },
        json!({"text": "The generator must change: g2 requires an additional control."}),
    );
    assert!(run.latest_id(unit, "blocker").is_some());
    assert!(run.offers(unit, "blocker_review"));
}

#[test]
fn freeze_starts_only_after_every_expansion_unit_is_done() {
    let mut run = slice_approved();
    run.complete_expansion("g2");
    assert!(run.is_done("run/expansion/g2"));
    assert!(!run.wants(FREEZE, "freezer"));
    assert!(!run
        .state()
        .attempts
        .iter()
        .any(|attempt| attempt.unit.0 == FREEZE && attempt.worker.0 == "freezer"));

    run.complete_expansion("g3");
    assert!(run.is_done("run/expansion/g3"));
    assert!(run.wants(FREEZE, "freezer"));
}
