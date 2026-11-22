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
    fn launch(approved_plan: Value) -> Self {
        let (_, program) = study_definition();
        let input = json!({
            "title": "t", "spec": "s",
            "repositories": [repository("oakridge")],
            "primary_repository_key": "oakridge",
            "final_merge_policy": "require_merge",
            "slice_case_limit": 6,
            "slice_cap_cents": 1000,
            "approved_plan": approved_plan
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
            by: Some(PublishingAttempt {
                action: self.action(output.unit, output.worker),
                seq: 1,
            }),
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
        "pilot_selection": {
            "case_ids": SLICE_CASES, "risk_reason": "Qualify the control and one omission.",
            "criteria": [{"id": "sc1", "text": "Both slice cases produce scores."}]
        },
        "slice_paid": {"models": [MODEL], "repeats": 1, "cap_cents": 200},
        "iteration_triggers": [{"id": "it1", "text": "Check that controls replay."}],
        "full_study_repeats": 2
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
    let mut build = expansion("slice", digest, SLICE_CASES);
    build["digest_recipe"] = digest_recipe();
    build
}

fn spend_request(digest: &str, case_ids: &[&str]) -> Value {
    json!({
        "cohort_file": "slice.json", "attempt_count": case_ids.len(), "cap_cents": 200,
        "generator_digest": digest, "case_ids": case_ids
    })
}

fn digest_recipe() -> Value {
    json!({"files": ["generator.py"], "command": "sha256sum generator.py"})
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
        "trigger_marks": [{"id": "it1", "status": "not_fired", "evidence": "Control replayed"}],
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
        "proposals": [], "verifications": [], "test_evidence": {"passed": 1, "failed": 0}, "verdict": "pass"
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
    json!({"change_request_link": format!("https://forge/oakridge/{branch}"), "branch": branch, "summary": "Study fixtures"})
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
        let mut run = Self::launch(Value::Null);
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

    fn build(&mut self, digest: &str, branch: &str) {
        self.slice_publish("slice_build", slice_build(digest));
        self.slice_publish("pr", pr(branch));
        self.end(DESIGN, "slice_builder");
    }

    fn request_spend(&mut self, digest: &str) {
        self.reviewed(
            "spend_requester",
            "spend_request",
            "slice_build",
            spend_request(digest, SLICE_CASES),
        );
    }

    fn reviewed(&mut self, worker: &str, artifact: &str, subject: &str, body: Value) {
        self.publish(Publication {
            output: WorkerOutput {
                unit: DESIGN,
                worker,
                artifact,
            },
            body,
            subject: self.latest_id(DESIGN, subject),
        });
        self.end(DESIGN, worker);
    }

    fn decided(&mut self, review: &str, artifact: &str, decision: &str, payload: Value) {
        self.decide(Decision {
            review: ReviewOf {
                unit: DESIGN,
                review,
                artifact,
            },
            decision,
            payload,
        })
        .unwrap();
    }

    fn observe_pr(&mut self, branch: &str, state: &str) {
        let body = json!({"state":state,"number":1,"url":pr(branch)["change_request_link"]});
        self.write(
            WorkerOutput {
                unit: DESIGN,
                worker: "pr_watch",
                artifact: "pr_state",
            },
            body.clone(),
        );
        if state == "merged" {
            self.write(
                WorkerOutput {
                    unit: DESIGN,
                    worker: "prepare_observed_state",
                    artifact: "observed_state",
                },
                body,
            );
        }
    }

    fn expand_offered(&self) -> bool {
        self.last.reviews.iter().any(|review| {
            review.review.0 == "slice_report_review"
                && review
                    .decisions
                    .iter()
                    .any(|decision| decision.decision.0 == "expand" && decision.is_available)
        })
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

fn at_slice_builder(plan: Value) -> Run {
    let mut run = Run::prepared();
    run.approved_plan(plan);
    run
}

fn at_spend_review() -> Run {
    let mut run = at_slice_builder(plan());
    run.build("d1", "slice");
    run.request_spend("d1");
    run
}

fn assessed_slice(plan: Value, fired: bool) -> Run {
    let mut run = at_slice_builder(plan);
    run.build("d1", "slice");
    run.request_spend("d1");
    run.approve_spend();
    let mut report = paid_report("d1", "r1");
    if fired {
        report["trigger_marks"][0]["status"] = json!("fired");
    }
    run.reviewed("slice_runner", "slice_report", "spend_request", report);
    run.assessed("r1");
    assert!(run
        .validation_messages(DESIGN, "slice_assessment")
        .is_empty());
    run
}

#[test]
fn paid_runner_is_never_wanted_while_spend_is_unapproved() {
    let mut run = at_slice_builder(plan());
    assert!(!run.wants(DESIGN, "slice_runner"));
    run.build("d1", "slice");
    run.request_spend("d1");
    assert!(!run.wants(DESIGN, "slice_runner"));
    run.decided(
        "spend_request_review",
        "spend_request",
        "request_changes",
        json!({"feedback":"Document the cap."}),
    );
    assert!(run.wants(DESIGN, "spend_requester"));
    assert!(!run.wants(DESIGN, "slice_runner"));
    run.request_spend("d1");
    run.approve_spend();
    assert!(run.wants(DESIGN, "slice_runner"));
    run.reviewed(
        "slice_runner",
        "slice_report",
        "spend_request",
        paid_report("d1", "r1"),
    );
    run.assessed("r1");
    run.observe_pr("slice", "closed_unmerged");
    run.decided(
        "pr_closed",
        "pr",
        "replace_pr",
        json!({"feedback":"Replace the closed branch."}),
    );
    run.build("d2", "replacement");
    assert!(run.wants(DESIGN, "spend_requester"));
    assert!(!run.wants(DESIGN, "slice_runner"));
    run.request_spend("d2");
    assert!(!run.wants(DESIGN, "slice_runner"));
}

#[test]
fn refused_paid_report_is_corrected_without_new_spend() {
    let mut run = at_spend_review();
    run.approve_spend();
    let mut report = paid_report("d1", "r1");
    report["paid_results"] = json!([]);
    let spend = run.latest_id(DESIGN, "spend_request").unwrap();
    run.reviewed("slice_runner", "slice_report", "spend_request", report);
    run.assert_validation(DESIGN, "slice_report", "The paid run produced no results. Revise the report from the same execution; do not request new spend.");
    assert!(!run.wants(DESIGN, "spend_requester"));
    assert!(!run.offers(DESIGN, "spend_request_review"));
    let worker = run
        .last
        .wanted
        .iter()
        .find(|worker| worker.worker.0 == "slice_runner")
        .unwrap();
    assert!(matches!(
        worker.action,
        Action::RunWorker {
            mode: Mode::Revise,
            ..
        }
    ));
    assert_eq!(
        worker
            .resolved
            .keyed_execution
            .as_ref()
            .unwrap()
            .authorizing_revision,
        spend
    );
}

#[test]
fn send_back_to_builder_withholds_expand_and_design() {
    let mut run = assessed_slice(plan(), false);
    run.observe_pr("slice", "merged");
    run.decided(
        "slice_assessment_review",
        "slice_build",
        "send_feedback_to_builder",
        json!({"rounds":[{"round":"round-1","assignment":"item-1","worker":"slice_builder"}]}),
    );
    assert!(run
        .last
        .wanted
        .iter()
        .any(|worker| worker.worker.0 == "slice_builder"
            && matches!(
                worker.action,
                Action::RunWorker {
                    cause: Cause::AssignmentRound { .. },
                    ..
                }
            )));
    assert!(!run.offers(DESIGN, "slice_report_review"));
    assert!(!run.is_done(DESIGN));
    assert!(!run.has_unit("run/expansion/g2"));
    run.build("d1", "slice");
    assert!(run
        .last
        .wanted
        .iter()
        .any(|worker| worker.worker.0 == "slice_assessor"
            && matches!(
                worker.action,
                Action::RunWorker {
                    cause: Cause::Reassessment { .. },
                    ..
                }
            )));
}

#[test]
fn fired_trigger_withholds_expand() {
    let mut run = assessed_slice(plan(), true);
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    assert!(!run.expand_offered());
}

#[test]
fn not_fired_trigger_offers_expand() {
    let mut run = assessed_slice(plan(), false);
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    assert!(run.expand_offered());
}

#[test]
fn unchanged_pr_replacement_keeps_spend_approval() {
    let mut run = assessed_slice(plan(), false);
    let spend = run.latest_id(DESIGN, "spend_request").unwrap();
    run.observe_pr("slice", "closed_unmerged");
    run.decided(
        "pr_closed",
        "pr",
        "replace_pr",
        json!({"feedback":"Replace the closed branch."}),
    );
    run.build("d1", "replacement");
    assert!(!run.wants(DESIGN, "spend_requester"));
    assert!(!run.wants(DESIGN, "slice_runner"));
    assert!(!run.offers(DESIGN, "spend_request_review"));
    assert_eq!(run.latest_id(DESIGN, "spend_request").unwrap(), spend);
    // The publish guardian also consumes approved(spend_request). An invalid
    // report revises the runner on the existing, still approved execution.
    let mut report = paid_report("d1", "r1");
    report["paid_results"] = json!([]);
    run.apply(
        Event::RevisionPublished {
            unit: UnitId::from(DESIGN),
            artifact: SymbolKey::from("slice_report"),
            body: report,
            predecessor: run.latest_id(DESIGN, "slice_report"),
            subject: run.latest_id(DESIGN, "spend_request"),
            by: None,
        },
        Writer::Operator {
            subject: "test".into(),
        },
    )
    .unwrap();
    assert!(!run
        .validation_messages(DESIGN, "slice_report")
        .contains(&"Paid results need an approved spend request.".to_owned()));
}

#[test]
fn direct_correction_wants_only_the_assessor() {
    let mut run = assessed_slice(plan(), false);
    let before = run.latest_id(DESIGN, "slice_assessment");
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "correct_assessment",
        json!({"rounds":[{"round":"round-1","assignment":"item-1","worker":"slice_assessor"}]}),
    );
    let agents: Vec<_> = run
        .last
        .wanted
        .iter()
        .filter(|worker| worker.unit.0 == DESIGN && worker.resolved.prompt.is_some())
        .map(|worker| worker.worker.0.as_str())
        .collect();
    assert_eq!(agents, ["slice_assessor"]);
    let mut body = slice_assessment("r1");
    body["verifications"] = json!([{"round_id":"round-1","outcome":"verified"}]);
    run.reviewed("slice_assessor", "slice_assessment", "slice_report", body);
    assert_ne!(before, run.latest_id(DESIGN, "slice_assessment"));
    assert!(run.offers(DESIGN, "slice_assessment_review"));
}

#[test]
fn design_readiness() {
    let mut run = assessed_slice(plan(), false);
    assert!(!run.expand_offered() && !run.is_done(DESIGN));
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    assert!(run.expand_offered() && !run.is_done(DESIGN));
    run.decided("slice_report_review", "slice_report", "expand", json!({}));
    assert!(!run.is_done(DESIGN) && !run.has_unit("run/expansion/g2"));
    run.confirm_merged(DESIGN);
    assert!(run.is_done(DESIGN) && run.has_unit("run/expansion/g2"));
}

#[test]
fn replacement_with_changed_digest_withholds_expansion_after_pr_confirmation() {
    let mut run = assessed_slice(plan(), false);
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    run.decided("slice_report_review", "slice_report", "expand", json!({}));
    run.observe_pr("slice", "closed_unmerged");
    run.decided(
        "pr_closed",
        "pr",
        "replace_pr",
        json!({"feedback":"Replace the closed branch."}),
    );
    run.build("d2", "replacement");
    assert!(run.wants(DESIGN, "spend_requester"));
    run.confirm_merged(DESIGN);
    assert!(!run.is_done(DESIGN) && !run.has_unit("run/expansion/g2"));
}

fn slice_approved() -> Run {
    let mut run = assessed_slice(plan(), false);
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    run.decided("slice_report_review", "slice_report", "expand", json!({}));
    run.confirm_merged(DESIGN);
    run
}

#[test]
fn at_most_two_expansions_are_active() {
    let mut body = plan();
    body["cases"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"g4_a","group":"g4","is_control":false}));
    body["groups"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"g4","case_ids":["g4_a"]}));
    let mut run = assessed_slice(body, false);
    run.decided(
        "slice_assessment_review",
        "slice_assessment",
        "approve_assessment",
        json!({}),
    );
    run.decided("slice_report_review", "slice_report", "expand", json!({}));
    run.confirm_merged(DESIGN);
    assert!(run.wants("run/expansion/g2", "expander"));
    assert!(run.wants("run/expansion/g3", "expander"));
    assert!(run
        .last
        .blocked
        .iter()
        .any(|block| block.unit.0 == "run/expansion/g4"
            && matches!(block.reason, BlockedReason::Capacity { .. })));
    run.complete_expansion("g2");
    assert!(run.wants("run/expansion/g4", "expander"));
}

#[test]
fn approved_plan_reaches_design() {
    let plan = plan();
    let mut run = Run::launch(plan.clone());
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/prepare/oakridge",
            worker: "git",
            artifact: "workspace",
        },
        body: workspace("oakridge"),
        subject: None,
    });
    let design = run
        .state()
        .units
        .iter()
        .find(|unit| unit.id.0 == DESIGN)
        .unwrap();
    assert_eq!(design.input.as_ref().unwrap()["approved_plan"], plan);
    let designer = run
        .last
        .wanted
        .iter()
        .find(|worker| worker.worker.0 == "designer")
        .unwrap();
    assert_eq!(designer.resolved.inputs["approved_plan"], plan);
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
            payload: json!({}),
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
        assert_eq!(input["digest_recipe"], digest_recipe());
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
    let freeze = run
        .state()
        .units
        .iter()
        .find(|unit| unit.id.0 == FREEZE)
        .unwrap();
    assert_eq!(
        freeze.input.as_ref().unwrap()["digest_recipe"],
        digest_recipe()
    );
}
