use super::*;
use crate::expressions::{infer, parse_expression, parse_repository, proven_artifacts, Scope};

fn expression(
    text: &str,
    path: String,
    scope: &Scope<'_>,
    errors: &mut Vec<CompileError>,
) -> Option<Type> {
    let parsed = parse_expression(text).ok()?;
    match infer(&parsed, scope) {
        Ok(ty) => Some(ty),
        Err(mut error) => {
            error.path = path.clone().into();
            errors.push(CompileError::from_domain(
                error,
                path,
                SourceSpan {
                    start: 0,
                    end: text.len(),
                },
            ));
            None
        }
    }
}

fn expressions(key: &str, stage: &Stage, source: &Workflow) -> Vec<CompileError> {
    let mut errors = Vec::new();
    let base_path = format!("stages.{key}");
    let empty = BTreeMap::new();
    let base = Scope {
        input: &stage.input,
        artifacts: &stage.artifacts,
        outcomes: &empty,
        each: None,
        item: None,
        aliases: &source.schemas,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: BTreeSet::new(),
    };
    for (worker_key, worker) in &stage.workers {
        let path = format!("{base_path}.workers.{worker_key}");
        let (inputs, when) = match worker {
            Worker::Agent { inputs, when, .. } | Worker::Code { inputs, when, .. } => {
                (inputs, when)
            }
        };
        let mut scope = base.clone();
        if let Some(text) = when {
            let when_path = format!("{path}.when");
            if let Some(ty) = expression(text, when_path.clone(), &base, &mut errors) {
                if ty != Type::Boolean {
                    errors.push(CompileError::new(
                        CheckKind::ExpressionType,
                        when_path,
                        SourceSpan {
                            start: 0,
                            end: text.len(),
                        },
                        format!("worker {worker_key} when is not boolean"),
                    ));
                } else if let Ok(parsed) = parse_expression(text) {
                    scope.guaranteed = proven_artifacts(&parsed);
                }
            }
        }
        for (field, text) in inputs {
            expression(text, format!("{path}.inputs.{field}"), &scope, &mut errors);
        }
        if let Worker::Agent {
            workspace: Some(text),
            ..
        } = worker
        {
            if text != "none" {
                if let Ok(inner) = parse_repository(text) {
                    expression(inner, format!("{path}.workspace"), &scope, &mut errors);
                }
            }
        }
    }
    for (artifact_key, artifact) in &stage.artifacts {
        let scope = Scope {
            body: Some((artifact_key, &artifact.schema)),
            ..base.clone()
        };
        for (index, rule) in artifact.validate.iter().enumerate() {
            let path = format!("{base_path}.artifacts.{artifact_key}.validate.{index}.check");
            if let Some(ty) = expression(&rule.check, path.clone(), &scope, &mut errors) {
                if ty != Type::Boolean {
                    errors.push(CompileError::new(
                        CheckKind::Review,
                        path,
                        SourceSpan {
                            start: 0,
                            end: rule.check.len(),
                        },
                        "validation check must be boolean",
                    ));
                }
            }
        }
    }
    for (review_key, review) in &stage.reviews {
        let path = format!("{base_path}.reviews.{review_key}");
        if let Some(text) = &review.when {
            let when_path = format!("{path}.when");
            if let Some(ty) = expression(text, when_path.clone(), &base, &mut errors) {
                if ty != Type::Boolean {
                    errors.push(CompileError::new(
                        CheckKind::ExpressionType,
                        when_path,
                        SourceSpan {
                            start: 0,
                            end: text.len(),
                        },
                        format!("review {review_key} when is not boolean"),
                    ));
                }
            }
        }
        for (field, text) in &review.inputs {
            let before = errors.len();
            expression(text, format!("{path}.inputs.{field}"), &base, &mut errors);
            for error in &mut errors[before..] {
                error.check = CheckKind::Review;
            }
        }
    }
    if let Some(text) = &stage.done_when {
        let path = format!("{base_path}.done_when");
        if let Some(ty) = expression(text, path.clone(), &base, &mut errors) {
            if ty != Type::Boolean {
                errors.push(CompileError::new(
                    CheckKind::ExpressionType,
                    path,
                    SourceSpan {
                        start: 0,
                        end: text.len(),
                    },
                    format!("stage {key} done_when is not boolean"),
                ));
            }
        }
        let mut outcome_scope = base.clone();
        if let Ok(parsed) = parse_expression(text) {
            outcome_scope.guaranteed = proven_artifacts(&parsed);
        }
        for (field, text) in &stage.outcome {
            expression(
                text,
                format!("{base_path}.outcome.{field}"),
                &outcome_scope,
                &mut errors,
            );
        }
    }
    errors
}

