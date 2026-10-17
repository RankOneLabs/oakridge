use super::*;
use crate::expressions::{expand_lets, infer, parse_expression, proven_artifacts, StageExpr};

fn validate_alias(
    ty: &Type,
    aliases: &BTreeMap<String, Type>,
    visiting: &mut BTreeSet<String>,
) -> Result<(), String> {
    match ty {
        Type::Named { schema } => {
            let Some(value) = aliases.get(&schema.0) else {
                return Err(format!("schema {} absent", schema.0));
            };
            if !visiting.insert(schema.0.clone()) {
                return Err(format!("recursive schema {}", schema.0));
            }
            let result = validate_alias(value, aliases, visiting);
            visiting.remove(&schema.0);
            result
        }
        Type::List { item } => validate_alias(item, aliases, visiting),
        Type::Optional { value } => validate_alias(value, aliases, visiting),
        Type::Record { fields } => {
            for value in fields.values() {
                validate_alias(value, aliases, visiting)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn references(
    ty: &Type,
    aliases: &BTreeMap<String, Type>,
    visiting: &mut BTreeSet<String>,
    found: &mut BTreeSet<String>,
) {
    match ty {
        Type::OutcomeOf { stage } => {
            found.insert(stage.0.clone());
        }
        Type::Named { schema } => {
            if visiting.insert(schema.0.clone()) {
                if let Some(value) = aliases.get(&schema.0) {
                    references(value, aliases, visiting, found);
                }
                visiting.remove(&schema.0);
            }
        }
        Type::List { item } => references(item, aliases, visiting, found),
        Type::Optional { value } => references(value, aliases, visiting, found),
        Type::Record { fields } => {
            for value in fields.values() {
                references(value, aliases, visiting, found);
            }
        }
        _ => {}
    }
}

fn latest_artifacts(expr: &StageExpr, found: &mut BTreeSet<String>) {
    match expr {
        StageExpr::Spanned(inner, _)
        | StageExpr::Not(inner)
        | StageExpr::Len(inner)
        | StageExpr::Require { value: inner, .. }
        | StageExpr::Field { value: inner, .. } => latest_artifacts(inner, found),
        StageExpr::Or(left, right)
        | StageExpr::And(left, right)
        | StageExpr::Equality { left, right, .. }
        | StageExpr::Compare { left, right, .. } => {
            latest_artifacts(left, found);
            latest_artifacts(right, found);
        }
        StageExpr::Every { source, predicate }
        | StageExpr::Any { source, predicate }
        | StageExpr::Filter { source, predicate } => {
            latest_artifacts(source, found);
            latest_artifacts(predicate, found);
        }
        StageExpr::MapOf { source, value }
        | StageExpr::Contains { source, value }
        | StageExpr::Default {
            value: source,
            fallback: value,
            ..
        } => {
            latest_artifacts(source, found);
            latest_artifacts(value, found);
        }
        StageExpr::Lookup { source, key, .. } => {
            latest_artifacts(source, found);
            latest_artifacts(key, found);
        }
        StageExpr::ValidGraph { source, .. } => latest_artifacts(source, found),
        StageExpr::Record(fields) => {
            for (_, value) in fields {
                latest_artifacts(value, found);
            }
        }
        StageExpr::Latest { artifact, .. } => {
            found.insert(artifact.clone());
        }
        _ => {}
    }
}

fn outcome_artifacts(stage: &Stage) -> BTreeSet<String> {
    let mut used = BTreeSet::new();
    for text in stage.outcome.values() {
        if let Ok(expr) = parse_expression(text, "")
            .and_then(|expr| expand_lets(expr, &stage.let_bindings, &mut BTreeSet::new()))
        {
            latest_artifacts(&expr, &mut used);
        }
    }
    used
}

fn dependencies(stage: &Stage, aliases: &BTreeMap<String, Type>) -> Vec<(String, String)> {
    let mut found = BTreeSet::new();
    references(&stage.input, aliases, &mut BTreeSet::new(), &mut found);
    let mut result: Vec<_> = found
        .into_iter()
        .map(|key| (key, "input".to_owned()))
        .collect();
    for artifact in outcome_artifacts(stage) {
        if let Some(value) = stage.artifacts.get(&artifact) {
            let mut found = BTreeSet::new();
            references(&value.schema, aliases, &mut BTreeSet::new(), &mut found);
            result.extend(
                found
                    .into_iter()
                    .map(|key| (key, format!("artifacts.{artifact}.schema"))),
            );
        }
    }
    result
}

fn visit_stage(
    key: &str,
    source: &Workflow,
    aliases: &BTreeMap<String, Type>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
    order: &mut Vec<String>,
    errors: &mut Vec<CompileError>,
) {
    if visited.contains(key) {
        return;
    }
    visiting.insert(key.to_owned());
    let stage = &source.stages[key];
    for (dependency, path) in dependencies(stage, aliases) {
        if !source.stages.contains_key(&dependency) {
            continue;
        }
        if visiting.contains(&dependency) {
            errors.push(CompileError::new(
                CheckKind::Name,
                format!("stages.{key}.{path}"),
                workflow_span(source, &format!("stages.{key}.{path}")),
                format!("recursive outcome_of({dependency})"),
            ));
        } else {
            visit_stage(
                &dependency,
                source,
                aliases,
                visiting,
                visited,
                order,
                errors,
            );
        }
    }
    visiting.remove(key);
    visited.insert(key.to_owned());
    order.push(key.to_owned());
}

pub(super) fn infer_outcomes(
    source: &Workflow,
    aliases: &BTreeMap<String, Type>,
) -> Result<BTreeMap<String, Type>, Vec<CompileError>> {
    let mut errors = Vec::new();
    for (key, ty) in aliases {
        if let Err(detail) = validate_alias(ty, aliases, &mut BTreeSet::from([key.clone()])) {
            errors.push(CompileError::new(
                CheckKind::Name,
                format!("schemas.{key}"),
                source_span(&ty.to_string()),
                detail,
            ));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut order = Vec::new();
    let mut visited = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    for key in source.stages.keys() {
        visit_stage(
            key,
            source,
            aliases,
            &mut visiting,
            &mut visited,
            &mut order,
            &mut errors,
        );
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut outcomes = BTreeMap::new();
    let empty = BTreeMap::new();
    for key in order {
        let stage = &source.stages[&key];
        let input = match resolve_one(&stage.input, aliases, &outcomes, &mut BTreeSet::new()) {
            Ok(value) => value,
            Err(detail) => {
                errors.push(CompileError::new(
                    CheckKind::Name,
                    format!("stages.{key}.input"),
                    workflow_span(source, &format!("stages.{key}.input")),
                    detail,
                ));
                continue;
            }
        };
        let mut artifacts = stage.artifacts.clone();
        let mut has_schema_error = false;
        for artifact in outcome_artifacts(stage) {
            let Some(value) = artifacts.get_mut(&artifact) else {
                continue;
            };
            match resolve_one(&value.schema, aliases, &outcomes, &mut BTreeSet::new()) {
                Ok(resolved) => value.schema = resolved,
                Err(detail) => {
                    has_schema_error = true;
                    let path = format!("stages.{key}.artifacts.{artifact}.schema");
                    errors.push(CompileError::new(
                        CheckKind::Name,
                        &path,
                        workflow_span(source, &path),
                        detail,
                    ));
                }
            }
        }
        if has_schema_error {
            continue;
        }
        let guaranteed = stage
            .done_when
            .as_deref()
            .and_then(|text| parse_expression(text, &format!("stages.{key}.done_when")).ok())
            .and_then(|expr| expand_lets(expr, &stage.let_bindings, &mut BTreeSet::new()).ok())
            .map(|expr| proven_artifacts(&expr))
            .unwrap_or_default();
        let mut fields = BTreeMap::new();
        let mut has_field_error = false;
        for (field, text) in &stage.outcome {
            let path = format!("stages.{key}.outcome.{field}");
            let scope = Scope {
                input: &input,
                artifacts: &artifacts,
                outcomes: &empty,
                each: None,
                item: None,
                aliases: &empty,
                lets: &stage.let_bindings,
                body: None,
                guaranteed: guaranteed.clone(),
                collections: BTreeSet::new(),
                diagnostic_path: path.clone(),
                diagnostic_span: source_span(text),
            };
            match parse_expression(text, &path)
                .and_then(|expr| expand_lets(expr, &stage.let_bindings, &mut BTreeSet::new()))
                .and_then(|expr| infer(&expr, &scope))
            {
                Ok(ty) => {
                    fields.insert(field.clone(), ty);
                }
                Err(error) => {
                    has_field_error = true;
                    errors.push(error);
                }
            }
        }
        if !has_field_error {
            outcomes.insert(key, Type::Record { fields });
        }
    }
    if errors.is_empty() {
        Ok(outcomes)
    } else {
        Err(errors)
    }
}
