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
const BRIEF_IDS: &str = "Every assigned task must appear in a build item.";
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

/// The parts of a plan cohort these tests vary.
struct PlannedCohort<'a> {
    id: &'a str,
    repository_key: &'a str,
    depends_on: &'a [&'a str],
    task_ids: &'a [&'a str],
}

fn cohort(planned: PlannedCohort<'_>) -> Value {
    let PlannedCohort {
        id,
        repository_key,
        depends_on,
        task_ids,
    } = planned;
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

fn items(ids: &[&str]) -> Vec<Value> {
    ids.iter().map(|id| json!({"id": id, "description": format!("Deliver {id}"), "task_ids": [id], "decision_ids": [], "verification": ["tests"]})).collect()
}

fn brief_of(cohort: &Value) -> Value {
    json!({
        "cohort_id": cohort["id"], "repository_key": cohort["repository_key"],
        "title": cohort["title"], "depends_on": cohort["depends_on"], "goal": "goal",
        "files_in_scope": [], "decisions_made": [], "approaches_rejected": [],
        "build_items": cohort["acceptance_criteria"].as_array().unwrap().iter().map(|e| items(&[e["id"].as_str().unwrap()])[0].clone()).collect::<Vec<_>>(), "next_action": "start"
    })
}

fn build(head_sha: &str) -> Value {
    json!({"head_sha": head_sha, "summary": "built", "changed_files": [],
           "tests": {"passed": 1, "failed": 0}, "known_issues": []})
}

fn pr(key: &str, branch: &str) -> Value {
    json!({"pr_url": format!("https://forge/{key}/{branch}"), "branch": branch, "summary": "pr"})
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

    fn accept(&mut self, review: ReviewOf<'_>) -> Result<(), StepError> {
        self.decide(Decision {
            review,
            decision: "accept",
            payload: json!({}),
        })
    }

    fn request_changes(&mut self, review: ReviewOf<'_>) {
        self.decide(Decision {
            review,
            decision: "request_changes",
            payload: json!({"feedback": "Correct it"}),
        })
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
                WorkerOutput {
                    unit: &format!("run/prepare/{key}"),
                    worker: "git",
                    artifact: "workspace",
                },
                workspace(key),
            );
        }
        let analysis = "run/analysis";
        self.write(
            WorkerOutput {
                unit: analysis,
                worker: "author",
                artifact: "analysis",
            },
            json!({
                "summary": "s", "source_spec_refs": [], "findings": [], "requirements": [],
                "risks": [], "proposed_spec_updates": []
            }),
        );
        self.accept(ReviewOf {
            unit: analysis,
            review: "analysis_review",
            artifact: "analysis",
        })
        .unwrap();
        self.publish(Publication {
            output: WorkerOutput {
                unit: analysis,
                worker: "spec_editor",
                artifact: "spec",
            },
            body: json!("revised"),
            subject: None,
        });
        self.write(
            WorkerOutput {
                unit: analysis,
                worker: "spec_editor",
                artifact: "tasks",
            },
            tasks(task_ids),
        );
        self.accept(ReviewOf {
            unit: analysis,
            review: "spec_review",
            artifact: "spec",
        })
        .unwrap();
        self.accept(ReviewOf {
            unit: analysis,
            review: "tasks_review",
            artifact: "tasks",
        })
        .unwrap();
    }

    fn accepted_plan(&mut self, cohorts: &[Value]) {
        self.write(
            WorkerOutput {
                unit: "run/planning",
                worker: "planner",
                artifact: "plan",
            },
            plan(cohorts),
        );
        self.accept(ReviewOf {
            unit: "run/planning",
            review: "plan_review",
            artifact: "plan",
        })
        .unwrap();
    }

    fn accepted_brief(&mut self, cohort: &Value) {
        self.accepted_brief_body(brief_of(cohort));
    }

    fn accepted_brief_body(&mut self, brief: Value) {
        let unit = format!("run/briefs/{}", brief["cohort_id"].as_str().unwrap());
        self.write(
            WorkerOutput {
                unit: &unit,
                worker: "writer",
                artifact: "brief",
            },
            brief,
        );
        self.accept(ReviewOf {
            unit: &unit,
            review: "brief_review",
            artifact: "brief",
        })
        .unwrap();
    }

    fn completed_cohort(&mut self, id: &str, key: &str) {
        let unit = format!("run/implementation/{id}");
        self.publish(Publication {
            output: WorkerOutput {
                unit: &unit,
                worker: "builder",
                artifact: "pr",
            },
            body: pr(key, id),
            subject: None,
        });
        self.write(
            WorkerOutput {
                unit: &unit,
                worker: "builder",
                artifact: "build_result",
            },
            build("build-sha"),
        );
        let brief_unit = UnitId::from(format!("run/briefs/{id}").as_str());
        let brief = latest(self.state(), &brief_unit, &SymbolKey::from("brief")).unwrap();
        let subjects: Vec<Value> = brief.body["build_items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| json!({"kind":"build_item", "id":item["id"]}))
            .collect();
        let subject = self.latest_id(&unit, "build_result");
        self.publish(Publication {
            output: WorkerOutput {
                unit: &unit,
                worker: "assessor",
                artifact: "assessment",
            },
            body: assessment(
                "build-sha",
                json!([{ "subjects": subjects, "evidence": [] }]),
            ),
            subject,
        });
        self.end(&unit, "assessor");
        self.accept(ReviewOf {
            unit: &unit,
            review: "assessment_review",
            artifact: "assessment",
        })
        .unwrap();
        self.decide(Decision {
            review: ReviewOf {
                unit: &unit,
                review: "merge_confirmation",
                artifact: "pr",
            },
            decision: "confirm_merged",
            payload: json!({}),
        })
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
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/planning",
            worker: "planner",
            artifact: "plan",
        },
        body: plan(cohorts),
        subject: None,
    });
    run.validation_messages("run/planning", "plan")
}

