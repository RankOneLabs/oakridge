//! Stable execution fingerprint serialization. Field order and execution names
//! mirror the compiler's source serialization at 1c7d8017; presentation kinds
//! never participate. This is a write-only view, not a source decoder.
//! Exhaustive source destructuring requires an explicit fingerprint decision
//! whenever fields are added to the source model.
use super::*;
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct WorkflowFingerprint<'a> {
    workflow: &'a SymbolKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: &'a Option<WorkflowLabel>,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    equivalent_subject_fields: &'a Vec<String>,
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
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        keyed_execution: bool,
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
                keyed_execution,
                runtime,
                workspace,
                session,
                when,
                label: _,
            } => Self::Agent {
                prompts,
                inputs,
                creates: produces,
                reviews: evaluates,
                keyed_execution: *keyed_execution,
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
                ..
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
impl<'a> From<&'a Artifact> for ArtifactFingerprint<'a> {
    fn from(artifact: &'a Artifact) -> Self {
        let Artifact {
            kind: _, // Presentation metadata is deliberately absent from the fingerprint.
            view: _,
            link_field: _,
            schema,
            edit_policy,
            validate,
            equivalent_subject_fields,
        } = artifact;
        Self {
            schema,
            edit_policy,
            validate,
            equivalent_subject_fields,
        }
    }
}
impl<'a> From<&'a Stage> for StageFingerprint<'a> {
    fn from(stage: &'a Stage) -> Self {
        let Stage {
            input,
            let_bindings,
            artifacts,
            workers,
            reviews,
            done_when,
            outcome,
        } = stage;
        let mut reviews = reviews.clone();
        for review in reviews.values_mut() {
            for decision in review.decisions.values_mut() {
                decision.on = normalized_decision_target(decision.on.as_ref(), &review.of);
            }
        }
        Self {
            input,
            let_bindings,
            artifacts: artifacts
                .iter()
                .map(|(name, artifact)| (name.as_str(), ArtifactFingerprint::from(artifact)))
                .collect(),
            workers: workers
                .iter()
                .map(|(name, worker)| (name.as_str(), WorkerFingerprint::from(worker)))
                .collect(),
            reviews,
            done_when,
            outcome,
        }
    }
}
impl<'a> From<&'a Workflow> for WorkflowFingerprint<'a> {
    fn from(source: &'a Workflow) -> Self {
        let Workflow {
            workflow,
            label,
            input,
            schemas,
            run,
            stages,
        } = source;
        Self {
            workflow,
            label,
            input,
            schemas,
            run,
            stages: stages
                .iter()
                .map(|(key, stage)| (key.as_str(), StageFingerprint::from(stage)))
                .collect(),
        }
    }
}
