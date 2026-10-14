use super::*;
pub(super) fn compile_group(
    group: &Group,
    input: &TypeExpression,
    stage_outcomes: &BTreeMap<String, TypeExpression>,
    workflow: &Workflow,
) -> Result<(CheckedGroup, TypeExpression), DomainError> {
    let group_path = current_path();
    for (key, unit) in &group.units {
        set_path(format!("{group_path}.units.{key}"));
        if unit.stage.is_some() == unit.group.is_some() {
            return Err(failure(
                2,
                format!("unit {key} needs exactly one stage or group"),
            ));
        }
        if unit.for_each.is_some() != unit.key.is_some() {
            return Err(failure(2, format!("collection {key} needs key")));
        }
        if let Some(pool) = &unit.pool {
            if group
                .pools
                .get(&pool.0)
                .is_none_or(|capacity| *capacity == 0)
            {
                return Err(failure(1, format!("pool {pool} absent or empty")));
            }
        }
        if let UnitDependencies::Fixed(after) = &unit.after {
            for dependency in after {
                let Some(prerequisite) = group.units.get(&dependency.0) else {
                    return Err(failure(1, format!("unit {dependency} absent")));
                };
                // Members are units of their own, `group/<key>`: no unit is the collection.
                if prerequisite.for_each.is_some() {
                    return Err(failure(
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
            return Err(failure(
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
            return Err(failure(5, format!("dependency cycle through {key}")));
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
        set_path(format!("{group_path}.units.{key}"));
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
            set_path(format!("{group_path}.units.{key}.for_each"));
            let source = checked(source, &scope)?;
            let each = item_type(&resolve_type(&source.value_type, &workflow.schemas))
                .ok_or_else(|| failure(2, format!("collection {key} source is not list")))?;
            scope.each = Some(each);
            set_path(format!("{group_path}.units.{key}.key"));
            let key_expr = checked(unit.key.as_ref().unwrap(), &scope)?;
            if key_expr.value_type != Type::Ident && key_expr.value_type != Type::Text {
                return Err(failure(2, "collection key is not text"));
            }
            let after = match &unit.after {
                UnitDependencies::Each(text) => checked(text, &scope)?,
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
            let dependency_type = item_type(&resolve_type(&after.value_type, &workflow.schemas));
            if !matches!(dependency_type, Some(Type::Ident | Type::Text)) {
                return Err(failure(
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
        set_path(format!("{group_path}.units.{key}.input"));
        let checked_input = fields(&unit.input, &scope)?;
        set_path(format!("{group_path}.units.{key}"));
        let input_type = checked_record(&checked_input);
        let (nested, outcome_type) = if let Some(stage) = &unit.stage {
            let target = workflow
                .stages
                .get(&stage.0)
                .ok_or_else(|| failure(1, format!("stage {stage} absent")))?;
            if resolve_type(&input_type, &workflow.schemas)
                != resolve_type(&target.input, &workflow.schemas)
            {
                return Err(failure(
                    6,
                    format!("unit {key} input does not match stage {stage}"),
                ));
            }
            (
                None,
                stage_outcomes
                    .get(&stage.0)
                    .cloned()
                    .ok_or_else(|| failure(1, "stage outcome absent"))?,
            )
        } else {
            set_path(format!("{group_path}.units.{key}.group"));
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
            stage: unit.stage.clone(),
            pool: unit.pool.clone(),
            after: match &unit.after {
                UnitDependencies::None => CheckedUnitDependencies::None,
                UnitDependencies::Fixed(keys) => {
                    CheckedUnitDependencies::Fixed { keys: keys.clone() }
                }
                UnitDependencies::Each(_) => CheckedUnitDependencies::Each,
            },
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
        set_path(format!("{group_path}.outcome.{key}"));
        let value = if let Ok(crate::expressions::StageExpr::MapOf {
            source: collection_expr,
            value: projection_expr,
        }) = crate::expressions::parse_expression(source)
        {
            let (collection, path) = match *collection_expr {
                crate::expressions::StageExpr::Name { head, path } => (head, path),
                crate::expressions::StageExpr::Item(path) => ("item".into(), path),
                _ => return Err(failure(4, "map collection absent")),
            };
            if !path.is_empty() {
                return Err(failure(4, "map collection absent"));
            }
            let (unit, projection_path) = match *projection_expr {
                crate::expressions::StageExpr::Outcome { unit, path } => (unit, path),
                crate::expressions::StageExpr::Item(mut path)
                    if path.first().is_some_and(|part| part == "outcome") =>
                {
                    path.remove(0);
                    ("item".into(), path)
                }
                _ => return Err(failure(4, "map projection outside outcome")),
            };
            if unit != collection {
                return Err(failure(4, "map projection outside outcome"));
            }
            let member = outcomes
                .get(&collection)
                .ok_or_else(|| failure(4, "map collection absent"))?;
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
                .ok_or_else(|| failure(4, "map field absent"))?
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
            pools: group.pools.clone(),
            units: checked_units,
            outcome: checked_outcome,
        },
        outcome_type,
    ))
}