#[test]
fn a_plan_naming_a_task_off_the_approved_list_fails() {
    let cohorts = [cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "AC9"],
    })];
    assert_eq!(plan_failures(&["T1"], &cohorts), [UNKNOWN_TASK]);
}

#[test]
fn a_plan_leaving_a_task_uncovered_fails() {
    let cohorts = [cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1"],
    })];
    assert_eq!(plan_failures(&["T1", "T2"], &cohorts), [MISSING_TASK]);
}

#[test]
fn a_plan_repeating_a_task_within_a_cohort_fails() {
    let cohorts = [cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T1"],
    })];
    assert_eq!(plan_failures(&["T1"], &cohorts), [REPEATED_TASK]);
}

#[test]
fn a_task_shared_by_two_cohorts_passes() {
    let cohorts = [
        cohort(PlannedCohort {
            id: "a",
            repository_key: "oakridge",
            depends_on: &[],
            task_ids: &["T1", "T7"],
        }),
        cohort(PlannedCohort {
            id: "b",
            repository_key: "oakridge",
            depends_on: &["a"],
            task_ids: &["T2", "T7"],
        }),
    ];
    assert_eq!(
        plan_failures(&["T1", "T2", "T7"], &cohorts),
        Vec::<String>::new()
    );
}

#[test]
fn a_plan_keeps_its_metadata_checks_beside_the_task_checks() {
    let cohorts = [cohort(PlannedCohort {
        id: "a",
        repository_key: "elsewhere",
        depends_on: &["a"],
        task_ids: &["T1"],
    })];
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
    let good = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    run.write(
        WorkerOutput {
            unit,
            worker: "planner",
            artifact: "plan",
        },
        plan(&[cohort(PlannedCohort {
            id: "a",
            repository_key: "oakridge",
            depends_on: &[],
            task_ids: &["T1"],
        })]),
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

    let refusal = run
        .accept(ReviewOf {
            unit,
            review: "plan_review",
            artifact: "plan",
        })
        .unwrap_err();
    assert!(
        matches!(&refusal, StepError::Rejected { reason, .. } if reason == REFUSED),
        "{refusal:?}"
    );
    assert_eq!(run.review_decisions(unit), 0);
    assert!(!run.is_done(unit));
    assert!(!run.has_unit("run/briefs/a"));

    run.request_changes(ReviewOf {
        unit,
        review: "plan_review",
        artifact: "plan",
    });
    assert!(!run.is_done(unit));
    run.write(
        WorkerOutput {
            unit,
            worker: "planner",
            artifact: "plan",
        },
        plan(std::slice::from_ref(&good)),
    );
    assert!(run.validation_messages(unit, "plan").is_empty());
    run.accept(ReviewOf {
        unit,
        review: "plan_review",
        artifact: "plan",
    })
    .unwrap();
    assert!(run.is_done(unit));
    assert!(run.has_unit("run/briefs/a"));
}

#[test]
fn the_earlier_failed_revision_stays_history_and_stays_unacceptable() {
    let mut run = at_planning(&["T1"]);
    let unit = "run/planning";
    run.write(
        WorkerOutput {
            unit,
            worker: "planner",
            artifact: "plan",
        },
        plan(&[cohort(PlannedCohort {
            id: "a",
            repository_key: "oakridge",
            depends_on: &[],
            task_ids: &["T9", "T1"],
        })]),
    );
    let failed = run.latest_id(unit, "plan").unwrap();
    run.write(
        WorkerOutput {
            unit,
            worker: "planner",
            artifact: "plan",
        },
        plan(&[cohort(PlannedCohort {
            id: "a",
            repository_key: "oakridge",
            depends_on: &[],
            task_ids: &["T1"],
        })]),
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
    run.accept(ReviewOf {
        unit,
        review: "plan_review",
        artifact: "plan",
    })
    .unwrap();
    assert!(run.is_done(unit));
}

#[test]
fn an_operator_edit_is_validated_and_refused_like_an_agent_revision() {
    let mut run = at_planning(&["T1"]);
    let unit = "run/planning";
    run.write(
        WorkerOutput {
            unit,
            worker: "planner",
            artifact: "plan",
        },
        plan(&[cohort(PlannedCohort {
            id: "a",
            repository_key: "oakridge",
            depends_on: &[],
            task_ids: &["T1"],
        })]),
    );
    let predecessor = run.latest_id(unit, "plan");
    run.apply(
        Event::RevisionPublished {
            unit: UnitId::from(unit),
            artifact: SymbolKey::from("plan"),
            body: plan(&[cohort(PlannedCohort {
                id: "a",
                repository_key: "oakridge",
                depends_on: &[],
                task_ids: &["T2"],
            })]),
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
    assert!(run
        .accept(ReviewOf {
            unit,
            review: "plan_review",
            artifact: "plan"
        })
        .is_err());
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
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let mut brief = brief_of(&planned);
    brief["build_items"] = json!(items(ids));
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/briefs/a",
            worker: "writer",
            artifact: "brief",
        },
        body: brief,
        subject: None,
    });
    run.validation_messages("run/briefs/a", "brief")
}

#[test]
fn a_brief_with_its_cohort_ids_in_order_passes_with_rewritten_text() {
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let mut brief = brief_of(&planned);
    brief["build_items"][0]["description"] = json!("Self-contained wording of the same obligation");
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/briefs/a",
            worker: "writer",
            artifact: "brief",
        },
        body: brief,
        subject: None,
    });
    assert!(run.validation_messages("run/briefs/a", "brief").is_empty());
}

