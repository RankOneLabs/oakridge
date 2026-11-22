use serde_json::{json, Value};
use std::collections::BTreeMap;
use workflow_evaluator::step;
use workflow_model::*;

const UNIT: &str = "run/work";

fn workflow() -> Value {
    json!({
        "workflow":"assignment_rounds", "input":{}, "run":{"units":{"work":{"stage":"work"}},"outcome":{}},
        "stages":{"work":{"input":{}, "outcome":{}, "done_when":"approved(assessment)",
            "artifacts":{
                "part_a":{"kind":"record","schema":"text"}, "part_b":{"kind":"record","schema":"text"},
                "assessment":{"kind":"assessment","schema":{"proposals":"list(feedback_proposal)","checks":"list(assignment_verification)"}}
            },
            "workers":{
                "builder_a":{"kind":"agent","inputs":{},"prompts":{"initial":"p","revise":"p"},"produces":["part_a"]},
                "builder_b":{"kind":"agent","inputs":{},"prompts":{"initial":"p","revise":"p"},"produces":["part_b"]},
                "assessor":{"kind":"agent","inputs":{},"prompts":{"review":"p","revise":"p"},"evaluates":"part_a","produces":["assessment"]}
            },
            "reviews":{"assessment_review":{"of":"assessment","by":"operator","prompt":"p","decisions":{
                "approve":{"effect":"approve","label":"Approve","operation":"approve_assessment"},
                "send":{"effect":"request_changes","label":"Send","on":"part_a","operation":"dispatch_feedback"}
            }}}
        }}
    })
}

struct Run {
    program: CheckedWorkflow,
    result: StepResult,
}
impl Run {
    fn launch(source: Value) -> Self {
        let source = workflow_compiler::decode_workflow_value_detailed(source).unwrap();
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
                event: Event::Launched { input: json!({}) },
                writer: Writer::Engine,
                ingress_id: None,
            },
        )
        .unwrap();
        Self { program, result }
    }
    fn event(&self, event: Event) -> Incoming {
        Incoming {
            event,
            writer: Writer::Engine,
            ingress_id: None,
        }
    }
    fn apply(&mut self, event: Event) {
        self.result = step(&self.program, &self.result.snapshot, &self.event(event)).unwrap();
    }
    fn action(&self, worker: &str) -> ActionKey {
        self.result
            .snapshot
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.worker.0 == worker)
            .unwrap()
            .action_id
            .clone()
    }
    fn latest(&self, artifact: &str) -> Option<RevisionId> {
        self.result
            .snapshot
            .revisions
            .iter()
            .rev()
            .find(|revision| revision.artifact.0 == artifact)
            .map(|revision| revision.id.clone())
    }
    fn publish_with(
        &mut self,
        action: ActionKey,
        artifact: &str,
        body: Value,
        subject: Option<RevisionId>,
    ) {
        self.apply(Event::RevisionPublished {
            unit: UnitId::from(UNIT),
            artifact: SymbolKey::from(artifact),
            body,
            predecessor: self.latest(artifact),
            subject,
            by: Some(action),
        });
    }
    fn publish(&mut self, worker: &str, artifact: &str, body: Value, subject: Option<RevisionId>) {
        self.publish_with(self.action(worker), artifact, body, subject);
    }
    fn end(&mut self, worker: &str) {
        self.apply(Event::WorkerEnded {
            action: self.action(worker),
            result: WorkerResult::Succeeded,
        });
    }
    fn assess(&mut self) {
        self.publish(
            "assessor",
            "assessment",
            json!({"proposals":[],"checks":[]}),
            self.latest("part_a"),
        );
        self.end("assessor");
    }
    fn seeded() -> Self {
        Self::seeded_with(workflow())
    }
    fn seeded_with(source: Value) -> Self {
        let mut run = Self::launch(source);
        run.publish("builder_a", "part_a", json!("a"), None);
        run.end("builder_a");
        run.publish("builder_b", "part_b", json!("b"), None);
        run.end("builder_b");
        run.assess();
        run
    }
    fn dispatch(&self, rounds: &[(&str, &str, &str)]) -> Event {
        let requests = rounds.iter().map(|(round, assignment, worker)| json!({"round":round,"assignment":assignment,"worker":worker})).collect::<Vec<_>>();
        Event::OperatorDecided {
            unit: UnitId::from(UNIT),
            review: SymbolKey::from("assessment_review"),
            decision: SymbolKey::from("send"),
            target: self.latest("part_a").unwrap(),
            payload: json!({"rounds":requests}),
        }
    }
    fn owes(&self, worker: &str, round: &str) -> bool {
        self.result.snapshot.attempts.iter().any(|attempt| attempt.worker.0 == worker
            && matches!(&attempt.cause, Cause::AssignmentRound { round: actual, .. } if actual.0 == round)
            && matches!(attempt.status, AttemptStatus::Pending | AttemptStatus::Running))
    }
}

