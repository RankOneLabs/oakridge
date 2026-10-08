use crate::failure;
use workflow_model::*;
pub struct EvaluationContext<'a> {
    pub program: &'a CheckedProgram,
    pub snapshot: &'a Snapshot,
    pub item: Option<&'a CheckedValue>,
    pub budget: &'a mut usize,
}
pub(crate) fn charge(budget: &mut usize, amount: usize, entity: &str) -> CoreResult<()> {
    if *budget < amount {
        return Err(failure(
            DomainErrorKind::ResourceLimit,
            entity,
            "expression budget exhausted",
        ));
    }
    *budget -= amount;
    Ok(())
}
fn value_size(value: &CheckedValue) -> usize {
    let nested = match &value.data {
        CheckedData::String { value } => value.len(),
        CheckedData::Enum { variant } => variant.len(),
        CheckedData::Reference { id, .. } => id.len(),
        CheckedData::Variant { variant, value } => variant.len().saturating_add(value_size(value)),
        CheckedData::Optional { value } => value.as_ref().map_or(0, |value| value_size(value)),
        CheckedData::List { items } => items
            .iter()
            .fold(0usize, |cost, item| cost.saturating_add(value_size(item))),
        CheckedData::Record { fields, dictionary } => {
            let fields_cost = fields.iter().fold(0usize, |cost, field| {
                cost.saturating_add(field.value.as_ref().map_or(1, value_size))
            });
            dictionary.iter().fold(fields_cost, |cost, entry| {
                cost.saturating_add(entry.key.len())
                    .saturating_add(value_size(&entry.value))
            })
        }
        CheckedData::Boolean { .. } | CheckedData::Integer { .. } => 0,
    };
    value
        .schema
        .0
        .len()
        .saturating_add(1)
        .saturating_add(nested)
}
pub(crate) fn value_cost(value: &CheckedValue) -> usize {
    // A budget unit covers at most 256 bytes of copy or comparison work.
    value_size(value).div_ceil(256).max(1)
}
pub(crate) fn clone_value(value: &CheckedValue, budget: &mut usize) -> CoreResult<CheckedValue> {
    charge(budget, value_cost(value), &value.schema.0)?;
    Ok(value.clone())
}
pub(crate) fn equal_values(
    left: &CheckedValue,
    right: &CheckedValue,
    budget: &mut usize,
) -> CoreResult<bool> {
    charge(
        budget,
        value_cost(left).saturating_add(value_cost(right)),
        &left.schema.0,
    )?;
    Ok(left == right)
}
pub fn boolean(value: &CheckedValue) -> CoreResult<bool> {
    if let CheckedData::Boolean { value } = &value.data {
        Ok(*value)
    } else {
        Err(failure(
            DomainErrorKind::InvalidSnapshot,
            value.schema.to_string(),
            "expected checked boolean",
        ))
    }
}
pub fn variant(value: &CheckedValue) -> CoreResult<String> {
    match &value.data {
        CheckedData::Variant { variant, .. } | CheckedData::Enum { variant } => Ok(variant.clone()),
        CheckedData::Optional { value } => Ok(if value.is_some() { "some" } else { "none" }.into()),
        CheckedData::Boolean { value } => Ok(value.to_string()),
        _ => Err(failure(
            DomainErrorKind::InvalidSnapshot,
            value.schema.to_string(),
            "expected finite variant",
        )),
    }
}
pub fn evaluate_expression(
    expression: &CheckedExpression,
    context: &mut EvaluationContext<'_>,
) -> CoreResult<CheckedValue> {
    if *context.budget == 0 {
        return Err(failure(
            DomainErrorKind::ResourceLimit,
            expression.schema.to_string(),
            "expression budget exhausted",
        ));
    }
    *context.budget -= 1;
    let data = match &expression.node {
        CheckedExpressionNode::Literal { value } => return clone_value(value, context.budget),
        CheckedExpressionNode::Reference { root, selectors } => {
            let trigger = CheckedValue {
                schema: SchemaId(format!("$trigger/{}", context.snapshot.scope)),
                data: CheckedData::Variant {
                    variant: context.snapshot.trigger.key.0.clone(),
                    value: Box::new(clone_value(
                        &context.snapshot.trigger.payload,
                        context.budget,
                    )?),
                },
            };
            let mut value = match root {
                ReferenceRoot::Input => &context.snapshot.input,
                ReferenceRoot::State => &context.snapshot.state,
                ReferenceRoot::Trigger => &trigger,
                ReferenceRoot::Item => context.item.ok_or_else(|| {
                    failure(
                        DomainErrorKind::InvalidSnapshot,
                        "item",
                        "missing lexical item",
                    )
                })?,
                _ => context
                    .snapshot
                    .observations
                    .iter()
                    .find(|o| o.root == *root)
                    .map(|o| &o.value)
                    .ok_or_else(|| {
                        failure(
                            DomainErrorKind::InvalidSnapshot,
                            context.snapshot.owner.to_string(),
                            "declared observation not supplied",
                        )
                    })?,
            };
            let mut optional_fields = Vec::new();
            for selector in selectors {
                if let Selector::OptionalField { index, schema } = selector {
                    let CheckedData::Record { fields, .. } = &value.data else {
                        return Err(failure(
                            DomainErrorKind::InvalidSnapshot,
                            schema.to_string(),
                            "optional field on nonrecord",
                        ));
                    };
                    optional_fields.push(CheckedValue {
                        schema: schema.clone(),
                        data: CheckedData::Optional {
                            value: fields
                                .iter()
                                .find(|field| field.field_id == *index)
                                .and_then(|field| field.value.as_ref())
                                .map(|value| clone_value(value, context.budget))
                                .transpose()?
                                .map(Box::new),
                        },
                    });
                    value = optional_fields.last().ok_or_else(|| {
                        failure(
                            DomainErrorKind::InvalidSnapshot,
                            schema.to_string(),
                            "optional field unavailable",
                        )
                    })?;
                    continue;
                }
                value = match (&value.data, selector) {
                    (CheckedData::Record { fields, .. }, Selector::Field { index }) => fields
                        .iter()
                        .find(|f| f.field_id == *index)
                        .and_then(|f| f.value.as_ref())
                        .ok_or_else(|| {
                            failure(
                                DomainErrorKind::InvalidSnapshot,
                                value.schema.to_string(),
                                "checked field missing",
                            )
                        })?,
                    (CheckedData::Optional { value: Some(inner) }, Selector::Optional) => inner,
                    (
                        CheckedData::Variant {
                            variant,
                            value: inner,
                        },
                        Selector::Variant { variant: expected },
                    ) if variant == expected => inner,
                    _ => {
                        return Err(failure(
                            DomainErrorKind::InvalidSnapshot,
                            value.schema.to_string(),
                            "reference does not satisfy checked selector",
                        ))
                    }
                };
            }
            return clone_value(value, context.budget);
        }
        CheckedExpressionNode::Record { fields } => {
            let schema = context
                .program
                .derived
                .schemas
                .iter()
                .find(|s| s.key == expression.schema)
                .ok_or_else(|| {
                    failure(
                        DomainErrorKind::MissingSymbol,
                        expression.schema.to_string(),
                        "schema missing",
                    )
                })?;
            let SchemaShape::Record {
                fields: definitions,
                ..
            } = &schema.shape
            else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    expression.schema.to_string(),
                    "expected record schema",
                ));
            };
            let mut values = Vec::new();
            for (field_id, _) in definitions.iter().enumerate() {
                let value = fields
                    .iter()
                    .find(|f| f.field_id == field_id)
                    .map(|f| evaluate_expression(&f.value, context))
                    .transpose()?;
                values.push(CheckedField { field_id, value });
            }
            CheckedData::Record {
                fields: values,
                dictionary: vec![],
            }
        }
        CheckedExpressionNode::List { items } => CheckedData::List {
            items: items
                .iter()
                .map(|e| evaluate_expression(e, context))
                .collect::<CoreResult<_>>()?,
        },
        CheckedExpressionNode::Variant { variant, value } => CheckedData::Variant {
            variant: variant.clone(),
            value: Box::new(evaluate_expression(value, context)?),
        },
        CheckedExpressionNode::Equals { left, right } => {
            let left = evaluate_expression(left, context)?;
            let right = evaluate_expression(right, context)?;
            CheckedData::Boolean {
                value: equal_values(&left, &right, context.budget)?,
            }
        }
        CheckedExpressionNode::IsVariant {
            value,
            variant: expected,
        } => CheckedData::Boolean {
            value: variant(&evaluate_expression(value, context)?)? == *expected,
        },
        CheckedExpressionNode::Not { value } => CheckedData::Boolean {
            value: !boolean(&evaluate_expression(value, context)?)?,
        },
        CheckedExpressionNode::All { items } => {
            let mut value = true;
            for expr in items {
                if !boolean(&evaluate_expression(expr, context)?)? {
                    value = false;
                    break;
                }
            }
            CheckedData::Boolean { value }
        }
        CheckedExpressionNode::Any { items } => {
            let mut value = false;
            for expr in items {
                if boolean(&evaluate_expression(expr, context)?)? {
                    value = true;
                    break;
                }
            }
            CheckedData::Boolean { value }
        }
        CheckedExpressionNode::Map { source, value } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "map source not list",
                ));
            };
            let mut result = Vec::new();
            for item in &items {
                charge(context.budget, 1, &expression.schema.0)?;
                let mut child = EvaluationContext {
                    program: context.program,
                    snapshot: context.snapshot,
                    item: Some(item),
                    budget: context.budget,
                };
                result.push(evaluate_expression(value, &mut child)?);
            }
            CheckedData::List { items: result }
        }
        CheckedExpressionNode::Optional { value } => CheckedData::Optional {
            value: value
                .as_ref()
                .map(|value| evaluate_expression(value, context))
                .transpose()?
                .map(Box::new),
        },
        CheckedExpressionNode::Field { value, index } => {
            let value = evaluate_expression(value, context)?;
            return clone_value(crate::collections::field(&value, *index)?, context.budget);
        }
        CheckedExpressionNode::FilterBy {
            source,
            key_field,
            key,
        } => {
            let collection = evaluate_expression(source, context)?;
            let key = evaluate_expression(key, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "filter_by source not list",
                ));
            };
            let mut filtered = Vec::new();
            for item in items {
                charge(context.budget, 1, &expression.schema.0)?;
                if equal_values(
                    crate::collections::field(&item, *key_field)?,
                    &key,
                    context.budget,
                )? {
                    filtered.push(item);
                }
            }
            CheckedData::List { items: filtered }
        }
        CheckedExpressionNode::Contains { source, value } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "contains source not list",
                ));
            };
            CheckedData::Boolean {
                value: {
                    let needle = evaluate_expression(value, context)?;
                    charge(context.budget, items.len(), &expression.schema.0)?;
                    let mut found = false;
                    for item in &items {
                        if equal_values(item, &needle, context.budget)? {
                            found = true;
                            break;
                        }
                    }
                    found
                },
            }
        }
        CheckedExpressionNode::Lookup {
            source,
            key_field,
            key,
        } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "lookup source not list",
                ));
            };
            let key = evaluate_expression(key, context)?;
            charge(context.budget, items.len(), &expression.schema.0)?;
            let mut matches = Vec::new();
            for item in &items {
                if equal_values(
                    crate::collections::field(item, *key_field)?,
                    &key,
                    context.budget,
                )? {
                    matches.push(item);
                }
            }
            if matches.len() != 1 {
                return Err(failure(
                    DomainErrorKind::InvalidTemplate,
                    source.schema.to_string(),
                    "lookup requires exactly one matching key",
                ));
            }
            return clone_value(matches[0], context.budget);
        }
        CheckedExpressionNode::Filter { source, predicate } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "filter source not list",
                ));
            };
            let mut filtered = Vec::new();
            for item in items {
                charge(context.budget, 1, &expression.schema.0)?;
                let mut child = EvaluationContext {
                    program: context.program,
                    snapshot: context.snapshot,
                    item: Some(&item),
                    budget: context.budget,
                };
                if boolean(&evaluate_expression(predicate, &mut child)?)? {
                    filtered.push(item);
                }
            }
            CheckedData::List { items: filtered }
        }
        CheckedExpressionNode::UniqueBy { source, key_field }
        | CheckedExpressionNode::CheckCollection {
            source, key_field, ..
        } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "constraint source not list",
                ));
            };
            if let CheckedExpressionNode::CheckCollection {
                dependencies_field, ..
            } = &expression.node
            {
                charge(
                    context.budget,
                    items.len().saturating_mul(items.len()),
                    &expression.schema.0,
                )?;
                crate::collections::validate_collection(
                    &items,
                    *key_field,
                    *dependencies_field,
                    context.budget,
                )?;
                CheckedData::List { items }
            } else {
                let mut unique: Vec<CheckedValue> = Vec::new();
                for item in items {
                    charge(context.budget, unique.len() + 1, &expression.schema.0)?;
                    let key = crate::collections::field(&item, *key_field)?;
                    let mut previous = None;
                    for candidate in &unique {
                        if equal_values(
                            crate::collections::field(candidate, *key_field)?,
                            key,
                            context.budget,
                        )? {
                            previous = Some(candidate);
                            break;
                        }
                    }
                    if let Some(previous) = previous {
                        if !equal_values(previous, &item, context.budget)? {
                            return Err(failure(
                                DomainErrorKind::InvalidTemplate,
                                source.schema.to_string(),
                                "same key carries inconsistent values",
                            ));
                        }
                    } else {
                        unique.push(item);
                    }
                }
                CheckedData::List { items: unique }
            }
        }
        CheckedExpressionNode::Every { source, predicate } => {
            let collection = evaluate_expression(source, context)?;
            let CheckedData::List { items } = collection.data else {
                return Err(failure(
                    DomainErrorKind::InvalidSnapshot,
                    source.schema.to_string(),
                    "quantifier source not list",
                ));
            };
            let mut value = true;
            for item in &items {
                charge(context.budget, 1, &expression.schema.0)?;
                let mut child = EvaluationContext {
                    program: context.program,
                    snapshot: context.snapshot,
                    item: Some(item),
                    budget: context.budget,
                };
                if !boolean(&evaluate_expression(predicate, &mut child)?)? {
                    value = false;
                    break;
                }
            }
            CheckedData::Boolean { value }
        }
    };
    Ok(CheckedValue {
        schema: expression.schema.clone(),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use workflow_compiler::{check_value, compile};

    #[test]
    fn contains_charges_for_each_comparison() {
        let bundle: DefinitionBundle =
            serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap();
        let program = compile(&bundle, &bundle.operations).unwrap();
        let unit = check_value(&bundle, &SchemaId::from("unit"), &serde_json::json!({})).unwrap();
        let snapshot = Snapshot {
            owner: InstanceId::from("scope"),
            scope: ScopeKey::from("document"),
            version: 1,
            input: unit.clone(),
            state: check_value(
                &bundle,
                &SchemaId::from("position"),
                &serde_json::json!({"kind":"ready","value":{}}),
            )
            .unwrap(),
            trigger: Trigger {
                id: TriggerId::from("start"),
                key: SymbolKey::from("begin"),
                payload: unit,
            },
            observations: vec![],
            timestamp_ms: 1,
            random_seed: 1,
        };
        let item = check_value(
            &bundle,
            &SchemaId::from("ident"),
            &serde_json::json!("different"),
        )
        .unwrap();
        let source = CheckedExpression {
            schema: SchemaId::from("deps"),
            node: CheckedExpressionNode::Literal {
                value: CheckedValue {
                    schema: SchemaId::from("deps"),
                    data: CheckedData::List {
                        items: vec![item.clone(); 20],
                    },
                },
            },
        };
        let needle = CheckedExpression {
            schema: SchemaId::from("ident"),
            node: CheckedExpressionNode::Literal { value: item },
        };
        let expression = CheckedExpression {
            schema: SchemaId::from("flag"),
            node: CheckedExpressionNode::Contains {
                source: Box::new(source),
                value: Box::new(needle),
            },
        };
        let mut budget = 3;
        let mut context = EvaluationContext {
            program: &program,
            snapshot: &snapshot,
            item: None,
            budget: &mut budget,
        };
        assert_eq!(
            evaluate_expression(&expression, &mut context)
                .unwrap_err()
                .kind,
            DomainErrorKind::ResourceLimit
        );
    }

    #[test]
    fn large_literal_clone_exhausts_evaluation_budget() {
        let bundle: DefinitionBundle =
            serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap();
        let program = compile(&bundle, &bundle.operations).unwrap();
        let unit = check_value(&bundle, &SchemaId::from("unit"), &serde_json::json!({})).unwrap();
        let snapshot = Snapshot {
            owner: InstanceId::from("scope"),
            scope: ScopeKey::from("document"),
            version: 1,
            input: unit.clone(),
            state: check_value(
                &bundle,
                &SchemaId::from("position"),
                &serde_json::json!({"kind":"ready","value":{}}),
            )
            .unwrap(),
            trigger: Trigger {
                id: TriggerId::from("begin"),
                key: SymbolKey::from("begin"),
                payload: unit,
            },
            observations: vec![],
            timestamp_ms: 1,
            random_seed: 1,
        };
        let value = check_value(
            &bundle,
            &SchemaId::from("text"),
            &serde_json::json!("x".repeat(1000)),
        )
        .unwrap();
        let expression = CheckedExpression {
            schema: SchemaId::from("text"),
            node: CheckedExpressionNode::Literal { value },
        };
        let mut budget = 3;
        let mut context = EvaluationContext {
            program: &program,
            snapshot: &snapshot,
            item: None,
            budget: &mut budget,
        };
        assert_eq!(
            evaluate_expression(&expression, &mut context)
                .unwrap_err()
                .kind,
            DomainErrorKind::ResourceLimit
        );
    }
}
