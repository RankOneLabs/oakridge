//! The section 2.1-2.3 workflow compiler: source validation, stage scope
//! type-checking, and group and collection resolution.
use crate::expressions::{checked, checked_guard, parse_repository, Scope};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;

pub(crate) fn source_span(text: &str) -> SourceSpan {
    SourceSpan {
        start: 0,
        end: text.len(),
    }
}
/// Span the source value selected by a diagnostic path. A missing value has an
/// insertion point at byte zero; existing values span their encoded source.
pub(crate) fn workflow_span(source: &Workflow, path: &str) -> SourceSpan {
    serde_json::to_value(source)
        .map(|value| json_value_span(&value, path))
        .unwrap_or_default()
}
fn json_value_span(root: &serde_json::Value, path: &str) -> SourceSpan {
    let mut value = root;
    for segment in path.split('.') {
        value = match value {
            serde_json::Value::Object(fields) => fields.get(segment),
            serde_json::Value::Array(items) => segment
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index)),
            _ => None,
        }
        .unwrap_or(&serde_json::Value::Null);
    }
    match value {
        serde_json::Value::Null => SourceSpan::default(),
        serde_json::Value::String(text) => source_span(text),
        other => source_span(&other.to_string()),
    }
}
pub(crate) fn resolve_type(ty: &Type, aliases: &BTreeMap<String, Type>) -> Type {
    fn visit(ty: &Type, aliases: &BTreeMap<String, Type>, visiting: &mut BTreeSet<String>) -> Type {
        match ty {
            Type::Named { schema } if aliases.contains_key(&schema.0) => {
                if !visiting.insert(schema.0.clone()) {
                    return ty.clone();
                }
                let result = visit(&aliases[&schema.0], aliases, visiting);
                visiting.remove(&schema.0);
                result
            }
            Type::Record { fields } => Type::Record {
                fields: fields
                    .iter()
                    .map(|(key, value)| (key.clone(), visit(value, aliases, visiting)))
                    .collect(),
            },
            Type::List { item } => Type::List {
                item: Box::new(visit(item, aliases, visiting)),
            },
            Type::Optional { value } => Type::Optional {
                value: Box::new(visit(value, aliases, visiting)),
            },
            _ => ty.clone(),
        }
    }
    visit(ty, aliases, &mut BTreeSet::new())
}
fn checked_type(
    ty: &Type,
    aliases: &BTreeMap<String, Type>,
    path: &str,
) -> Result<CheckedType, CompileError> {
    let resolved = resolve_type(ty, aliases);
    fn has_unresolved(ty: &Type) -> bool {
        match ty {
            Type::Named { .. } | Type::OutcomeOf { .. } => true,
            Type::Optional { value } => has_unresolved(value),
            Type::List { item } => has_unresolved(item),
            Type::Record { fields } => fields.values().any(has_unresolved),
            _ => false,
        }
    }
    if has_unresolved(&resolved) {
        return Err(CompileError::new(
            CheckKind::Schema,
            path,
            source_span(&ty.to_string()),
            format!("unresolved type {resolved}"),
        ));
    }
    Ok(resolved)
}
pub(crate) fn item_type(ty: &Type) -> Option<Type> {
    match ty {
        Type::List { item } => Some((**item).clone()),
        _ => None,
    }
}
pub(crate) fn field_type(
    ty: &Type,
    path: &[&str],
    aliases: &BTreeMap<String, Type>,
) -> Option<Type> {
    let mut current = resolve_type(ty, aliases);
    for part in path {
        current = match current {
            Type::Record { fields } => fields.get(*part)?.clone(),
            _ => return None,
        };
    }
    Some(current)
}
fn fields(
    values: &BTreeMap<String, String>,
    scope: &Scope<'_>,
    path: &str,
) -> Result<Vec<CheckedNamedExpression>, Vec<CompileError>> {
    let mut checked_fields = Vec::new();
    let mut errors = Vec::new();
    for (key, source) in values {
        match checked(source, scope, &format!("{path}.{key}")) {
            Ok(value) => checked_fields.push(CheckedNamedExpression {
                key: key.clone(),
                value,
            }),
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(checked_fields)
    } else {
        Err(errors)
    }
}
/// `none` (or no workspace) gives the session no worktree; `repository(<expr>)`
/// names the repository its worktree is cut from, read from the stage input.
fn workspace_expression(
    source: Option<&str>,
    scope: &Scope<'_>,
    path: &str,
) -> Result<Option<CheckedStageExpression>, CompileError> {
    let Some(text) = source else {
        return Ok(None);
    };
    if text.trim() == "none" {
        return Ok(None);
    }
    match parse_repository(text, path) {
        Ok(inner) => {
            let offset = inner.as_ptr() as usize - text.as_ptr() as usize;
            checked(inner, scope, path).map(Some).map_err(|mut error| {
                error.span.start += offset;
                error.span.end += offset;
                error
            })
        }
        Err(_) => Err(CompileError::new(
            CheckKind::Workspace,
            path,
            source_span(text),
            format!("workspace {text} must be none or repository(<expr>)"),
        )),
    }
}
fn checked_record(fields: &[CheckedNamedExpression]) -> TypeExpression {
    Type::Record {
        fields: fields
            .iter()
            .map(|field| (field.key.clone(), field.value.value_type.clone()))
            .collect(),
    }
}
/// A periodic code worker's interval: a positive whole number of seconds, minutes or hours (`30s`, `5m`, `1h`).
fn is_duration(text: &str) -> bool {
    let Some(count) = text.strip_suffix(['s', 'm', 'h']) else {
        return false;
    };
    !count.is_empty() && !count.starts_with('0') && count.bytes().all(|byte| byte.is_ascii_digit())
}
/// The engine inputs a mode prompt may read beside the declared inputs.
const MODE_ENGINE_INPUTS: &[&str] = &["previous", "feedback", "subject"];
/// The prompt key whose template words the handoff a `session: fresh` attempt
/// starts with, and the engine-built fields it may read beside the declared inputs.
const HANDOFF_PROMPT: &str = "handoff";
const HANDOFF_ENGINE_INPUTS: &[&str] = &["artifacts", "feedback", "previous_attempt"];
fn prompt(
    file: &str,
    inputs: &BTreeMap<String, String>,
    prompts: &BTreeMap<String, String>,
    engine_inputs: &[&str],
    path: &str,
) -> Result<(), CompileError> {
    if file.trim().is_empty() {
        return Err(CompileError::new(
            CheckKind::Worker,
            path,
            source_span(file),
            "review or agent prompt missing",
        ));
    }
    let body = prompts.get(file).ok_or_else(|| {
        CompileError::new(
            CheckKind::Prompt,
            path,
            source_span(file),
            format!("prompt file {file} missing"),
        )
    })?;
    for part in body.split("{{").skip(1) {
        let key = part.split("}}").next().unwrap_or("").trim();
        if !inputs.contains_key(key) && !engine_inputs.contains(&key) {
            return Err(CompileError::new(
                CheckKind::Prompt,
                path,
                source_span(file),
                format!("prompt {file} names undeclared input {key}"),
            ));
        }
    }
    Ok(())
}
/// An operator review is rendered for a person: it needs a prompt, and its
/// decisions take their feedback from the form, not from config.
fn check_operator_review(
    key: &str,
    review: &Review,
    prompts: &BTreeMap<String, String>,
    path: &str,
) -> Result<(), CompileError> {
    let prompt_path = format!("{path}.prompt");
    let review_prompt = review.prompt.as_deref().ok_or_else(|| {
        CompileError::new(
            CheckKind::Worker,
            &prompt_path,
            SourceSpan::default(),
            format!("review {key} lacks prompt"),
        )
    })?;
    if review_prompt.trim().is_empty() {
        return Err(CompileError::new(
            CheckKind::Worker,
            &prompt_path,
            source_span(review_prompt),
            format!("review {key} lacks prompt"),
        ));
    }
    prompt(
        review_prompt,
        &review.inputs,
        prompts,
        MODE_ENGINE_INPUTS,
        &prompt_path,
    )?;
    if let Some((decision_key, decision)) = review
        .decisions
        .iter()
        .find(|(_, decision)| decision.feedback.is_some())
    {
        return Err(CompileError::new(
            CheckKind::Review,
            format!("{path}.decisions.{decision_key}.feedback"),
            source_span(decision.feedback.as_deref().unwrap_or("")),
            format!("operator review {key} sets fixed feedback"),
        ));
    }
    Ok(())
}
/// An engine review decides by itself: a `when`, and exactly one
/// request_changes decision carrying fixed, non-empty feedback.
fn check_engine_review(
    key: &str,
    review: &Review,
    has_when: bool,
    path: &str,
) -> Result<(), CompileError> {
    if !has_when {
        return Err(CompileError::new(
            CheckKind::Review,
            format!("{path}.when"),
            SourceSpan::default(),
            format!("engine review {key} lacks when"),
        ));
    }
    if review.prompt.is_some() || !review.inputs.is_empty() {
        let (field, span) = match review.prompt.as_deref() {
            Some(prompt) => ("prompt", source_span(prompt)),
            None => (
                "inputs",
                source_span(&serde_json::to_string(&review.inputs).unwrap_or_default()),
            ),
        };
        return Err(CompileError::new(
            CheckKind::Review,
            format!("{path}.{field}"),
            span,
            format!("engine review {key} has a prompt or inputs"),
        ));
    }
    let [(decision_key, decision)] = review.decisions.iter().collect::<Vec<_>>()[..] else {
        return Err(CompileError::new(
            CheckKind::Review,
            format!("{path}.decisions"),
            source_span(&serde_json::to_string(&review.decisions).unwrap_or_default()),
            format!("engine review {key} needs exactly one decision"),
        ));
    };
    let has_feedback = decision
        .feedback
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty());
    if decision.effect != DecisionEffect::RequestChanges
        || !has_feedback
        || decision.payload.is_some()
        || !decision.fields.is_empty()
    {
        return Err(CompileError::new(
            CheckKind::Review,
            format!("{path}.decisions.{decision_key}"),
            source_span(&serde_json::to_string(decision).unwrap_or_default()),
            format!("engine review {key} decides request_changes with fixed feedback only"),
        ));
    }
    Ok(())
}
/// The name an operation schema uses for a type the workflow chooses: a
/// generic operation's input and output (`value.publish`) share it.
const TYPE_VARIABLE: &str = "$value";
/// Match an operation contract against a workflow type, binding the type
/// variable to the first type it meets and requiring every later use to agree.
fn unify(
    contract: &TypeExpression,
    actual: &TypeExpression,
    aliases: &BTreeMap<String, TypeExpression>,
    bindings: &mut BTreeMap<String, TypeExpression>,
) -> bool {
    if let Type::Named { schema } = contract {
        if schema.0 == TYPE_VARIABLE {
            let actual = resolve_type(actual, aliases);
            return match bindings.get(&schema.0) {
                Some(bound) => *bound == actual,
                None => {
                    bindings.insert(schema.0.clone(), actual);
                    true
                }
            };
        }
    }
    match (
        resolve_type(contract, aliases),
        resolve_type(actual, aliases),
    ) {
        (Type::Record { fields: expected }, Type::Record { fields: found }) => {
            expected.len() == found.len()
                && expected.iter().all(|(key, ty)| {
                    found
                        .get(key)
                        .is_some_and(|other| unify(ty, other, aliases, bindings))
                })
        }
        // A type variable may sit inside a constructor: `list($value)`.
        (Type::List { item: expected }, Type::List { item: found }) => {
            unify(&expected, &found, aliases, bindings)
        }
        (Type::Optional { value: expected }, Type::Optional { value: found }) => {
            unify(&expected, &found, aliases, bindings)
        }
        (expected, found) => expected == found,
    }
}
#[path = "workflow_group.rs"]
mod group;
#[path = "workflow_stage.rs"]
mod stage;
#[path = "workflow_worker.rs"]
mod worker;
use group::compile_group;
use stage::compile_stage;
#[path = "workflow_passes.rs"]
mod passes;
pub use passes::{CheckKind, CompileError};