#[test]
fn one_dispatch_opens_both_recipient_rounds_and_replay_opens_none() {
    let mut run = Run::seeded();
    let event = run.dispatch(&[
        ("round-a", "item-a", "builder_a"),
        ("round-b", "item-b", "builder_b"),
    ]);
    run.apply(event.clone());
    assert!(run.owes("builder_a", "round-a") && run.owes("builder_b", "round-b"));
    let before = run.result.snapshot.attempts.len();
    run.apply(event);
    assert_eq!(run.result.snapshot.attempts.len(), before);
}

#[test]
fn one_update_wants_reassessment_while_the_other_builder_owes_an_update() {
    let mut run = Run::seeded();
    run.apply(run.dispatch(&[
        ("round-a", "item-a", "builder_a"),
        ("round-b", "item-b", "builder_b"),
    ]));
    run.publish("builder_b", "part_b", json!("updated b"), None);
    run.end("builder_b");
    assert!(run.owes("builder_a", "round-a"));
    assert!(run.result.wanted.iter().any(|wanted| wanted.worker.0 == "builder_a"
        && matches!(&wanted.action, Action::RunWorker { cause: Cause::AssignmentRound { round, .. }, .. } if round.0 == "round-a")));
    assert!(run
        .result
        .snapshot
        .attempts
        .iter()
        .any(|attempt| attempt.worker.0 == "assessor"
            && matches!(&attempt.cause, Cause::Reassessment { round } if round.0 == "round-b")));
    run.assess();
    run.publish("builder_a", "part_a", json!("updated a"), None);
    run.end("builder_a");
    run.assess();
    assert!(run.result.wanted.is_empty());
    assert!(run
        .result
        .reviews
        .iter()
        .any(|review| review.review.0 == "assessment_review"));
}

#[test]
fn late_first_round_publication_cannot_close_second_round() {
    let mut run = Run::seeded();
    run.apply(run.dispatch(&[("round-1", "item", "builder_b")]));
    let first = run.action("builder_b");
    run.publish("builder_b", "part_b", json!("first"), None);
    run.end("builder_b");
    run.assess();
    run.apply(run.dispatch(&[("round-2", "item", "builder_b")]));
    run.publish_with(first, "part_b", json!("late first"), None);
    assert!(run.owes("builder_b", "round-2"));
}

#[test]
fn dispatch_refuses_a_worker_outside_the_stage() {
    let run = Run::seeded();
    let event = run.dispatch(&[("round", "item", "other_stage_worker")]);
    let error = step(&run.program, &run.result.snapshot, &run.event(event)).unwrap_err();
    assert!(format!("{error:?}")
        .contains("recipient other_stage_worker is not an agent worker of stage work"));
}

#[test]
fn dispatch_on_the_assessment_does_not_count_as_approval() {
    let mut source = workflow();
    source["stages"]["work"]["reviews"]["assessment_review"]["decisions"]["send"]["on"] =
        json!("assessment");
    let mut run = Run::seeded_with(source);
    let mut event = run.dispatch(&[("round-a", "item-a", "builder_a")]);
    if let Event::OperatorDecided { target, .. } = &mut event {
        *target = run.latest("assessment").unwrap();
    }
    run.apply(event);
    assert!(run.owes("builder_a", "round-a"));
    assert!(run
        .result
        .snapshot
        .units
        .iter()
        .any(|unit| unit.id.0 == UNIT && unit.status == UnitStatus::Active));
}

#[test]
fn retry_creates_a_new_attempt_for_the_same_round() {
    let mut run = Run::seeded();
    run.apply(run.dispatch(&[("round", "item", "builder_b")]));
    let original = run.action("builder_b");
    run.apply(Event::WorkerEnded {
        action: original.clone(),
        result: WorkerResult::Failed {
            code: "unavailable".into(),
            detail: "retry".into(),
        },
    });
    let retry = Incoming {
        event: Event::RetryRequested {
            unit: UnitId::from(UNIT),
            worker: WorkerKey::from("builder_b"),
        },
        writer: Writer::Engine,
        ingress_id: Some("retry-request".into()),
    };
    run.result = step(&run.program, &run.result.snapshot, &retry).unwrap();
    assert!(run.owes("builder_b", "round"));
    assert_ne!(run.action("builder_b"), original);
}
