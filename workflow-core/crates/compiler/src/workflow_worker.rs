use super::*;

pub(super) struct StageCheck<'a> {
    pub stage: &'a Stage,
    pub workflow: &'a Workflow,
    pub operations: &'a [CodeOperation],
    pub prompts: &'a BTreeMap<String, String>,
    pub base: Scope<'a>,
    pub path: String,
    pub owners: BTreeMap<String, String>,
    pub errors: Vec<CompileError>,
}

impl StageCheck<'_> {
    pub fn error(&mut self, check: CheckKind, path: &str, detail: impl Into<String>) {
        self.errors.push(CompileError::new(
            check,
            path,
            workflow_span(self.workflow, path),
            detail,
        ));
    }

    pub fn capture<T>(&mut self, result: Result<T, CompileError>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                self.errors.push(error);
                None
            }
        }
    }

    pub fn fields(
        &mut self,
        values: &BTreeMap<String, String>,
        scope: &Scope<'_>,
        path: &str,
    ) -> Option<Vec<CheckedNamedExpression>> {
        let mut result = Vec::new();
        let mut is_complete = true;
        for (key, source) in values {
            match self.capture(checked(source, scope, &format!("{path}.{key}"))) {
                Some(value) => result.push(CheckedNamedExpression {
                    key: key.clone(),
                    value,
                }),
                None => is_complete = false,
            }
        }
        is_complete.then_some(result)
    }

    pub fn worker(&mut self, key: &str, worker: &Worker) -> Option<CheckedWorker> {
        let path = format!("{}.workers.{key}", self.path);
        let (creates, guard) = match worker {
            Worker::Agent { creates, when, .. } | Worker::Code { creates, when, .. } => {
                (creates, when.as_deref())
            }
        };
        let before = self.errors.len();
        if creates.is_empty() {
            self.error(
                CheckKind::Worker,
                &format!("{path}.creates"),
                format!("worker {key} creates nothing"),
            );
        }
        for artifact in creates {
            if !self.stage.artifacts.contains_key(&artifact.0) {
                self.error(
                    CheckKind::Name,
                    &format!("{path}.creates"),
                    format!("artifact {artifact} absent"),
                );
            }
            if self
                .owners
                .insert(artifact.0.clone(), key.to_owned())
                .is_some()
            {
                self.error(
                    CheckKind::Worker,
                    &format!("{path}.creates"),
                    format!("artifact {artifact} has multiple creators"),
                );
            }
        }
        let when = guard.and_then(|text| {
            self.capture(checked_guard(
                text,
                &self.base,
                &format!("{path}.when"),
                CheckKind::ExpressionType,
                &format!("worker {key} when"),
            ))
        });
        let scope = Scope {
            guaranteed: when
                .as_ref()
                .map(|(_, proven)| proven.clone())
                .unwrap_or_default(),
            ..self.base.clone()
        };
        match worker {
            Worker::Agent {
                prompts: modes,
                inputs,
                reviews,
                workspace,
                session,
                ..
            } => {
                let input_fields = self.fields(inputs, &scope, &format!("{path}.inputs"));
                let workspace = self.capture(workspace_expression(
                    workspace.as_deref(),
                    &scope,
                    &format!("{path}.workspace"),
                ));
                if reviews.is_some() && !modes.contains_key("review") {
                    self.error(
                        CheckKind::Worker,
                        &format!("{path}.prompts"),
                        format!("reviewer {key} lacks review prompt"),
                    );
                }
                if reviews.is_none() && !modes.contains_key("initial") {
                    self.error(
                        CheckKind::Worker,
                        &format!("{path}.prompts"),
                        format!("agent {key} lacks initial prompt"),
                    );
                }
                if let Some(of) = reviews {
                    if !self.stage.artifacts.contains_key(&of.0) {
                        self.error(
                            CheckKind::Review,
                            &format!("{path}.reviews"),
                            format!("reviewed artifact {of} absent"),
                        );
                    }
                }
                let needs_revise = creates.iter().any(|artifact| {
                    self.stage
                        .artifacts
                        .get(&artifact.0)
                        .is_some_and(|value| !value.validate.is_empty())
                        || self.stage.reviews.values().any(|review| {
                            review.decisions.values().any(|decision| {
                                decision.on.as_ref().unwrap_or(&review.of) == artifact
                                    && decision.effect == DeclaredDecisionEffect::RequestChanges
                            })
                        })
                });
                if needs_revise && !modes.contains_key("revise") {
                    self.error(
                        CheckKind::Worker,
                        &format!("{path}.prompts"),
                        format!("agent {key} lacks revise prompt"),
                    );
                }
                if modes.contains_key(HANDOFF_PROMPT)
                    && !matches!(session, Some(SessionMode::Fresh))
                {
                    self.error(
                        CheckKind::Worker,
                        &format!("{path}.prompts.handoff"),
                        format!("agent {key} has a handoff prompt but its session is not fresh"),
                    );
                }
                for (mode, file) in modes.iter() {
                    let engine_inputs = if mode == HANDOFF_PROMPT {
                        HANDOFF_ENGINE_INPUTS
                    } else {
                        MODE_ENGINE_INPUTS
                    };
                    self.capture(prompt(
                        file,
                        inputs,
                        self.prompts,
                        engine_inputs,
                        &format!("{path}.prompts.{mode}"),
                    ));
                }
                if self.errors.len() != before {
                    return None;
                }
                Some(CheckedWorker::Agent {
                    key: WorkerKey::from(key),
                    inputs: input_fields.expect("valid worker inputs"),
                    creates: creates.clone(),
                    reviews: reviews.clone(),
                    workspace: workspace.expect("valid workspace"),
                    when: when.map(|(expression, _)| expression),
                })
            }
            Worker::Code {
                operation,
                inputs,
                every,
                ..
            } => {
                let contract = self
                    .operations
                    .iter()
                    .find(|candidate| candidate.key == *operation);
                if contract.is_none() {
                    self.error(
                        CheckKind::Operation,
                        &format!("{path}.operation"),
                        format!("operation {operation} absent"),
                    );
                }
                if let Some(interval) = every {
                    if !is_duration(interval) {
                        self.error(
                            CheckKind::Operation,
                            &format!("{path}.every"),
                            format!("code worker {key} every {interval} is not a duration"),
                        );
                    }
                }
                if creates.len() != 1 {
                    self.error(
                        CheckKind::Operation,
                        &format!("{path}.creates"),
                        format!("code worker {key} must create one artifact"),
                    );
                }
                let input_fields = self.fields(inputs, &scope, &format!("{path}.inputs"));
                if let (Some(contract), Some(input_fields)) = (contract, input_fields.as_ref()) {
                    let mut bindings = BTreeMap::new();
                    if !unify(
                        &contract.input_schema,
                        &checked_record(input_fields),
                        &self.workflow.schemas,
                        &mut bindings,
                    ) {
                        self.error(
                            CheckKind::Operation,
                            &format!("{path}.inputs"),
                            format!("operation {operation} input mismatch"),
                        );
                    }
                    if creates.len() == 1 {
                        if let Some(artifact) = self.stage.artifacts.get(&creates[0].0) {
                            if !unify(
                                &contract.output_schema,
                                &artifact.schema,
                                &self.workflow.schemas,
                                &mut bindings,
                            ) {
                                self.error(
                                    CheckKind::Operation,
                                    &format!("{path}.operation"),
                                    format!("operation {operation} output mismatch"),
                                );
                            }
                        }
                    }
                }
                if self.errors.len() != before {
                    return None;
                }
                Some(CheckedWorker::Code {
                    key: WorkerKey::from(key),
                    inputs: input_fields.expect("valid worker inputs"),
                    creates: creates.clone(),
                    every: every.clone(),
                    when: when.map(|(expression, _)| expression),
                })
            }
        }
    }
}
