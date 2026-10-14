//! The section 2.1-2.3 workflow compiler: source validation, stage scope
//! type-checking, and group and collection resolution.
use crate::expressions::{checked, checked_guard, enum_variants, split_call, Scope};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;

pub(crate) fn reject(class: u8, detail: impl Into<String>) -> DomainError {
    DomainError::new(
        DomainErrorKind::InvalidWorkflow,
        format!("check {class}"),
        detail.into(),
    )
}
pub(crate) fn parse_type(text: &str) -> Result<TypeExpression, DomainError> {
    let text = text.trim();
    if let Some(inner) = text.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        let mut fields = BTreeMap::new();
        if !inner.trim().is_empty() {
            for field in split_top_level(inner) {
                let (key, value) = field
                    .split_once(':')
                    .ok_or_else(|| reject(11, format!("malformed record field {field}")))?;
                let key = key.trim();
                if key.is_empty() || value.trim().is_empty() {
                    return Err(reject(11, format!("malformed record field {field}")));
                }
                if fields.insert(key.to_owned(), parse_type(value)?).is_some() {
                    return Err(reject(11, format!("duplicate record field {key}")));
                }
            }
        }
        Ok(TypeExpression::Record(fields))
    } else {
        Ok(TypeExpression::Name(text.to_owned()))
    }
}
fn split_top_level(text: &str) -> impl Iterator<Item = &str> {
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut pieces = Vec::new();
    for (index, ch) in text.char_indices() {
        match ch {
            '{' | '(' => depth += 1,
            '}' | ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                pieces.push(text[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    pieces.push(text[start..].trim());
    pieces.into_iter()
}
fn inner_type<'a>(name: &'a str, function: &str) -> Option<&'a str> {
    name.strip_prefix(function)?
        .strip_prefix('(')?
        .strip_suffix(')')
}
fn validate_type(
    ty: &TypeExpression,
    aliases: &BTreeMap<String, TypeExpression>,
    visiting: &mut BTreeSet<String>,
) -> Result<(), DomainError> {
    match ty {
        TypeExpression::Record(fields) => {
            for (key, field) in fields {
                if key.is_empty() {
                    return Err(reject(11, "empty schema field key"));
                }
                validate_type(field, aliases, visiting)?;
            }
        }
        TypeExpression::Name(name)
            if ["text", "ident", "repo_path", "integer", "boolean"].contains(&name.as_str()) => {}
        TypeExpression::Name(_) if enum_variants(ty).is_some() => {
            let variants = enum_variants(ty).unwrap_or_default();
            let unique: BTreeSet<_> = variants.iter().collect();
            let is_legal = |variant: &String| {
                !variant.is_empty()
                    && variant
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            };
            if !variants.iter().all(is_legal) || unique.len() != variants.len() {
                return Err(reject(11, format!("malformed enum {}", render_type(ty))));
            }
        }
        TypeExpression::Name(name)
            if inner_type(name, "list").is_some() || inner_type(name, "optional").is_some() =>
        {
            let inner = inner_type(name, "list")
                .or_else(|| inner_type(name, "optional"))
                .unwrap();
            validate_type(&parse_type(inner)?, aliases, visiting)?;
        }
        TypeExpression::Name(name) if aliases.contains_key(name) => {
            if !visiting.insert(name.clone()) {
                return Err(reject(1, format!("recursive schema {name}")));
            }
            validate_type(&aliases[name], aliases, visiting)?;
            visiting.remove(name);
        }
        TypeExpression::Name(name) => return Err(reject(1, format!("schema {name} absent"))),
    }
    Ok(())
}
pub(crate) fn resolve_type(
    ty: &TypeExpression,
    aliases: &BTreeMap<String, TypeExpression>,
) -> TypeExpression {
    match ty {
        TypeExpression::Name(name) if aliases.contains_key(name) => {
            resolve_type(&aliases[name], aliases)
        }
        TypeExpression::Record(fields) => TypeExpression::Record(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), resolve_type(v, aliases)))
                .collect(),
        ),
        // Aliases resolve at every depth, so `list(brief)` and the list of
        // the record `brief` names are one type. Validation has already
        // refused a recursive alias, so this terminates.
        TypeExpression::Name(name) if name.starts_with('{') => match parse_type(name) {
            Ok(parsed) => resolve_type(&parsed, aliases),
            Err(_) => ty.clone(),
        },
        TypeExpression::Name(name) => ["list", "optional"]
            .into_iter()
            .find_map(|function| {
                let inner = parse_type(inner_type(name, function)?).ok()?;
                Some(TypeExpression::Name(format!(
                    "{function}({})",
                    render_type(&resolve_type(&inner, aliases))
                )))
            })
            .unwrap_or_else(|| ty.clone()),
    }
}
pub(crate) fn item_type(ty: &TypeExpression) -> Option<TypeExpression> {
    let TypeExpression::Name(name) = ty else {
        return None;
    };
    parse_type(inner_type(name, "list")?).ok()
}
pub(crate) fn field_type(
    ty: &TypeExpression,
    path: &[&str],
    aliases: &BTreeMap<String, TypeExpression>,
) -> Option<TypeExpression> {
    let mut current = resolve_type(ty, aliases);
    for part in path {
        current = match current {
            TypeExpression::Record(fields) => fields.get(*part)?.clone(),
            TypeExpression::Name(name) => {
                let parsed = parse_type(&name).ok()?;
                if parsed == TypeExpression::Name(name.clone()) {
                    return None;
                }
                let TypeExpression::Record(fields) = parsed else {
                    return None;
                };
                fields.get(*part)?.clone()
            }
        };
    }
    Some(current)
}
/// Render a type back into the syntax `parse_type` accepts, so a nullable
/// latest reads as `optional(text)` and not as an embedded JSON encoding.
pub(crate) fn render_type(ty: &TypeExpression) -> String {
    match ty {
        TypeExpression::Name(name) => name.clone(),
        TypeExpression::Record(fields) => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|(key, value)| format!("{key}: {}", render_type(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
fn fields(
    values: &BTreeMap<String, String>,
    scope: &Scope<'_>,
) -> Result<Vec<CheckedNamedExpression>, DomainError> {
    values
        .iter()
        .map(|(key, source)| {
            Ok(CheckedNamedExpression {
                key: key.clone(),
                value: checked(source, scope)?,
            })
        })
        .collect()
}
/// `none` (or no workspace) gives the session no worktree; `repository(<expr>)`
/// names the repository its worktree is cut from, read from the stage input.
fn workspace_expression(
    source: Option<&str>,
    scope: &Scope<'_>,
) -> Result<Option<CheckedStageExpression>, DomainError> {
    let Some(text) = source.map(str::trim) else {
        return Ok(None);
    };
    if text == "none" {
        return Ok(None);
    }
    match split_call(text, "repository") {
        Some((inner, "")) if !inner.is_empty() => Ok(Some(checked(inner, scope)?)),
        _ => Err(reject(
            6,
            format!("workspace {text} must be none or repository(<expr>)"),
        )),
    }
}
fn checked_record(fields: &[CheckedNamedExpression]) -> TypeExpression {
    TypeExpression::Record(
        fields
            .iter()
            .map(|field| (field.key.clone(), field.value.value_type.clone()))
            .collect(),
    )
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
    path: &str,
    inputs: &BTreeMap<String, String>,
    prompts: &BTreeMap<String, String>,
    engine_inputs: &[&str],
) -> Result<(), DomainError> {
    if path.trim().is_empty() {
        return Err(reject(7, "review or agent prompt missing"));
    }
    let body = prompts
        .get(path)
        .ok_or_else(|| reject(10, format!("prompt file {path} missing")))?;
    for part in body.split("{{").skip(1) {
        let key = part.split("}}").next().unwrap_or("").trim();
        if !inputs.contains_key(key) && !engine_inputs.contains(&key) {
            return Err(reject(
                10,
                format!("prompt {path} names undeclared input {key}"),
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
) -> Result<(), DomainError> {
    let review_prompt = review
        .prompt
        .as_deref()
        .ok_or_else(|| reject(7, format!("review {key} lacks prompt")))?;
    if review_prompt.trim().is_empty() {
        return Err(reject(7, format!("review {key} lacks prompt")));
    }
    prompt(review_prompt, &review.inputs, prompts, MODE_ENGINE_INPUTS)?;
    if review
        .decisions
        .values()
        .any(|decision| decision.feedback.is_some())
    {
        return Err(reject(
            8,
            format!("operator review {key} sets fixed feedback"),
        ));
    }
    Ok(())
}
/// An engine review decides by itself: a `when`, and exactly one
/// request_changes decision carrying fixed, non-empty feedback.
fn check_engine_review(key: &str, review: &Review, has_when: bool) -> Result<(), DomainError> {
    if !has_when {
        return Err(reject(8, format!("engine review {key} lacks when")));
    }
    if review.prompt.is_some() || !review.inputs.is_empty() {
        return Err(reject(
            8,
            format!("engine review {key} has a prompt or inputs"),
        ));
    }
    let [decision] = review.decisions.values().collect::<Vec<_>>()[..] else {
        return Err(reject(
            8,
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
        return Err(reject(
            8,
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
    if let TypeExpression::Name(name) = contract {
        if name == TYPE_VARIABLE {
            let actual = resolve_type(actual, aliases);
            return match bindings.get(name) {
                Some(bound) => *bound == actual,
                None => {
                    bindings.insert(name.clone(), actual);
                    true
                }
            };
        }
    }
    match (
        resolve_type(contract, aliases),
        resolve_type(actual, aliases),
    ) {
        (TypeExpression::Record(expected), TypeExpression::Record(found)) => {
            expected.len() == found.len()
                && expected.iter().all(|(key, ty)| {
                    found
                        .get(key)
                        .is_some_and(|other| unify(ty, other, aliases, bindings))
                })
        }
        // A type variable may sit inside a constructor: `list($value)`.
        (TypeExpression::Name(expected), TypeExpression::Name(found)) => ["list", "optional"]
            .into_iter()
            .find_map(|function| {
                let inner = (
                    inner_type(&expected, function)?,
                    inner_type(&found, function)?,
                );
                Some(match (parse_type(inner.0), parse_type(inner.1)) {
                    (Ok(expected), Ok(found)) => unify(&expected, &found, aliases, bindings),
                    _ => false,
                })
            })
            .unwrap_or(expected == found),
        (expected, found) => expected == found,
    }
}
fn compile_stage(
    key: &str,
    stage: &Stage,
    workflow: &Workflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
) -> Result<(CheckedStage, TypeExpression), DomainError> {
    let empty = BTreeMap::new();
    let base = Scope {
        input: &stage.input,
        artifacts: &stage.artifacts,
        outcomes: &empty,
        each: None,
        item: None,
        aliases: &workflow.schemas,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: BTreeSet::new(),
    };
    let mut owners = BTreeMap::<String, String>::new();
    let mut workers = Vec::new();
    for (worker_key, worker) in &stage.workers {
        let created = match worker {
            Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates,
        };
        if created.is_empty() {
            return Err(reject(7, format!("worker {worker_key} creates nothing")));
        }
        for artifact in created {
            if !stage.artifacts.contains_key(&artifact.0) {
                return Err(reject(1, format!("artifact {artifact} absent")));
            }
            if owners
                .insert(artifact.0.clone(), worker_key.clone())
                .is_some()
            {
                return Err(reject(
                    7,
                    format!("artifact {artifact} has multiple creators"),
                ));
            }
        }
        let guard = match worker {
            Worker::Agent { when, .. } | Worker::Code { when, .. } => when.as_deref(),
        };
        let when = guard
            .map(|text| checked_guard(text, &base, 9, &format!("worker {worker_key} when")))
            .transpose()?;
        // A worker runs only while its guard holds, so what the guard proves
        // published types the worker's inputs and workspace.
        let worker_scope = Scope {
            guaranteed: when
                .as_ref()
                .map(|(_, proven)| proven.clone())
                .unwrap_or_default(),
            ..base.clone()
        };
        let (inputs, workspace) = match worker {
            Worker::Agent {
                prompts: modes,
                inputs,
                creates,
                reviews,
                workspace,
                session,
                ..
            } => {
                let input_fields = fields(inputs, &worker_scope)?;
                let workspace = workspace_expression(workspace.as_deref(), &worker_scope)?;
                if reviews.is_some() && !modes.contains_key("review") {
                    return Err(reject(
                        7,
                        format!("reviewer {worker_key} lacks review prompt"),
                    ));
                }
                if reviews.is_none() && !modes.contains_key("initial") {
                    return Err(reject(
                        7,
                        format!("agent {worker_key} lacks initial prompt"),
                    ));
                }
                if let Some(of) = reviews {
                    if !stage.artifacts.contains_key(&of.0) {
                        return Err(reject(8, format!("reviewed artifact {of} absent")));
                    }
                }
                // A request_changes targets its `on`, defaulting to the reviewed artifact.
                let needs_revise = creates.iter().any(|artifact| {
                    !stage.artifacts[&artifact.0].validate.is_empty()
                        || stage
                            .reviews
                            .values()
                            .flat_map(|review| {
                                review.decisions.values().map(move |decision| {
                                    (decision.on.as_ref().unwrap_or(&review.of), decision)
                                })
                            })
                            .any(|(target, decision)| {
                                target == artifact
                                    && decision.effect == DecisionEffect::RequestChanges
                            })
                });
                if needs_revise && !modes.contains_key("revise") {
                    return Err(reject(7, format!("agent {worker_key} lacks revise prompt")));
                }
                if modes.contains_key(HANDOFF_PROMPT)
                    && !matches!(session, Some(SessionMode::Fresh))
                {
                    return Err(reject(
                        7,
                        format!(
                            "agent {worker_key} has a handoff prompt but its session is not fresh"
                        ),
                    ));
                }
                for (mode, path) in modes {
                    let engine_inputs = if mode == HANDOFF_PROMPT {
                        HANDOFF_ENGINE_INPUTS
                    } else {
                        MODE_ENGINE_INPUTS
                    };
                    prompt(path, inputs, prompts, engine_inputs)?;
                }
                (input_fields, workspace)
            }
            Worker::Code {
                operation,
                inputs,
                creates,
                every,
                ..
            } => {
                if let Some(interval) = every {
                    if !is_duration(interval) {
                        return Err(reject(
                            12,
                            format!("code worker {worker_key} every {interval} is not a duration"),
                        ));
                    }
                }
                if creates.len() != 1 {
                    return Err(reject(
                        12,
                        format!("code worker {worker_key} must create one artifact"),
                    ));
                }
                let contract = operations
                    .iter()
                    .find(|o| o.key == *operation)
                    .ok_or_else(|| reject(12, format!("operation {operation} absent")))?;
                let input_fields = fields(inputs, &worker_scope)?;
                let mut bindings = BTreeMap::new();
                if !unify(
                    &contract.input_schema,
                    &checked_record(&input_fields),
                    &workflow.schemas,
                    &mut bindings,
                ) {
                    return Err(reject(12, format!("operation {operation} input mismatch")));
                }
                if !unify(
                    &contract.output_schema,
                    &stage.artifacts[&creates[0].0].schema,
                    &workflow.schemas,
                    &mut bindings,
                ) {
                    return Err(reject(12, format!("operation {operation} output mismatch")));
                }
                (input_fields, None)
            }
        };
        workers.push(CheckedWorker {
            key: WorkerKey::from(worker_key.as_str()),
            inputs,
            workspace,
            when: when.map(|(expression, _)| expression),
        });
    }
    for artifact in stage.artifacts.keys() {
        if !owners.contains_key(artifact) {
            return Err(reject(7, format!("artifact {artifact} has no creator")));
        }
    }
    let mut validations = Vec::new();
    for (artifact_key, artifact) in &stage.artifacts {
        let own = Scope {
            body: Some((artifact_key, &artifact.schema)),
            ..base.clone()
        };
        let checks = artifact
            .validate
            .iter()
            .map(|rule| {
                let expression = checked(&rule.check, &own)?;
                if expression.value_type != TypeExpression::Name("boolean".into()) {
                    return Err(reject(8, "validation check must be boolean"));
                }
                Ok(expression)
            })
            .collect::<Result<Vec<_>, _>>()?;
        validations.push(CheckedArtifactValidation {
            artifact: SymbolKey::from(artifact_key.as_str()),
            checks,
        });
    }
    let mut reviews = Vec::new();
    for (review_key, review) in &stage.reviews {
        if !stage.artifacts.contains_key(&review.of.0) {
            return Err(reject(8, format!("review {review_key} artifact absent")));
        }
        let when = review
            .when
            .as_deref()
            .map(|text| checked_guard(text, &base, 9, &format!("review {review_key} when")))
            .transpose()?
            .map(|(expression, _)| expression);
        match review.by {
            ReviewBy::Operator => check_operator_review(review_key, review, prompts)?,
            ReviewBy::Engine => check_engine_review(review_key, review, when.is_some())?,
        }
        let review_inputs = fields(&review.inputs, &base).map_err(|mut error| {
            error.entity_id = "check 8".into();
            error
        })?;
        reviews.push(CheckedReview {
            key: SymbolKey::from(review_key.as_str()),
            of: review.of.clone(),
            inputs: review_inputs,
            when,
        });
        for decision in review.decisions.values() {
            let target = decision.on.as_ref().unwrap_or(&review.of);
            let Some(owner) = owners.get(&target.0) else {
                return Err(reject(8, format!("decision target {target} absent")));
            };
            // Only a request for changes needs a worker that can revise; an
            // approval may be of any artifact (a reviewer's, a code worker's).
            if decision.effect == DecisionEffect::RequestChanges
                && !matches!(stage.workers[owner], Worker::Agent { reviews: None, .. })
            {
                return Err(reject(
                    8,
                    format!("decision target {target} is not agent-created"),
                ));
            }
        }
    }
    let done = stage
        .done_when
        .as_deref()
        .ok_or_else(|| reject(9, format!("stage {key} lacks done_when")))?;
    let (done_when, proven) = checked_guard(done, &base, 9, &format!("stage {key} done_when"))?;
    let outcome_scope = Scope {
        guaranteed: proven,
        ..base
    };
    let outcome = fields(&stage.outcome, &outcome_scope)?;
    let outcome_type = checked_record(&outcome);
    Ok((
        CheckedStage {
            key: SymbolKey::from(key),
            workers,
            done_when,
            outcome,
            validations,
            reviews,
        },
        outcome_type,
    ))
}
fn compile_group(
    group: &Group,
    input: &TypeExpression,
    stage_outcomes: &BTreeMap<String, TypeExpression>,
    workflow: &Workflow,
) -> Result<(CheckedGroup, TypeExpression), DomainError> {
    for (key, unit) in &group.units {
        if unit.stage.is_some() == unit.group.is_some() {
            return Err(reject(
                2,
                format!("unit {key} needs exactly one stage or group"),
            ));
        }
        if unit.for_each.is_some() != unit.key.is_some() {
            return Err(reject(2, format!("collection {key} needs key")));
        }
        if let Some(pool) = &unit.pool {
            if group
                .pools
                .get(&pool.0)
                .is_none_or(|capacity| *capacity == 0)
            {
                return Err(reject(1, format!("pool {pool} absent or empty")));
            }
        }
        if let UnitDependencies::Fixed(after) = &unit.after {
            for dependency in after {
                let Some(prerequisite) = group.units.get(&dependency.0) else {
                    return Err(reject(1, format!("unit {dependency} absent")));
                };
                // Members are units of their own, `group/<key>`: no unit is the collection.
                if prerequisite.for_each.is_some() {
                    return Err(reject(
                        2,
                        format!(
                            "unit {key} waits on collection {dependency}, which is no one unit"
                        ),
                    ));
                }
            }
        }
    }
    // A member's id is `group/<key>`, its key runtime data, so a sibling's
    // id (or another collection's member's) could be any member's.
    if let Some((collection, _)) = group.units.iter().find(|(_, unit)| unit.for_each.is_some()) {
        if group.units.len() > 1 {
            return Err(reject(
                2,
                format!("collection {collection} shares its group, so a member key could collide with a sibling"),
            ));
        }
    }
    fn visit(
        key: &str,
        group: &Group,
        visiting: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) -> Result<(), DomainError> {
        if done.contains(key) {
            return Ok(());
        }
        if !visiting.insert(key.to_owned()) {
            return Err(reject(5, format!("dependency cycle through {key}")));
        }
        if let Some(UnitDependencies::Fixed(after)) = group.units.get(key).map(|u| &u.after) {
            for dependency in after {
                visit(&dependency.0, group, visiting, done, order)?;
            }
        }
        visiting.remove(key);
        done.insert(key.to_owned());
        order.push(key.to_owned());
        Ok(())
    }
    let mut order = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for key in group.units.keys() {
        visit(key, group, &mut visiting, &mut done, &mut order)?;
    }
    let empty = BTreeMap::new();
    let mut outcomes = BTreeMap::<String, TypeExpression>::new();
    let mut checked_units = Vec::new();
    for key in &order {
        let unit = &group.units[key];
        let after_keys: Vec<_> = if let UnitDependencies::Fixed(after) = &unit.after {
            after.clone()
        } else {
            vec![]
        };
        let allowed: BTreeMap<_, _> = after_keys
            .iter()
            .filter_map(|key| outcomes.get(&key.0).map(|ty| (key.0.clone(), ty.clone())))
            .collect();
        let mut scope = Scope {
            input,
            artifacts: &empty,
            outcomes: &allowed,
            each: None,
            item: None,
            aliases: &workflow.schemas,
            body: None,
            guaranteed: BTreeSet::new(),
            collections: BTreeSet::new(),
        };
        let collection = if let Some(source) = &unit.for_each {
            let source = checked(source, &scope)?;
            let each = item_type(&resolve_type(&source.value_type, &workflow.schemas))
                .ok_or_else(|| reject(2, format!("collection {key} source is not list")))?;
            scope.each = Some(each);
            let key_expr = checked(unit.key.as_ref().unwrap(), &scope)?;
            if key_expr.value_type != TypeExpression::Name("ident".into())
                && key_expr.value_type != TypeExpression::Name("text".into())
            {
                return Err(reject(2, "collection key is not text"));
            }
            let after = match &unit.after {
                UnitDependencies::Each(text) => checked(text, &scope)?,
                _ => CheckedStageExpression {
                    source: "[]".into(),
                    value_type: TypeExpression::Name("list(ident)".into()),
                    expression: Expression::List {
                        schema: SchemaId::from("list(ident)"),
                        items: vec![],
                    },
                },
            };
            let dependency_type = item_type(&resolve_type(&after.value_type, &workflow.schemas));
            if !matches!(dependency_type,
                Some(TypeExpression::Name(ref name)) if name == "ident" || name == "text"
            ) {
                return Err(reject(
                    2,
                    "collection after must be list(ident) or list(text)",
                ));
            }
            Some(CheckedUnitCollection {
                source,
                key: key_expr,
                after,
            })
        } else {
            None
        };
        let checked_input = fields(&unit.input, &scope)?;
        let input_type = checked_record(&checked_input);
        let (nested, outcome_type) = if let Some(stage) = &unit.stage {
            let target = workflow
                .stages
                .get(&stage.0)
                .ok_or_else(|| reject(1, format!("stage {stage} absent")))?;
            if resolve_type(&input_type, &workflow.schemas)
                != resolve_type(&target.input, &workflow.schemas)
            {
                return Err(reject(
                    6,
                    format!("unit {key} input does not match stage {stage}"),
                ));
            }
            (
                None,
                stage_outcomes
                    .get(&stage.0)
                    .cloned()
                    .ok_or_else(|| reject(1, "stage outcome absent"))?,
            )
        } else {
            let (nested, outcome_type) = compile_group(
                unit.group.as_ref().unwrap(),
                &input_type,
                stage_outcomes,
                workflow,
            )?;
            (Some(Box::new(nested)), outcome_type)
        };
        outcomes.insert(key.clone(), outcome_type);
        checked_units.push(CheckedUnit {
            key: SymbolKey::from(key.as_str()),
            input: checked_input,
            after: after_keys,
            collection,
            group: nested,
        });
    }
    let scope = Scope {
        input,
        artifacts: &empty,
        outcomes: &outcomes,
        each: None,
        item: None,
        aliases: &workflow.schemas,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: group
            .units
            .iter()
            .filter(|(_, unit)| unit.for_each.is_some())
            .map(|(key, _)| key.clone())
            .collect(),
    };
    let mut checked_outcome = Vec::new();
    for (key, source) in &group.outcome {
        let value = if let Some(inner) = inner_type(source, "map") {
            let (collection, projection) = inner
                .split_once(',')
                .ok_or_else(|| reject(4, "map needs collection and projection"))?;
            let collection = collection.trim();
            let projection = projection.trim();
            let member = outcomes
                .get(collection)
                .ok_or_else(|| reject(4, "map collection absent"))?;
            let suffix = projection
                .strip_prefix(collection)
                .and_then(|v| v.strip_prefix(".outcome"))
                .ok_or_else(|| reject(4, "map projection outside outcome"))?;
            let item = if suffix.is_empty() {
                member.clone()
            } else {
                field_type(
                    member,
                    &suffix
                        .strip_prefix('.')
                        .unwrap_or("")
                        .split('.')
                        .collect::<Vec<_>>(),
                    &workflow.schemas,
                )
                .ok_or_else(|| reject(4, "map field absent"))?
            };
            let item_type = TypeExpression::Name(format!("list({})", render_type(&item)));
            CheckedStageExpression {
                source: source.clone(),
                expression: Expression::Map {
                    source: Box::new(Expression::Reference {
                        root: ReferenceRoot::MemberOutcomes {
                            unit: SymbolKey::from(collection),
                        },
                        path: vec![],
                    }),
                    schema: SchemaId::from("map"),
                    value: Box::new(Expression::Reference {
                        root: ReferenceRoot::Item,
                        path: suffix
                            .strip_prefix('.')
                            .map(|rest| rest.split('.').map(str::to_owned).collect())
                            .unwrap_or_default(),
                    }),
                },
                value_type: item_type,
            }
        } else {
            checked(source, &scope)?
        };
        checked_outcome.push(CheckedNamedExpression {
            key: key.clone(),
            value,
        });
    }
    let outcome_type = checked_record(&checked_outcome);
    Ok((
        CheckedGroup {
            units: checked_units,
            outcome: checked_outcome,
        },
        outcome_type,
    ))
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
    let source_value = serde_json::to_value(source).map_err(|error| {
        DomainError::new(
            DomainErrorKind::UnknownConstruct,
            "workflow",
            error.to_string(),
        )
    })?;
    limits
        .check_value(&source_value)
        .map_err(|detail| DomainError::new(DomainErrorKind::ResourceLimit, "workflow", detail))?;
    validate_type(&source.input, &source.schemas, &mut BTreeSet::new())?;
    for ty in source.schemas.values() {
        validate_type(ty, &source.schemas, &mut BTreeSet::new())?;
    }
    for stage in source.stages.values() {
        validate_type(&stage.input, &source.schemas, &mut BTreeSet::new())?;
        for artifact in stage.artifacts.values() {
            validate_type(&artifact.schema, &source.schemas, &mut BTreeSet::new())?;
        }
        for review in stage.reviews.values() {
            for decision in review.decisions.values() {
                if let Some(payload) = &decision.payload {
                    validate_type(payload, &source.schemas, &mut BTreeSet::new())?;
                }
            }
        }
    }
    let mut stages = Vec::new();
    let mut stage_outcomes = BTreeMap::new();
    for (key, stage) in &source.stages {
        let (checked, outcome_type) = compile_stage(key, stage, source, operations, prompts)?;
        stages.push(checked);
        stage_outcomes.insert(key.clone(), outcome_type);
    }
    let (root, _) = compile_group(&source.run, &source.input, &stage_outcomes, source)?;
    let encoded = serde_json::to_vec(source).map_err(|error| reject(11, error.to_string()))?;
    let digest = BundleDigest(format!("{:x}", Sha256::digest(encoded)));
    Ok(CheckedWorkflow {
        source: source.clone(),
        digest,
        stages,
        root,
    })
}
pub fn decode_workflow(bytes: &[u8]) -> Result<Workflow, DomainError> {
    let value = crate::decode_unique_json(bytes)?;
    if let Some(stages) = value.get("stages").and_then(serde_json::Value::as_object) {
        for stage in stages.values() {
            if let Some(workers) = stage.get("workers").and_then(serde_json::Value::as_object) {
                for (key, worker) in workers {
                    let kind = worker
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let forbidden: &[&str] = match kind {
                        "code" => &["prompts", "runtime", "workspace", "session", "reviews"],
                        "agent" => &["operation", "every"],
                        _ => &[],
                    };
                    if let Some(field) =
                        forbidden.iter().find(|field| worker.get(**field).is_some())
                    {
                        return Err(reject(12, format!("worker {key} cannot set {field}")));
                    }
                }
            }
        }
    }
    serde_json::from_value(value).map_err(|error| reject(11, error.to_string()))
}

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
            assert_eq!(&*parse_type(text).unwrap_err().entity_id, "check 11");
        }
    }

    #[test]
    fn list_item_types_render_as_source_syntax() {
        let item = TypeExpression::Record(BTreeMap::from([(
            "key".into(),
            TypeExpression::Name("text".into()),
        )]));
        assert_eq!(format!("list({})", render_type(&item)), "list({key: text})");
        assert_eq!(
            format!(
                "list({})",
                render_type(&TypeExpression::Name("text".into()))
            ),
            "list(text)"
        );
    }
}
