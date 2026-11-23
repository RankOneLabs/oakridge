use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_evaluator::step;
use workflow_model::*;

fn assessment_stage() -> Value {
    json!({
        "input": {}, "outcome": {"work": "latest(work)"}, "done_when": "approved(assessment) and published(work)",
        "artifacts": {"work": {"kind": "record", "schema": "text"},
            "assessment": {"kind":"assessment", "schema":{"proposals": "list(feedback_proposal)"}}},
        "workers": {
            "builder": {"kind":"agent","inputs":{},"prompts":{"initial":"p","revise":"p"},"produces":["work"]},
            "assessor": {"kind":"agent","inputs":{},"prompts":{"review":"p","revise":"p"},"evaluates":"work","produces":["assessment"]}
        },
        "reviews": {"assessment_review": {"of":"assessment","by":"operator","prompt":"p","decisions":{
            "approve":{"effect":"approve","label":"Approve","operation":"approve_assessment"},
            "send":{"effect":"request_changes","label":"Send","on":"work","operation":"dispatch_feedback"}
        }}}
    })
}

struct Run {
    program: CheckedWorkflow,
    result: StepResult,
}
impl Run {
    fn launch(workflow: Value, input: Value) -> Self {
        let source = workflow_compiler::decode_workflow_value_detailed(workflow).unwrap();
        let program = workflow_compiler::compile_workflow(
            &source,
            &[],
            &BTreeMap::from([("p".into(), String::new())]),
        )
        .unwrap();
        let result = step(
            &program,
            &StepSnapshot {
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
            &Incoming {
                event: Event::Launched { input },
                writer: Writer::Engine,
                ingress_id: None,
            },
        )
        .unwrap();
        Self { program, result }
    }
    fn apply(&mut self, event: Event) {
        self.result = step(
            &self.program,
            &self.result.snapshot,
            &Incoming {
                event,
                writer: Writer::Engine,
                ingress_id: None,
            },
        )
        .unwrap();
    }
    fn revision(&self, path: &str, artifact: &str) -> RevisionId {
        self.result
            .snapshot
            .revisions
            .iter()
            .rev()
            .find(|r| r.unit.0 == path && r.artifact.0 == artifact)
            .unwrap()
            .id
            .clone()
    }
    fn publish(
        &mut self,
        path: &str,
        worker: &str,
        artifact: &str,
        body: Value,
        subject: Option<RevisionId>,
    ) {
        let action = self
            .result
            .snapshot
            .attempts
            .iter()
            .find(|a| a.unit.0 == path && a.worker.0 == worker)
            .unwrap()
            .action_id
            .clone();
        self.apply(Event::RevisionPublished {
            unit: UnitId::from(path),
            artifact: SymbolKey::from(artifact),
            body,
            predecessor: None,
            subject,
            by: Some(PublishingAttempt {
                action: action.clone(),
                seq: 1,
            }),
        });
        self.apply(Event::WorkerEnded {
            action,
            result: WorkerResult::Succeeded,
        });
    }
    fn assess(&mut self, path: &str) {
        self.publish(path, "builder", "work", json!("ready"), None);
        self.publish(
            path,
            "assessor",
            "assessment",
            json!({"proposals":[]}),
            Some(self.revision(path, "work")),
        );
    }
    fn approve(&mut self, path: &str) {
        self.apply(Event::OperatorDecided {
            unit: UnitId::from(path),
            review: SymbolKey::from("assessment_review"),
            decision: SymbolKey::from("approve"),
            target: self.revision(path, "assessment"),
            payload: json!({}),
        });
    }
    fn status(&self, path: &str) -> &UnitStatus {
        &self
            .result
            .snapshot
            .units
            .iter()
            .find(|u| u.id.0 == path)
            .unwrap()
            .status
    }
}

#[test]
fn joined_stage_starts_after_both_assessments_receive_final_approval() {
    let stage = assessment_stage();
    let mut run = Run::launch(
        json!({
            "workflow":"joined","input":{},"run":{"units":{
                "left":{"stage":"left"},"right":{"stage":"right"},
                "joined":{"stage":"joined","input":{"left":"left.outcome.work","right":"right.outcome.work"}}
            },"outcome":{}},
            "stages":{"left":stage,"right":stage,"joined":{
                "input":{"left":"text","right":"text"},"outcome":{},"done_when":"published(result)",
                "workers":{"builder":{"kind":"agent","inputs":{},"prompts":{"initial":"p"},"produces":["result"]}},
                "artifacts":{"result":{"kind":"record","schema":"text"}}
            }}
        }),
        json!({}),
    );
    run.assess("run/left");
    run.assess("run/right");
    run.approve("run/left");
    assert!(matches!(run.status("run/left"), UnitStatus::Done { .. }));
    assert_eq!(run.status("run/right"), &UnitStatus::Active);
    assert_eq!(run.status("run/joined"), &UnitStatus::NotStarted);
    run.approve("run/right");
    assert_eq!(run.status("run/joined"), &UnitStatus::Active);
}

fn collection(capacity: u32, depends: bool) -> Run {
    Run::launch(
        json!({
            "workflow":"collection","input":{"members":"list({key: ident, after: list(ident)})"},
            "run":{"pools":{"p":capacity},"units":{"members":{
                "for_each":"input.members","key":"each.key","after":"each.after","stage":"work","pool":"p"
            }},"outcome":{}},
            "stages":{"work":assessment_stage()}
        }),
        json!({"members":[{"key":"a","after":[]},{"key":"b","after":if depends { vec!["a"] } else { vec![] }}]}),
    )
}

#[test]
fn collection_member_waits_for_predecessor_assessment_approval() {
    let mut run = collection(2, true);
    run.assess("run/a");
    assert_eq!(run.status("run/b"), &UnitStatus::NotStarted);
    run.approve("run/a");
    assert_eq!(run.status("run/b"), &UnitStatus::Active);
}

#[test]
fn pool_capacity_counts_active_members_awaiting_final_approval() {
    let mut one = collection(1, false);
    one.assess("run/a");
    assert_eq!(one.status("run/b"), &UnitStatus::NotStarted);
    let waiting = one
        .result
        .blocked
        .iter()
        .find(|entry| entry.unit.0 == "run/b")
        .unwrap();
    assert_eq!(
        waiting.reason,
        BlockedReason::Capacity {
            pool: SymbolKey::from("p")
        }
    );
    let two = collection(2, false);
    assert_eq!(two.status("run/a"), &UnitStatus::Active);
    assert_eq!(two.status("run/b"), &UnitStatus::Active);
}

#[test]
fn launch_evaluates_label_from_declared_input_fields() {
    let mut run = Run::launch(
        json!({
            "workflow": "labelled", "input": {"caption":"text","targets":"list(ident)"},
            "label": {"title":"input.caption","repositories":"input.targets"},
            "run": {"units": {}, "outcome": {}}, "stages": {}
        }),
        json!({"caption":"Portable title","targets":["r1","r2"]}),
    );
    assert_eq!(
        run.result.run_label,
        Some(RunLabel {
            title: "Portable title".into(),
            repositories: vec!["r1".into(), "r2".into()],
        })
    );
    run.apply(Event::Launched {
        input: json!({"caption":"Other","targets":[]}),
    });
    assert_eq!(run.result.run_label, None);
}
