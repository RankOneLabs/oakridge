use super::*;
use crate::expressions::{parse_expression, parse_repository};
use workflow_model::SourceSpan;

#[path = "workflow_outcomes.rs"]
mod outcomes;

pub use workflow_model::{CheckKind, CompileError};
pub(super) struct ParsedWorkflow {
    source: Workflow,
}
pub(super) struct ResolvedWorkflow {
    source: Workflow,
    original: Workflow,
}
pub(super) struct CheckedParts {
    source: Workflow,
    original: Workflow,
    stages: Vec<CheckedStage>,
    root: CheckedGroup,
}
fn parse_text(text: &str, path: String, errors: &mut Vec<CompileError>) {
    if let Err(error) = parse_expression(text, &path) {
        errors.push(error);
    }
}
fn parse_fields(fields: &BTreeMap<String, String>, path: &str, errors: &mut Vec<CompileError>) {
    for (key, text) in fields {
        parse_text(text, format!("{path}.{key}"), errors);
    }
}
fn parse_group(group: &Group, path: &str, errors: &mut Vec<CompileError>) {
    parse_fields(&group.outcome, &format!("{path}.outcome"), errors);
    for (key, unit) in &group.units {
        let path = format!("{path}.units.{key}");
        parse_fields(&unit.input, &format!("{path}.input"), errors);
        if let Some(text) = &unit.for_each {
            parse_text(text, format!("{path}.for_each"), errors);
        }
        if let Some(text) = &unit.key {
            parse_text(text, format!("{path}.key"), errors);
        }
        if let UnitDependencies::Each(text) = &unit.after {
            parse_text(text, format!("{path}.after"), errors);
        }
        if let Some(nested) = &unit.group {
            parse_group(nested, &format!("{path}.group"), errors);
        }
    }
}
pub(super) fn parse(source: &Workflow) -> Result<ParsedWorkflow, Vec<CompileError>> {
    let mut errors = Vec::new();
    for (key, stage) in &source.stages {
        let stage_path = format!("stages.{key}");
        parse_fields(
            &stage.outcome,
            &format!("{stage_path}.outcome"),
            &mut errors,
        );
        if let Some(text) = &stage.done_when {
            parse_text(text, format!("{stage_path}.done_when"), &mut errors);
        }
        for (key, artifact) in &stage.artifacts {
            for (index, validation) in artifact.validate.iter().enumerate() {
                parse_text(
                    &validation.check,
                    format!("{stage_path}.artifacts.{key}.validate.{index}.check"),
                    &mut errors,
                );
            }
        }
        for (key, worker) in &stage.workers {
            let path = format!("{stage_path}.workers.{key}");
            let (inputs, when) = match worker {
                Worker::Agent {
                    inputs,
                    when,
                    workspace,
                    ..
                } => {
                    if let Some(text) = workspace.as_deref().filter(|text| text.trim() != "none") {
                        if let Err(error) = parse_repository(text, &format!("{path}.workspace")) {
                            let mut diagnostic = error;
                            diagnostic.check = CheckKind::Workspace;
                            errors.push(diagnostic);
                        }
                    }
                    (inputs, when)
                }
                Worker::Code { inputs, when, .. } => (inputs, when),
            };
            parse_fields(inputs, &format!("{path}.inputs"), &mut errors);
            if let Some(text) = when {
                parse_text(text, format!("{path}.when"), &mut errors);
            }
        }
        for (key, review) in &stage.reviews {
            let path = format!("{stage_path}.reviews.{key}");
            parse_fields(&review.inputs, &format!("{path}.inputs"), &mut errors);
            if let Some(text) = &review.when {
                parse_text(text, format!("{path}.when"), &mut errors);
            }
        }
    }
    parse_group(&source.run, "run", &mut errors);
    if errors.is_empty() {
        Ok(ParsedWorkflow {
            source: source.clone(),
        })
    } else {
        Err(errors)
    }
}
fn resolve_one(
    ty: &Type,
    aliases: &BTreeMap<String, Type>,
    outcomes: &BTreeMap<String, Type>,
    visiting: &mut BTreeSet<String>,
) -> Result<Type, String> {
    match ty {
        Type::Named { schema } => {
            let Some(value) = aliases.get(&schema.0) else {
                return Err(format!("schema {} absent", schema.0));
            };
            if !visiting.insert(schema.0.clone()) {
                return Err(format!("recursive schema {}", schema.0));
            }
            let result = resolve_one(value, aliases, outcomes, visiting);
            visiting.remove(&schema.0);
            result
        }
        Type::OutcomeOf { stage } => {
            let Some(outcome) = outcomes.get(&stage.0) else {
                return Err(format!("stage {} outcome absent", stage.0));
            };
            let marker = format!("outcome_of({})", stage.0);
            if !visiting.insert(marker.clone()) {
                return Err(format!("recursive {marker}"));
            }
            let result = resolve_one(outcome, aliases, outcomes, visiting);
            visiting.remove(&marker);
            result
        }
        Type::List { item } => Ok(Type::List {
            item: Box::new(resolve_one(item, aliases, outcomes, visiting)?),
        }),
        Type::Optional { value } => Ok(Type::Optional {
            value: Box::new(resolve_one(value, aliases, outcomes, visiting)?),
        }),
        Type::Record { fields } => {
            let mut resolved = BTreeMap::new();
            for (key, value) in fields {
                if key.is_empty() {
                    return Err("empty schema field key".into());
                }
                resolved.insert(
                    key.clone(),
                    resolve_one(value, aliases, outcomes, visiting)?,
                );
            }
            Ok(Type::Record { fields: resolved })
        }
        _ => Ok(ty.clone()),
    }
}
fn resolve_at(
    ty: &mut Type,
    aliases: &BTreeMap<String, Type>,
    outcomes: &BTreeMap<String, Type>,
    path: String,
    errors: &mut Vec<CompileError>,
) {
    match resolve_one(ty, aliases, outcomes, &mut BTreeSet::new()) {
        Ok(resolved) => *ty = resolved,
        Err(detail) => errors.push(CompileError::new(
            CheckKind::Name,
            path,
            SourceSpan {
                start: 0,
                end: ty.to_string().len(),
            },
            detail,
        )),
    }
}
pub(super) fn resolve(parsed: ParsedWorkflow) -> Result<ResolvedWorkflow, Vec<CompileError>> {
    let mut source = parsed.source;
    let original = source.clone();
    let aliases = source.schemas.clone();
    let outcomes = outcomes::infer_outcomes(&source, &aliases)?;
    let mut errors = Vec::new();
    for (key, ty) in &mut source.schemas {
        if matches!(
            key.as_str(),
            "text" | "ident" | "repo_path" | "integer" | "boolean"
        ) {
            errors.push(CompileError::new(
                CheckKind::Name,
                format!("schemas.{key}"),
                source_span(key),
                format!("schema {key} shadows a primitive type"),
            ));
        }
        resolve_at(
            ty,
            &aliases,
            &outcomes,
            format!("schemas.{key}"),
            &mut errors,
        );
    }
    resolve_at(
        &mut source.input,
        &aliases,
        &outcomes,
        "input".into(),
        &mut errors,
    );
    for (key, stage) in &mut source.stages {
        let path = format!("stages.{key}");
        resolve_at(
            &mut stage.input,
            &aliases,
            &outcomes,
            format!("{path}.input"),
            &mut errors,
        );
        for (artifact, value) in &mut stage.artifacts {
            resolve_at(
                &mut value.schema,
                &aliases,
                &outcomes,
                format!("{path}.artifacts.{artifact}.schema"),
                &mut errors,
            );
        }
        for (review, value) in &mut stage.reviews {
            for (decision, value) in &mut value.decisions {
                if let Some(payload) = &mut value.payload {
                    resolve_at(
                        payload,
                        &aliases,
                        &outcomes,
                        format!("{path}.reviews.{review}.decisions.{decision}.payload"),
                        &mut errors,
                    );
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(ResolvedWorkflow { source, original })
    } else {
        Err(errors)
    }
}
pub(super) fn check(
    resolved: ResolvedWorkflow,
    operations: &[CodeOperation],
    prompts: &BTreeMap<String, String>,
    limits: &ResourceLimits,
) -> Result<CheckedParts, Vec<CompileError>> {
    let source = resolved.source;
    let mut errors = Vec::new();
    if let Ok(value) = serde_json::to_value(&source) {
        if let Err(detail) = limits.check_value(&value) {
            errors.push(CompileError::new(
                CheckKind::Schema,
                "workflow",
                source_span(&source.workflow.0),
                detail,
            ));
        }
    }
    let mut stages = Vec::new();
    let mut outcomes = BTreeMap::new();
    for (key, stage) in &source.stages {
        match compile_stage(key, stage, &source, operations, prompts) {
            Ok((checked, outcome)) => {
                stages.push(checked);
                outcomes.insert(key.clone(), outcome);
            }
            Err(stage_errors) => errors.extend(stage_errors),
        }
    }
    group::check_structure(&source.run, "run", &source, &mut errors);
    if !errors.is_empty() {
        return Err(errors);
    }
    let root = compile_group(&source.run, &source.input, &outcomes, &source, "run")
        .map_err(|errors| errors.0)?
        .0;
    Ok(CheckedParts {
        source,
        original: resolved.original,
        stages,
        root,
    })
}
pub(super) fn lower(parts: CheckedParts) -> Result<(CheckedWorkflow, Workflow), Vec<CompileError>> {
    let mut encoded = Vec::new();
    let mut serializer = serde_json::Serializer::new(&mut encoded);
    serde_path_to_error::serialize(&parts.original, &mut serializer).map_err(|error| {
        let location = error.path().to_string();
        let path = if location == "." {
            "workflow"
        } else {
            &location
        };
        let span = if path == "workflow" {
            source_span(&parts.original.workflow.0)
        } else {
            workflow_span(&parts.original, path)
        };
        vec![CompileError::new(
            CheckKind::Schema,
            path,
            span,
            error.inner().to_string(),
        )]
    })?;
    let resolved = parts.source.clone();
    let program = CheckedWorkflow {
        digest: BundleDigest(format!("{:x}", Sha256::digest(encoded))),
        input: parts.source.input,
        stages: parts.stages,
        root: parts.root,
    };
    Ok((program, resolved))
}