#[test]
fn a_brief_missing_a_cohort_id_fails() {
    assert_eq!(brief_failures(&["T1"]), [BRIEF_IDS]);
}

#[test]
fn a_brief_adding_an_id_fails() {
    assert_eq!(
        brief_failures(&["T1", "T2", "T3"]),
        ["Build-item task ids must belong to the cohort allocation."]
    );
}

#[test]
fn a_brief_replacing_an_id_fails() {
    assert_eq!(
        brief_failures(&["T1", "AC2"]),
        [
            BRIEF_IDS,
            "Build-item task ids must belong to the cohort allocation."
        ]
    );
}

#[test]
fn a_brief_reordering_its_build_items_passes() {
    assert_eq!(brief_failures(&["T2", "T1"]), Vec::<String>::new());
}

#[test]
fn a_brief_keeps_its_cohort_metadata_checks() {
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1"],
    });
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1"]);
    let mut brief = brief_of(&planned);
    brief["cohort_id"] = json!("other");
    brief["repository_key"] = json!("elsewhere");
    brief["depends_on"] = json!(["z"]);
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/briefs/a",
            worker: "writer",
            artifact: "brief",
        },
        body: brief,
        subject: None,
    });
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
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    let unit = "run/briefs/a";
    let mut reordered = brief_of(&planned);
    reordered["build_items"] = json!(items(&["T1"]));
    run.write(
        WorkerOutput {
            unit,
            worker: "writer",
            artifact: "brief",
        },
        reordered,
    );

    let refusal = run
        .accept(ReviewOf {
            unit,
            review: "brief_review",
            artifact: "brief",
        })
        .unwrap_err();
    assert!(
        matches!(&refusal, StepError::Rejected { reason, .. } if reason == REFUSED),
        "{refusal:?}"
    );
    assert_eq!(run.review_decisions(unit), 0);
    assert!(!run.is_done(unit));
    assert!(!run.has_unit("run/implementation/a"));

    run.request_changes(ReviewOf {
        unit,
        review: "brief_review",
        artifact: "brief",
    });
    run.write(
        WorkerOutput {
            unit,
            worker: "writer",
            artifact: "brief",
        },
        brief_of(&planned),
    );
    run.accept(ReviewOf {
        unit,
        review: "brief_review",
        artifact: "brief",
    })
    .unwrap();
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
        cohort(PlannedCohort {
            id: "a1",
            repository_key: "alpha",
            depends_on: &[],
            task_ids: &["T1", "T2"],
        }),
        cohort(PlannedCohort {
            id: "a2",
            repository_key: "alpha",
            depends_on: &["a1"],
            task_ids: &["T1", "T3"],
        }),
        cohort(PlannedCohort {
            id: "b1",
            repository_key: "beta",
            depends_on: &[],
            task_ids: &["T4"],
        }),
    ];
    let mut run = Run::launch(&repositories);
    run.prepare_and_analyze(&repositories, &task_ids);
    run.accepted_plan(&cohorts);
    for planned in &cohorts {
        let mut brief = brief_of(planned);
        // T1 is split within a1 and shared across cohorts; other items combine tasks.
        brief["build_items"] = match planned["id"].as_str().unwrap() {
            "a1" => json!([
                {"id":"api", "description":"API contribution", "task_ids":["T1"], "decision_ids":[], "verification":["API tests"]},
                {"id":"storage", "description":"Storage contribution", "task_ids":["T1","T2"], "decision_ids":[], "verification":["Storage tests"]}
            ]),
            "a2" => json!([
                {"id":"ui", "description":"UI contribution", "task_ids":["T1","T3"], "decision_ids":[], "verification":["UI tests"]}
            ]),
            "b1" => json!([
                {"id":"adapter", "description":"Adapter contribution", "task_ids":["T4"], "decision_ids":[], "verification":["Adapter tests"]}
            ]),
            _ => unreachable!("known integration cohort"),
        };
        run.accepted_brief_body(brief);
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
    let contributions: Vec<(&str, &str, &str)> = briefs
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|brief| {
            let cohort = brief["cohort_id"].as_str().unwrap();
            brief["build_items"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(move |item| {
                    let item_id = item["id"].as_str().unwrap();
                    item["task_ids"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(move |task| (task.as_str().unwrap(), item_id, cohort))
                })
        })
        .collect();
    assert_eq!(
        contributions,
        [
            ("T1", "api", "a1"),
            ("T1", "storage", "a1"),
            ("T2", "storage", "a1"),
            ("T1", "ui", "a2"),
            ("T3", "ui", "a2")
        ]
    );
}

#[test]
fn integration_findings_link_tasks_many_to_many_without_a_build_subject() {
    let mut run = at_integration();
    let unit = "run/integration/alpha";
    let head = "integration-sha";
    let findings = json!([
        {"subjects": [{"kind":"task","id":"T1"}], "description": "First half", "status": "met",
         "evidence": [{"kind": "file", "ref": "src/a.rs:1-9"}]},
        {"subjects": [{"kind":"task","id":"T1"}], "description": "Second half", "status": "partial",
         "evidence": [{"kind": "test", "ref": "suite::case"}]},
        {"subjects": [{"kind":"task","id":"T2"},{"kind":"task","id":"T3"}], "description": "Shared", "status": "not_met",
         "evidence": [{"kind": "output", "ref": "cargo test", "detail": "1 failed"}]},
        {"subjects": [], "description": "Unlinked note", "evidence": []}
    ]);
    run.publish(Publication {
        output: WorkerOutput {
            unit,
            worker: "integrator",
            artifact: "assessment",
        },
        body: assessment(head, findings.clone()),
        subject: None,
    });
    run.write(
        WorkerOutput {
            unit,
            worker: "integrator",
            artifact: "pr",
        },
        pr("alpha", "integration"),
    );

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
    run.publish(Publication {
        output: WorkerOutput {
            unit,
            worker: "integrator",
            artifact: "assessment",
        },
        body: assessment("sha", json!([])),
        subject: None,
    });
    run.write(
        WorkerOutput {
            unit,
            worker: "integrator",
            artifact: "pr",
        },
        pr("alpha", "integration"),
    );

    let review = run
        .last
        .reviews
        .iter()
        .find(|review| review.unit.0 == unit && review.review.0 == "integration_review")
        .expect("integration review awaits");
    assert_eq!(cohort_ids(&review.inputs["briefs"]), ["a1", "a2"]);

    run.request_changes(ReviewOf {
        unit,
        review: "integration_review",
        artifact: "pr",
    });
    assert_eq!(cohort_ids(&integrator_briefs(&run, unit)), ["a1", "a2"]);
}

#[test]
fn finding_links_are_a_required_list_of_ids() {
    let mut run = at_integration();
    let unit = "run/integration/alpha";
    let action = run.action(unit, "integrator");
    for findings in [
        json!([{"evidence": []}]),
        json!([{"subjects": "T1", "evidence": []}]),
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
        ["description", "evidence", "status", "subjects"]
    );
}

#[test]
fn an_acceptance_entry_without_its_decision_links_fails_schema() {
    let mut run = at_planning(&["T1"]);
    let mut partial = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1"],
    });
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

