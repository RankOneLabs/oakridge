use crate::failure;
use workflow_model::*;
pub struct EvaluationContext<'a> {
    pub program: &'a CheckedProgram,
    pub snapshot: &'a Snapshot,
    pub item: Option<&'a CheckedValue>,
    pub budget: &'a mut usize,
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
        CheckedExpressionNode::Literal { value } => return Ok(value.clone()),
        CheckedExpressionNode::Reference { root, selectors } => {
            let trigger = CheckedValue {
                schema: SchemaId(format!("$trigger/{}", context.snapshot.scope)),
                data: CheckedData::Variant {
                    variant: context.snapshot.trigger.key.0.clone(),
                    value: Box::new(context.snapshot.trigger.payload.clone()),
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
                                .and_then(|field| field.value.clone())
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
            return Ok(value.clone());
        }
        CheckedExpressionNode::Record { fields } => {
            let schema = context
                .program
                .source
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
        CheckedExpressionNode::Equals { left, right } => CheckedData::Boolean {
            value: evaluate_expression(left, context)? == evaluate_expression(right, context)?,
        },
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