pub(super) fn stage(
    key: &str,
    stage: &Stage,
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Vec<CompileError> {
    let mut errors = Vec::new();
    let base = format!("stages.{key}");
    let mut owners = BTreeSet::new();
    for (worker_key, worker) in &stage.workers {
        let path = format!("{base}.workers.{worker_key}");
        let creates = match worker {
            Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates,
        };
        if creates.is_empty() {
            errors.push(CompileError::new(
                CheckKind::Worker,
                format!("{path}.creates"),
                SourceSpan::default(),
                format!("worker {worker_key} creates nothing"),
            ));
        }
        for artifact in creates {
            if !stage.artifacts.contains_key(&artifact.0) {
                errors.push(CompileError::new(
                    CheckKind::Name,
                    format!("{path}.creates"),
                    SourceSpan::default(),
                    format!("artifact {artifact} absent"),
                ));
            }
            if !owners.insert(&artifact.0) {
                errors.push(CompileError::new(
                    CheckKind::Worker,
                    format!("{path}.creates"),
                    SourceSpan::default(),
                    format!("artifact {artifact} has multiple creators"),
                ));
            }
        }
        match worker {
            Worker::Agent {
                prompts: modes,
                reviews,
                session,
                ..
            } => {
                if reviews.is_some() && !modes.contains_key("review") {
                    errors.push(CompileError::new(
                        CheckKind::Worker,
                        format!("{path}.prompts"),
                        SourceSpan::default(),
                        format!("reviewer {worker_key} lacks review prompt"),
                    ));
                }
                if reviews.is_none() && !modes.contains_key("initial") {
                    errors.push(CompileError::new(
                        CheckKind::Worker,
                        format!("{path}.prompts"),
                        SourceSpan::default(),
                        format!("agent {worker_key} lacks initial prompt"),
                    ));
                }
                if modes.contains_key("handoff") && !matches!(session, Some(SessionMode::Fresh)) {
                    errors.push(CompileError::new(
                        CheckKind::Worker,
                        format!("{path}.prompts.handoff"),
                        SourceSpan::default(),
                        format!(
                            "agent {worker_key} has a handoff prompt but its session is not fresh"
                        ),
                    ));
                }
                for (mode, file) in modes {
                    if !prompts.contains_key(file) {
                        errors.push(CompileError::new(
                            CheckKind::Prompt,
                            format!("{path}.prompts.{mode}"),
                            SourceSpan::default(),
                            format!("prompt file {file} missing"),
                        ));
                    }
                }
            }
            Worker::Code {
                operation, every, ..
            } => {
                if creates.len() != 1 {
                    errors.push(CompileError::new(
                        CheckKind::Operation,
                        format!("{path}.creates"),
                        SourceSpan::default(),
                        format!("code worker {worker_key} must create one artifact"),
                    ));
                }
                if !operations
                    .iter()
                    .any(|candidate| candidate.key == *operation)
                {
                    errors.push(CompileError::new(
                        CheckKind::Operation,
                        format!("{path}.operation"),
                        SourceSpan::default(),
                        format!("operation {operation} absent"),
                    ));
                }
                if let Some(interval) = every {
                    let count = interval.strip_suffix(['s', 'm', 'h']);
                    if count.is_none_or(|count| {
                        count.is_empty()
                            || count.starts_with('0')
                            || !count.bytes().all(|byte| byte.is_ascii_digit())
                    }) {
                        errors.push(CompileError::new(
                            CheckKind::Operation,
                            format!("{path}.every"),
                            SourceSpan::default(),
                            format!("code worker {worker_key} every {interval} is not a duration"),
                        ));
                    }
                }
            }
        }
    }
    for artifact in stage.artifacts.keys() {
        if !owners.contains(artifact) {
            errors.push(CompileError::new(
                CheckKind::Worker,
                format!("{base}.artifacts.{artifact}"),
                SourceSpan::default(),
                format!("artifact {artifact} has no creator"),
            ));
        }
    }
    for (review_key, review) in &stage.reviews {
        let path = format!("{base}.reviews.{review_key}");
        if !stage.artifacts.contains_key(&review.of.0) {
            errors.push(CompileError::new(
                CheckKind::Review,
                format!("{path}.of"),
                SourceSpan::default(),
                format!("review {review_key} artifact absent"),
            ));
        }
        if review.by == ReviewBy::Operator {
            if review
                .prompt
                .as_deref()
                .is_none_or(|prompt| prompt.trim().is_empty())
            {
                errors.push(CompileError::new(
                    CheckKind::Worker,
                    format!("{path}.prompt"),
                    SourceSpan::default(),
                    format!("review {review_key} lacks prompt"),
                ));
            } else if let Some(prompt) = &review.prompt {
                if !prompts.contains_key(prompt) {
                    errors.push(CompileError::new(
                        CheckKind::Prompt,
                        format!("{path}.prompt"),
                        SourceSpan::default(),
                        format!("prompt file {prompt} missing"),
                    ));
                }
            }
        }
    }
    if stage.done_when.is_none() {
        errors.push(CompileError::new(
            CheckKind::ExpressionType,
            format!("{base}.done_when"),
            SourceSpan::default(),
            format!("stage {key} lacks done_when"),
        ));
    }
    errors.extend(expressions(key, stage, source));
    errors
}