#[test]
fn build_item_rules_accept_split_and_combined_tasks_and_name_each_failure() {
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    let mut valid = brief_of(&planned);
    valid["build_items"] = json!(items(&["T1", "T2", "extra"]));
    valid["build_items"][2]["task_ids"] = json!(["T1", "T2"]);
    for (field, value, message) in [
        ("id", json!("T1"), "Build-item ids must be unique."),
        (
            "task_ids",
            json!(["T9"]),
            "Build-item task ids must belong to the cohort allocation.",
        ),
        (
            "description",
            json!(""),
            "Every build item must have a nonempty description.",
        ),
        (
            "task_ids",
            json!([]),
            "Every build item must reference at least one task.",
        ),
        (
            "decision_ids",
            json!(["D9"]),
            "Build-item decision ids must name brief decisions.",
        ),
    ] {
        let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
        let mut invalid = valid.clone();
        invalid["build_items"][2][field] = value;
        run.publish(Publication {
            output: WorkerOutput {
                unit: "run/briefs/a",
                worker: "writer",
                artifact: "brief",
            },
            body: invalid,
            subject: None,
        });
        assert_eq!(run.validation_messages("run/briefs/a", "brief"), [message]);
    }
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
    run.publish(Publication {
        output: WorkerOutput {
            unit: "run/briefs/a",
            worker: "writer",
            artifact: "brief",
        },
        body: valid,
        subject: None,
    });
    assert!(run.validation_messages("run/briefs/a", "brief").is_empty());
}

