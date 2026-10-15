use super::*;
use crate::expressions::{parse_expression, StageExpr};

fn read_units(expr: &StageExpr, found: &mut BTreeSet<String>) {
    match expr {
        StageExpr::Spanned(inner, _)
        | StageExpr::Not(inner)
        | StageExpr::Len(inner)
        | StageExpr::Require { value: inner, .. }
        | StageExpr::Field { value: inner, .. } => read_units(inner, found),
        StageExpr::Outcome { unit, .. } => {
            found.insert(unit.clone());
        }
        StageExpr::Or(left, right)
        | StageExpr::And(left, right)
        | StageExpr::Equality { left, right, .. }
        | StageExpr::Compare { left, right, .. } => {
            read_units(left, found);
            read_units(right, found);
        }
        StageExpr::Every { source, predicate }
        | StageExpr::Any { source, predicate }
        | StageExpr::Filter { source, predicate } => {
            read_units(source, found);
            read_units(predicate, found);
        }
        StageExpr::MapOf { source, value } | StageExpr::Contains { source, value } => {
            if let StageExpr::Name { head, path } = source.clone().into_unspanned() {
                if path.is_empty() {
                    found.insert(head);
                }
            }
            read_units(source, found);
            read_units(value, found);
        }
        StageExpr::Lookup { source, key, .. } => {
            read_units(source, found);
            read_units(key, found);
        }
        StageExpr::Default {
            value, fallback, ..
        } => {
            read_units(value, found);
            read_units(fallback, found);
        }
        StageExpr::ValidGraph { source, .. } => read_units(source, found),
        StageExpr::Record(fields) => {
            for (_, value) in fields {
                read_units(value, found);
            }
        }
        _ => {}
    }
}
fn inferred_after(unit: &Unit) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for text in unit
        .input
        .values()
        .chain(unit.for_each.iter())
        .chain(unit.key.iter())
    {
        if let Ok(expression) = parse_expression(text, "") {
            read_units(&expression, &mut found);
        }
    }
    found
}
fn after_keys(unit: &Unit) -> Vec<SymbolKey> {
    let mut keys = inferred_after(unit);
    if let UnitDependencies::Fixed(explicit) = &unit.after {
        keys.extend(explicit.iter().map(|key| key.0.clone()));
    }
    keys.into_iter()
        .map(|key| SymbolKey::from(key.as_str()))
        .collect()
}
pub(super) struct GroupErrors(pub(super) Vec<CompileError>);
impl From<CompileError> for GroupErrors {
    fn from(error: CompileError) -> Self {
        Self(vec![error])
    }
}
impl From<Vec<CompileError>> for GroupErrors {
    fn from(errors: Vec<CompileError>) -> Self {
        Self(errors)
    }
}
/// Structural group checks run once in the check pass before lowering any
/// dependent unit expressions.
pub(super) fn check_structure(
    group: &Group,
    path: &str,
    workflow: &Workflow,
    errors: &mut Vec<CompileError>,
) {
    macro_rules! report {
        ($check:expr, $path:expr, $detail:expr) => {{
            let location = $path;
            errors.push(CompileError::new(
                $check,
                &location,
                workflow_span(workflow, &location),
                $detail,
            ));
        }};
    }
    for (key, unit) in &group.units {
        let unit_path = format!("{path}.units.{key}");
        if unit.stage.is_some() == unit.group.is_some() {
            report!(
                CheckKind::Collection,
                unit_path.clone(),
                format!("unit {key} needs exactly one stage or group")
            );
        }
        if unit.for_each.is_some() != unit.key.is_some() {
            report!(
                CheckKind::Collection,
                format!("{unit_path}.key"),
                format!("collection {key} needs key")
            );
        }
        if let Some(pool) = &unit.pool {
            if group
                .pools
                .get(&pool.0)
                .is_none_or(|capacity| *capacity == 0)
            {
                report!(
                    CheckKind::Name,
                    format!("{unit_path}.pool"),
                    format!("pool {pool} absent or empty")
                );
            }
        }
        if let UnitDependencies::Fixed(after) = &unit.after {
            for dependency in after {
                if inferred_after(unit).contains(&dependency.0) {
                    report!(
                        CheckKind::Scope,
                        format!("{unit_path}.after"),
                        format!("unit {key} explicitly repeats inferred dependency {dependency}")
                    );
                }
                match group.units.get(&dependency.0) {
                    None => report!(
                        CheckKind::Name,
                        format!("{unit_path}.after"),
                        format!("unit {dependency} absent")
                    ),
                    Some(prerequisite) if prerequisite.for_each.is_some() => report!(
                        CheckKind::Collection,
                        format!("{unit_path}.after"),
                        format!(
                            "unit {key} waits on collection {dependency}, which is no one unit"
                        )
                    ),
                    Some(_) => {}
                }
            }
        }
        for dependency in inferred_after(unit) {
            if !group.units.contains_key(&dependency) {
                report!(
                    CheckKind::Name,
                    format!("{unit_path}.input"),
                    format!("unit {dependency} absent")
                );
            }
        }
        if let Some(nested) = &unit.group {
            check_structure(nested, &format!("{unit_path}.group"), workflow, errors);
        }
    }
}
pub(super) fn compile_group(
    group: &Group,
    input: &TypeExpression,
    stage_outcomes: &BTreeMap<String, TypeExpression>,
    workflow: &Workflow,
    path: &str,
) -> Result<(CheckedGroup, TypeExpression), GroupErrors> {
    let group_path = path.to_owned();
    fn visit(
        key: &str,
        group: &Group,
        workflow: &Workflow,
        group_path: &str,
        visiting: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) -> Result<(), CompileError> {
        if done.contains(key) {
            return Ok(());
        }
        if !visiting.insert(key.to_owned()) {
            let path = format!("{group_path}.units.{key}.after");
            return Err(CompileError::new(
                CheckKind::DependencyCycle,
                &path,
                workflow_span(workflow, &path),
                format!("dependency cycle through {key}"),
            ));
        }
        if let Some(unit) = group.units.get(key) {
            for dependency in after_keys(unit) {
                visit(
                    &dependency.0,
                    group,
                    workflow,
                    group_path,
                    visiting,
                    done,
                    order,
                )?;
            }
        }
        visiting.remove(key);
        done.insert(key.to_owned());
        order.push(key.to_owned());
        Ok(())
    }
    let mut order = Vec::new();
    let mut done = BTreeSet::new();
    let mut cycles: Vec<CompileError> = Vec::new();
    for key in group.units.keys() {
        let mut visiting = BTreeSet::new();
        if let Err(error) = visit(
            key,
            group,
            workflow,
            &group_path,
            &mut visiting,
            &mut done,
            &mut order,
        ) {
            if !cycles.iter().any(|prior| prior.path == error.path) {
                cycles.push(error);
            }
        }
    }
    if !cycles.is_empty() {
        return Err(GroupErrors(cycles));
    }
    let empty = BTreeMap::new();
    let empty_lets = BTreeMap::<String, String>::new();
    let mut outcomes = BTreeMap::<String, TypeExpression>::new();
    let mut checked_units = Vec::new();
    let mut errors = Vec::new();
    let mut failed_units = BTreeSet::new();
    for key in &order {
        if after_keys(&group.units[key])
            .iter()
            .any(|dependency| failed_units.contains(&dependency.0))
        {
            failed_units.insert(key.clone());
            continue;
        }
        let result = (|| -> Result<(CheckedUnit, TypeExpression), GroupErrors> {
            let mut diagnostic_path: String;
            let unit = &group.units[key];
            let after_keys = after_keys(unit);
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
                lets: &empty_lets,
                body: None,
                guaranteed: BTreeSet::new(),
                collections: group
                    .units
                    .iter()
                    .filter(|(_, sibling)| sibling.for_each.is_some())
                    .map(|(key, _)| key.clone())
                    .collect(),
                diagnostic_path: String::new(),
                diagnostic_span: SourceSpan::default(),
            };
            let collection = if let Some(source) = &unit.for_each {
                diagnostic_path = (format!("{group_path}.units.{key}.for_each")).to_string();
                let source = checked(source, &scope, &diagnostic_path)?;
                let each = item_type(&resolve_type(&source.value_type, &workflow.schemas))
                    .ok_or_else(|| {
                        CompileError::new(
                            CheckKind::Collection,
                            &diagnostic_path,
                            workflow_span(workflow, &diagnostic_path),
                            format!("collection {key} source is not list"),
                        )
                    })?;
                scope.each = Some(each);
                diagnostic_path = (format!("{group_path}.units.{key}.key")).to_string();
                let key_expr = checked(unit.key.as_ref().unwrap(), &scope, &diagnostic_path)?;
                if key_expr.value_type != Type::Ident && key_expr.value_type != Type::Text {
                    return Err(CompileError::new(
                        CheckKind::Collection,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        "collection key is not text",
                    )
                    .into());
                }
                let after = match &unit.after {
                    UnitDependencies::Each(text) => {
                        checked(text, &scope, &format!("{group_path}.units.{key}.after"))?
                    }
                    _ => CheckedStageExpression {
                        source: "[]".into(),
                        value_type: Type::List {
                            item: Box::new(Type::Ident),
                        },
                        expression: Expression::List {
                            schema: SchemaId::from("list(ident)"),
                            items: vec![],
                        },
                    },
                };
                let dependency_type =
                    item_type(&resolve_type(&after.value_type, &workflow.schemas));
                if !matches!(dependency_type, Some(Type::Ident | Type::Text)) {
                    return Err(CompileError::new(
                        CheckKind::Collection,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        "collection after must be list(ident) or list(text)",
                    )
                    .into());
                }
                Some(CheckedUnitCollection {
                    source,
                    key: key_expr,
                    after,
                })
            } else {
                None
            };
            diagnostic_path = (format!("{group_path}.units.{key}.input")).to_string();
            let checked_input = fields(&unit.input, &scope, &diagnostic_path)?;
            diagnostic_path = (format!("{group_path}.units.{key}")).to_string();
            let input_type = checked_record(&checked_input);
            let (nested, outcome_type) = if let Some(stage) = &unit.stage {
                let target = workflow.stages.get(&stage.0).ok_or_else(|| {
                    CompileError::new(
                        CheckKind::Name,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        format!("stage {stage} absent"),
                    )
                })?;
                if resolve_type(&input_type, &workflow.schemas)
                    != resolve_type(&target.input, &workflow.schemas)
                {
                    return Err(CompileError::new(
                        CheckKind::Workspace,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        format!("unit {key} input does not match stage {stage}"),
                    )
                    .into());
                }
                (
                    None,
                    stage_outcomes.get(&stage.0).cloned().ok_or_else(|| {
                        CompileError::new(
                            CheckKind::Name,
                            &diagnostic_path,
                            workflow_span(workflow, &diagnostic_path),
                            "stage outcome absent",
                        )
                    })?,
                )
            } else {
                diagnostic_path = (format!("{group_path}.units.{key}.group")).to_string();
                let (nested, outcome_type) = compile_group(
                    unit.group.as_ref().unwrap(),
                    &input_type,
                    stage_outcomes,
                    workflow,
                    &diagnostic_path,
                )?;
                (Some(Box::new(nested)), outcome_type)
            };
            Ok((
                CheckedUnit {
                    key: SymbolKey::from(key.as_str()),
                    input: checked_input,
                    stage: unit.stage.clone(),
                    pool: unit.pool.clone(),
                    after: match &unit.after {
                        UnitDependencies::Each(_) => CheckedUnitDependencies::Each,
                        _ if after_keys.is_empty() => CheckedUnitDependencies::None,
                        _ => CheckedUnitDependencies::Fixed {
                            keys: after_keys.clone(),
                        },
                    },
                    collection,
                    group: nested,
                },
                outcome_type,
            ))
        })();
        match result {
            Ok((unit, outcome_type)) => {
                outcomes.insert(key.clone(), outcome_type);
                checked_units.push(unit);
            }
            Err(group_errors) => {
                failed_units.insert(key.clone());
                errors.extend(group_errors.0);
            }
        }
    }
    if !errors.is_empty() {
        return Err(GroupErrors(errors));
    }
    let scope = Scope {
        input,
        artifacts: &empty,
        outcomes: &outcomes,
        each: None,
        item: None,
        aliases: &workflow.schemas,
        lets: &empty_lets,
        body: None,
        guaranteed: BTreeSet::new(),
        collections: group
            .units
            .iter()
            .filter(|(_, unit)| unit.for_each.is_some())
            .map(|(key, _)| key.clone())
            .collect(),
        diagnostic_path: String::new(),
        diagnostic_span: SourceSpan::default(),
    };
    let mut checked_outcome = Vec::new();
    for (key, source) in &group.outcome {
        let result = (|| -> Result<CheckedStageExpression, GroupErrors> {
            let diagnostic_path = format!("{group_path}.outcome.{key}");
            let value = if let Ok(crate::expressions::StageExpr::MapOf {
                source: collection_expr,
                value: projection_expr,
            }) = crate::expressions::parse_expression(source, &diagnostic_path)
            {
                let (collection, path) = match (*collection_expr).into_unspanned() {
                    crate::expressions::StageExpr::Name { head, path } => (head, path),
                    crate::expressions::StageExpr::Item(path) => ("item".into(), path),
                    _ => {
                        return Err(CompileError::new(
                            CheckKind::Outcome,
                            &diagnostic_path,
                            workflow_span(workflow, &diagnostic_path),
                            "map collection absent",
                        )
                        .into())
                    }
                };
                if !path.is_empty() {
                    return Err(CompileError::new(
                        CheckKind::Outcome,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        "map collection absent",
                    )
                    .into());
                }
                let (unit, projection_path) = match (*projection_expr).into_unspanned() {
                    crate::expressions::StageExpr::Outcome { unit, path } => (unit, path),
                    crate::expressions::StageExpr::Item(mut path)
                        if path.first().is_some_and(|part| part == "outcome") =>
                    {
                        path.remove(0);
                        ("item".into(), path)
                    }
                    _ => {
                        return Err(CompileError::new(
                            CheckKind::Outcome,
                            &diagnostic_path,
                            workflow_span(workflow, &diagnostic_path),
                            "map projection outside outcome",
                        )
                        .into())
                    }
                };
                if unit != collection {
                    return Err(CompileError::new(
                        CheckKind::Outcome,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        "map projection outside outcome",
                    )
                    .into());
                }
                let member = outcomes.get(&collection).ok_or_else(|| {
                    CompileError::new(
                        CheckKind::Outcome,
                        &diagnostic_path,
                        workflow_span(workflow, &diagnostic_path),
                        "map collection absent",
                    )
                })?;
                let item = if projection_path.is_empty() {
                    member.clone()
                } else {
                    field_type(
                        member,
                        &projection_path
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        &workflow.schemas,
                    )
                    .ok_or_else(|| {
                        CompileError::new(
                            CheckKind::Outcome,
                            &diagnostic_path,
                            workflow_span(workflow, &diagnostic_path),
                            "map field absent",
                        )
                    })?
                };
                let item_type = Type::List {
                    item: Box::new(item),
                };
                CheckedStageExpression {
                    source: source.clone(),
                    expression: Expression::Map {
                        source: Box::new(Expression::Reference {
                            root: ReferenceRoot::MemberOutcomes {
                                unit: SymbolKey::from(collection.as_str()),
                            },
                            path: vec![],
                        }),
                        value: Box::new(Expression::Reference {
                            root: ReferenceRoot::Item,
                            path: projection_path,
                        }),
                    },
                    value_type: item_type,
                }
            } else {
                checked(source, &scope, &diagnostic_path)?
            };
            Ok(value)
        })();
        match result {
            Ok(value) => checked_outcome.push(CheckedNamedExpression {
                key: key.clone(),
                value,
            }),
            Err(group_errors) => errors.extend(group_errors.0),
        }
    }
    if !errors.is_empty() {
        return Err(GroupErrors(errors));
    }
    let outcome_type = checked_record(&checked_outcome);
    Ok((
        CheckedGroup {
            pools: group.pools.clone(),
            units: checked_units,
            outcome: checked_outcome,
        },
        outcome_type,
    ))
}
