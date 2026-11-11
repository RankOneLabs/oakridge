//! Stable execution fingerprint serialization. Field order and execution names
//! mirror the compiler's source serialization at 1c7d8017; presentation kinds
//! never participate. This is a write-only view, not a source decoder.
use super::*;
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct WorkflowFingerprint<'a> {
    workflow: &'a SymbolKey,
    input: &'a TypeExpression,
    schemas: &'a BTreeMap<String, TypeExpression>,
    run: &'a Group,
    stages: BTreeMap<&'a str, StageFingerprint<'a>>,
}
#[derive(Serialize)]
struct StageFingerprint<'a> {
    input: &'a TypeExpression,
    #[serde(rename = "let")]
    let_bindings: &'a BTreeMap<String, String>,
    artifacts: BTreeMap<&'a str, ArtifactFingerprint<'a>>,
    workers: BTreeMap<&'a str, WorkerFingerprint<'a>>,
    reviews: BTreeMap<String, Review>,
    done_when: &'a Option<String>,
    outcome: &'a BTreeMap<String, String>,
}
#[derive(Serialize)]
struct ArtifactFingerprint<'a> {
    schema: &'a TypeExpression,
    #[serde(skip_serializing_if = "EditPolicy::is_always")]
    edit_policy: &'a EditPolicy,
    validate: &'a Vec<ValidationCheck>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WorkerFingerprint<'a> {
    Agent {
        prompts: &'a Prompts,
        inputs: &'a BTreeMap<String, String>,
        creates: &'a Vec<SymbolKey>,
        reviews: &'a Option<SymbolKey>,
        runtime: &'a Option<WorkerRuntime>,
        workspace: &'a Option<String>,
        session: &'a Option<SessionMode>,
        when: &'a Option<String>,
    },
    Code {
        operation: &'a SymbolKey,
        inputs: &'a BTreeMap<String, String>,
        creates: &'a Vec<SymbolKey>,
        every: &'a Option<String>,
        when: &'a Option<String>,
    },
}
impl<'a> From<&'a Worker> for WorkerFingerprint<'a> {
    fn from(worker: &'a Worker) -> Self {
        match worker {
            Worker::Agent {
                prompts,
                inputs,
                produces,
                evaluates,
                runtime,
                workspace,
                session,
                when,
            } => Self::Agent {
                prompts,
                inputs,
                creates: produces,
                reviews: evaluates,
                runtime,
                workspace,
                session,
                when,
            },
            Worker::Code {
                operation,
                inputs,
                produces,
                every,
                when,
            } => Self::Code {
                operation,
                inputs,
                creates: produces,
                every,
                when,
            },
        }
    }
}
impl<'a> From<&'a Workflow> for WorkflowFingerprint<'a> {
    fn from(source: &'a Workflow) -> Self {
        Self {
            workflow: &source.workflow,
            input: &source.input,
            schemas: &source.schemas,
            run: &source.run,
            stages: source
                .stages
                .iter()
                .map(|(key, stage)| {
                    let mut reviews = stage.reviews.clone();
                    for review in reviews.values_mut() {
                        for decision in review.decisions.values_mut() {
                            if decision.on.as_ref() == Some(&review.of) {
                                decision.on = None;
                            }
                        }
                    }
                    (
                        key.as_str(),
                        StageFingerprint {
                            input: &stage.input,
                            let_bindings: &stage.let_bindings,
                            artifacts: stage
                                .artifacts
                                .iter()
                                .map(|(name, artifact)| {
                                    (
                                        name.as_str(),
                                        ArtifactFingerprint {
                                            schema: &artifact.schema,
                                            edit_policy: &artifact.edit_policy,
                                            validate: &artifact.validate,
                                        },
                                    )
                                })
                                .collect(),
                            workers: stage
                                .workers
                                .iter()
                                .map(|(name, worker)| {
                                    (name.as_str(), WorkerFingerprint::from(worker))
                                })
                                .collect(),
                            reviews,
                            done_when: &stage.done_when,
                            outcome: &stage.outcome,
                        },
                    )
                })
                .collect(),
        }
    }
}