#[test]
fn cohort_assessment_rules_retain_incomplete_revision_and_refuse_approval() {
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1", "T2"],
    });
    for (subjects, head, messages) in [
        (
            json!([{"kind":"build_item","id":"T1"}]),
            "sha",
            vec!["Every brief build item must be assessed."],
        ),
        (
            json!([{"kind":"task","id":"T1"},{"kind":"build_item","id":"T2"}]),
            "sha",
            vec!["Cohort assessment subjects must be build items."],
        ),
        (
            json!([{"kind":"build_item","id":"T1"},{"kind":"build_item","id":"T2"},{"kind":"build_item","id":"unknown"}]),
            "sha",
            vec!["Cohort assessment subjects must name brief build items."],
        ),
        (
            json!([{"kind":"build_item","id":"T1"},{"kind":"build_item","id":"T2"}]),
            "stale",
            vec!["Assessment head_sha must match the latest build result."],
        ),
        (
            json!([{"kind":"build_item","id":"T1"},{"kind":"build_item","id":"T2"}]),
            "sha",
            vec![],
        ),
    ] {
        let mut run = at_briefs(std::slice::from_ref(&planned), &["T1", "T2"]);
        run.accepted_brief(&planned);
        let unit = "run/implementation/a";
        run.publish(Publication {
            output: WorkerOutput {
                unit,
                worker: "builder",
                artifact: "pr",
            },
            body: pr("oakridge", "a"),
            subject: None,
        });
        run.write(
            WorkerOutput {
                unit,
                worker: "builder",
                artifact: "build_result",
            },
            build("sha"),
        );
        let findings = json!([{"subjects":subjects,"evidence":[]},{"subjects":[],"evidence":[]}]);
        run.publish(Publication {
            output: WorkerOutput {
                unit,
                worker: "assessor",
                artifact: "assessment",
            },
            body: assessment(head, findings.clone()),
            subject: run.latest_id(unit, "build_result"),
        });
        run.end(unit, "assessor");
        assert_eq!(run.validation_messages(unit, "assessment"), messages);
        assert_eq!(
            latest(
                run.state(),
                &UnitId::from(unit),
                &SymbolKey::from("assessment")
            )
            .unwrap()
            .body["findings"],
            findings
        );
        let review = ReviewOf {
            unit,
            review: "assessment_review",
            artifact: "assessment",
        };
        if messages.is_empty() {
            run.accept(review).unwrap();
        } else {
            let offered = run
                .last
                .reviews
                .iter()
                .find(|candidate| {
                    candidate.unit.0 == unit && candidate.review.0 == "assessment_review"
                })
                .expect("failed assessment stays available to the operator");
            assert!(offered
                .decisions
                .iter()
                .any(|decision| decision.decision.0 == "request_assessment_changes"));
            assert!(!offered
                .decisions
                .iter()
                .any(|decision| decision.decision.0 == "accept"));
            let refusal = run.accept(review);
            assert!(
                matches!(&refusal, Err(StepError::Rejected { reason, .. }) if reason == REFUSED),
                "{refusal:?}"
            );
            run.decide(Decision {
                review,
                decision: "request_assessment_changes",
                payload: json!({"feedback":"address missing items"}),
            })
            .unwrap();
            let revise = run.last.wanted.iter().find(|wanted| {
                matches!(&wanted.action, Action::RunWorker { unit: owner, worker, mode: Mode::Revise, .. }
                    if owner.0 == unit && worker.0 == "assessor")
            }).expect("operator request starts an assessment revision");
            assert!(revise
                .resolved
                .feedback
                .iter()
                .any(|entry| entry.review.0 == "assessment_review"));
        }
    }
}