pub fn compile_workflow_detailed(
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Result<CheckedWorkflow, Vec<CompileError>> {
    compile_workflow_with_limits_detailed(source, operations, prompts, &ResourceLimits::default())
}
pub fn compile_workflow_with_limits_detailed(
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
    limits: &ResourceLimits,
) -> Result<CheckedWorkflow, Vec<CompileError>> {
    compile_workflow_with_limits_and_resolved_detailed(source, operations, prompts, limits)
        .map(|(program, _)| program)
}
pub fn compile_workflow_with_limits_and_resolved_detailed(
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
    limits: &ResourceLimits,
) -> Result<(CheckedWorkflow, Workflow), Vec<CompileError>> {
    let parsed = passes::parse(source)?;
    let resolved = passes::resolve(parsed)?;
    let checked = passes::check(resolved, operations, prompts, limits)?;
    passes::lower(checked)
}
pub fn compile_workflow(
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Result<CheckedWorkflow, DomainError> {
    compile_workflow_with_limits(source, operations, prompts, &ResourceLimits::default())
}
pub fn compile_workflow_with_limits(
    source: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
    limits: &ResourceLimits,
) -> Result<CheckedWorkflow, DomainError> {
    compile_workflow_with_limits_detailed(source, operations, prompts, limits).map_err(|errors| {
        let mut domain = errors[0].as_domain_error();
        if errors.len() > 1 {
            domain.detail = errors
                .iter()
                .map(|error| format!("{}: {}", error.path, error.detail))
                .collect::<Vec<_>>()
                .join("; ")
                .into();
        }
        if domain.detail.as_ref() == "max_depth exceeded"
            || domain.detail.as_ref() == "max_list_items exceeded"
        {
            domain.kind = DomainErrorKind::ResourceLimit;
        }
        domain
    })
}
#[path = "workflow_decode.rs"]
mod decode;
pub use decode::{decode_workflow, decode_workflow_value_detailed};

#[cfg(test)]
mod review_regressions {
    use super::*;

    #[test]
    fn malformed_record_fields_are_rejected() {
        for text in [
            "{ key text }",
            "{ key: text, bad }",
            "{ key: text, key: integer }",
        ] {
            assert!(Type::parse(text).is_err());
        }
    }

    #[test]
    fn list_item_types_render_as_source_syntax() {
        let item = Type::Record {
            fields: BTreeMap::from([("key".into(), Type::Text)]),
        };
        assert_eq!(format!("list({item})"), "list({key: text})");
        assert_eq!(format!("list({})", Type::Text), "list(text)");
    }
}