#[test]
fn integration_validates_task_and_qualified_build_item_subjects() {
    for (subject, message) in [
        (json!({"kind":"task","id":"T1"}), None),
        (json!({"kind":"task","id":"T2"}), None),
        (json!({"kind":"task","id":"T3"}), None),
        (
            json!({"kind":"build_item","id":"api","cohort_id":"a1"}),
            None,
        ),
        (
            json!({"kind":"build_item","id":"storage","cohort_id":"a1"}),
            None,
        ),
        (
            json!({"kind":"task","id":"api"}),
            Some("Integration task subjects must name tasks in applicable briefs."),
        ),
        (
            json!({"kind":"build_item","id":"T1","cohort_id":"a1"}),
            Some(
                "Integration build-item subjects must name an item in the qualified cohort brief.",
            ),
        ),
        (
            json!({"kind":"build_item","id":"ui","cohort_id":"a2"}),
            None,
        ),
        (
            json!({"kind":"task","id":"T4"}),
            Some("Integration task subjects must name tasks in applicable briefs."),
        ),
        (
            json!({"kind":"build_item","id":"api"}),
            Some(
                "Integration build-item subjects must name an item in the qualified cohort brief.",
            ),
        ),
        (
            json!({"kind":"build_item","id":"api","cohort_id":"missing"}),
            Some(
                "Integration build-item subjects must name an item in the qualified cohort brief.",
            ),
        ),
        (
            json!({"kind":"build_item","id":"ui","cohort_id":"a1"}),
            Some(
                "Integration build-item subjects must name an item in the qualified cohort brief.",
            ),
        ),
    ] {
        let mut run = at_integration();
        let unit = "run/integration/alpha";
        run.publish(Publication {
            output: WorkerOutput {
                unit,
                worker: "integrator",
                artifact: "assessment",
            },
            body: assessment("sha", json!([{"subjects":[subject],"evidence":[]}])),
            subject: None,
        });
        assert_eq!(
            run.validation_messages(unit, "assessment"),
            message.into_iter().collect::<Vec<_>>()
        );
        if let Some(message) = message {
            run.publish(Publication {
                output: WorkerOutput {
                    unit,
                    worker: "integrator",
                    artifact: "pr",
                },
                body: pr("alpha", "integration"),
                subject: None,
            });
            run.end(unit, "integrator");
            let revise = run.last.wanted.iter().find(|wanted| {
                matches!(&wanted.action, Action::RunWorker { unit: owner, worker, mode: Mode::Revise, .. }
                    if owner.0 == unit && worker.0 == "integrator")
            }).expect("invalid integration assessment still auto-returns");
            assert!(revise.resolved.feedback.iter().any(|entry| {
                entry.review.0 == VALIDATION_REVIEW && entry.payload["feedback"] == message
            }));
        }
    }
}

#[test]
fn implementation_and_integration_pin_accepted_brief_identities() {
    let run = at_integration();
    for (unit_id, input, cohorts) in [
        ("run/implementation/a1", "brief", vec!["a1"]),
        ("run/implementation/a2", "brief", vec!["a2"]),
        ("run/integration/alpha", "briefs", vec!["a1", "a2"]),
        ("run/integration/beta", "briefs", vec!["b1"]),
    ] {
        let unit = run
            .state()
            .units
            .iter()
            .find(|unit| unit.id.0 == unit_id)
            .unwrap();
        let expected: Vec<_> = cohorts
            .into_iter()
            .map(|cohort| {
                let source = UnitId(format!("run/briefs/{cohort}"));
                let decision = run
                    .state()
                    .decisions
                    .iter()
                    .find(|decision| {
                        decision.unit() == &source
                            && decision.review() == Some(&SymbolKey::from("brief_review"))
                            && decision.effect() == Some(DecisionEffect::Approve)
                    })
                    .unwrap();
                InputProvenance {
                    input: SymbolKey::from(input),
                    unit: source,
                    revision_id: decision.target().clone(),
                }
            })
            .collect();
        assert_eq!(unit.input_provenance.as_ref(), Some(&expected));
    }
}

#[test]
fn later_revision_and_reads_do_not_replace_frozen_provenance() {
    let mut run = at_integration();
    let recorded = run
        .state()
        .units
        .iter()
        .find(|u| u.id.0 == "run/implementation/a1")
        .unwrap()
        .input_provenance
        .clone();
    let mut snapshot = run.state().clone();
    let mut later = snapshot
        .revisions
        .iter()
        .find(|r| r.unit.0 == "run/briefs/a1" && r.artifact.0 == "brief")
        .unwrap()
        .clone();
    later.id = RevisionId::from("later-brief");
    later.seq += 100;
    snapshot.revisions.push(later);
    run.last.snapshot = snapshot;
    run.apply(Event::Launched { input: json!({}) }, Writer::Engine)
        .unwrap();
    assert_eq!(
        run.state()
            .units
            .iter()
            .find(|u| u.id.0 == "run/implementation/a1")
            .unwrap()
            .input_provenance,
        recorded
    );
}

#[test]
fn unrelated_inputs_record_no_entries_and_legacy_records_stay_unresolved() {
    let mut run = at_integration();
    let root = run
        .state()
        .units
        .iter()
        .find(|unit| unit.id.0 == "run")
        .unwrap();
    assert_eq!(root.input_provenance, Some(vec![]));
    for unit in &mut run.last.snapshot.units {
        unit.input_provenance = None;
    }
    run.apply(Event::Launched { input: json!({}) }, Writer::Engine)
        .unwrap();
    assert!(run
        .state()
        .units
        .iter()
        .all(|unit| unit.input_provenance.is_none()));
}

#[test]
fn revised_brief_provenance_uses_accept_target_after_request_changes() {
    let planned = cohort(PlannedCohort {
        id: "a",
        repository_key: "oakridge",
        depends_on: &[],
        task_ids: &["T1"],
    });
    let mut run = at_briefs(std::slice::from_ref(&planned), &["T1"]);
    let output = WorkerOutput {
        unit: "run/briefs/a",
        worker: "writer",
        artifact: "brief",
    };
    let review = ReviewOf {
        unit: output.unit,
        review: "brief_review",
        artifact: output.artifact,
    };
    run.write(output, brief_of(&planned));
    let rejected = run.latest_id(output.unit, output.artifact).unwrap();
    run.request_changes(review);
    let mut revised = brief_of(&planned);
    revised["goal"] = json!("corrected goal");
    run.write(output, revised);
    run.accept(review).unwrap();
    let accepted = run
        .state()
        .decisions
        .iter()
        .find(|decision| {
            decision.unit().0 == output.unit
                && decision.review() == Some(&SymbolKey::from("brief_review"))
                && decision.effect() == Some(DecisionEffect::Approve)
        })
        .unwrap()
        .target()
        .clone();
    assert_ne!(accepted, rejected);

    // A later revision exists before integration materializes, but is not the
    // accepted source outcome's revision. Snapshot injection models Scenario F.
    let mut later = run
        .state()
        .revisions
        .iter()
        .find(|r| r.id == accepted)
        .unwrap()
        .clone();
    later.id = RevisionId::from("later-unaccepted-brief");
    later.seq += 100;
    let later_id = later.id.clone();
    run.last.snapshot.revisions.push(later);
    run.completed_cohort("a", "oakridge");
    for (unit_id, input) in [
        ("run/implementation/a", "brief"),
        ("run/integration/oakridge", "briefs"),
    ] {
        let entries = run
            .state()
            .units
            .iter()
            .find(|unit| unit.id.0 == unit_id)
            .unwrap()
            .input_provenance
            .as_ref()
            .unwrap();
        assert_eq!(
            entries,
            &vec![InputProvenance {
                input: SymbolKey::from(input),
                unit: UnitId::from(output.unit),
                revision_id: accepted.clone(),
            }]
        );
        assert!(entries
            .iter()
            .all(|entry| entry.revision_id != rejected && entry.revision_id != later_id));
    }
}

#[test]
fn missing_approval_never_uses_latest_or_shifts_other_members_provenance() {
    let mut run = at_integration();
    // Model an old completed source with no retained approval. Rematerialize
    // collection members from their source outcomes to test sparse lineage.
    run.last.snapshot.decisions.retain(|decision| {
        !(decision.unit().0 == "run/briefs/a1"
            && decision.effect() == Some(DecisionEffect::Approve))
    });
    run.last
        .snapshot
        .units
        .retain(|unit| !unit.id.0.starts_with("run/implementation/"));
    run.last
        .snapshot
        .attempts
        .retain(|attempt| !attempt.unit.0.starts_with("run/implementation/"));
    run.apply(Event::Launched { input: json!({}) }, Writer::Engine)
        .unwrap();
    for cohort in ["a1", "a2", "b1"] {
        let source = UnitId(format!("run/briefs/{cohort}"));
        let expected = run
            .state()
            .decisions
            .iter()
            .find(|decision| {
                decision.unit() == &source && decision.effect() == Some(DecisionEffect::Approve)
            })
            .map(|decision| InputProvenance {
                input: SymbolKey::from("brief"),
                unit: source.clone(),
                revision_id: decision.target().clone(),
            })
            .into_iter()
            .collect::<Vec<_>>();
        let member = run
            .state()
            .units
            .iter()
            .find(|unit| unit.id.0 == format!("run/implementation/{cohort}"))
            .unwrap();
        assert_eq!(member.input_provenance.as_ref(), Some(&expected));
    }
}
