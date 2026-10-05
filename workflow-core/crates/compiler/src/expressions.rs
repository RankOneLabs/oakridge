use crate::{check_value, error, schema, unique, variants};
use workflow_model::*;
#[derive(Clone, Default)]
pub struct Context {
    pub guards: Vec<(ReferenceRoot, Vec<String>, String)>,
    pub item: Option<SchemaId>,
}
pub fn trigger_schema(owner: &ScopeDefinition) -> SchemaId {
    SchemaId(format!("$trigger/{}", owner.key))
}
pub fn boolean_schema(bundle: &DefinitionBundle) -> CoreResult<SchemaId> {
    bundle
        .schemas
        .iter()
        .find(|s| matches!(s.shape, SchemaShape::Boolean))
        .map(|s| s.key.clone())
        .ok_or_else(|| {
            error(
                DomainErrorKind::MissingSymbol,
                "boolean",
                "boolean expression requires a named boolean schema",
            )
        })
}
pub fn compatible(
    bundle: &DefinitionBundle,
    expected: &SchemaId,
    actual: &SchemaId,
    entity: &str,
) -> CoreResult<()> {
    if expected == actual {
        return Ok(());
    }
    let kind = if matches!(schema(bundle, actual)?, SchemaShape::Optional { .. }) {
        DomainErrorKind::UnguardedOptional
    } else if matches!(schema(bundle, expected)?, SchemaShape::Reference { .. })
        || matches!(schema(bundle, actual)?, SchemaShape::Reference { .. })
    {
        DomainErrorKind::WrongBrand
    } else {
        DomainErrorKind::IncompatiblePort
    };
    Err(error(
        kind,
        entity,
        "named schema IDs are not assignment-compatible",
    )
    .contracts(expected.to_string(), actual.to_string()))
}
pub fn compile_expression(
    bundle: &DefinitionBundle,
    owner: &ScopeDefinition,
    expression: &Expression,
    context: &Context,
    depth: usize,
) -> CoreResult<CheckedExpression> {
    if depth > bundle.limits.max_depth {
        return Err(error(
            DomainErrorKind::ResourceLimit,
            owner.key.to_string(),
            "expression exceeds nesting limit",
        ));
    }
    let recurse = |e: &Expression| compile_expression(bundle, owner, e, context, depth + 1);
    let bools = |items: &[Expression]| -> CoreResult<Vec<CheckedExpression>> {
        if items.is_empty() {
            return Err(error(
                DomainErrorKind::InvalidSchema,
                owner.key.to_string(),
                "empty boolean combination",
            ));
        }
        items
            .iter()
            .map(|e| {
                let c = recurse(e)?;
                compatible(bundle, &boolean_schema(bundle)?, &c.schema, &owner.key.0)?;
                Ok(c)
            })
            .collect()
    };
    let (result, node) = match expression {
        Expression::Literal { schema: key, value } => {
            let value = check_value(bundle, key, value)?;
            (key.clone(), CheckedExpressionNode::Literal { value })
        }
        Expression::Reference { root, path } => {
            return crate::references::compile_reference(bundle, owner, root, path, context)
        }
        Expression::Record {
            schema: key,
            fields: expressions,
        } => {
            let SchemaShape::Record { fields, dictionary } = schema(bundle, key)? else {
                return Err(error(
                    DomainErrorKind::InvalidAssignment,
                    key.to_string(),
                    "record constructor schema",
                ));
            };
            if dictionary.is_some() {
                return Err(error(
                    DomainErrorKind::InvalidAssignment,
                    key.to_string(),
                    "dictionary construction uses typed literals",
                ));
            }
            unique(expressions.iter().map(|e| e.key.as_str()), &key.0)?;
            let mut checked = Vec::new();
            for expr in expressions {
                let (index, field) = fields
                    .iter()
                    .enumerate()
                    .find(|(_, f)| f.key == expr.key)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::MissingSymbol,
                            &expr.key,
                            "record field undeclared",
                        )
                    })?;
                let value = recurse(&expr.value)?;
                compatible(bundle, &field.schema, &value.schema, &expr.key)?;
                checked.push(CheckedFieldExpression {
                    field_id: index,
                    value,
                });
            }
            if fields
                .iter()
                .enumerate()
                .any(|(i, f)| f.required && !checked.iter().any(|c| c.field_id == i))
            {
                return Err(error(
                    DomainErrorKind::MissingBinding,
                    key.to_string(),
                    "required record construction field missing",
                ));
            }
            (
                key.clone(),
                CheckedExpressionNode::Record { fields: checked },
            )
        }
        Expression::List { schema: key, items } => {
            let SchemaShape::List { item, max_items } = schema(bundle, key)? else {
                return Err(error(
                    DomainErrorKind::InvalidAssignment,
                    key.to_string(),
                    "list constructor schema",
                ));
            };
            if items.len() > *max_items {
                return Err(error(
                    DomainErrorKind::ResourceLimit,
                    key.to_string(),
                    "list constructor exceeds limit",
                ));
            }
            let checked = items
                .iter()
                .map(|e| {
                    let c = recurse(e)?;
                    compatible(bundle, item, &c.schema, &key.0)?;
                    Ok(c)
                })
                .collect::<CoreResult<_>>()?;
            (key.clone(), CheckedExpressionNode::List { items: checked })
        }
        Expression::Variant {
            schema: key,
            variant,
            value,
        } => {
            let SchemaShape::Union { variants } = schema(bundle, key)? else {
                return Err(error(
                    DomainErrorKind::InvalidAssignment,
                    key.to_string(),
                    "variant requires union schema",
                ));
            };
            let def = variants.iter().find(|v| v.key == *variant).ok_or_else(|| {
                error(
                    DomainErrorKind::InvalidAssignment,
                    key.to_string(),
                    "unknown variant",
                )
            })?;
            let value = recurse(value)?;
            compatible(bundle, &def.schema, &value.schema, &key.0)?;
            (
                key.clone(),
                CheckedExpressionNode::Variant {
                    variant: variant.clone(),
                    value: Box::new(value),
                },
            )
        }
        Expression::Equals { left, right } => {
            let left = recurse(left)?;
            let right = recurse(right)?;
            compatible(bundle, &left.schema, &right.schema, &owner.key.0)?;
            (
                boolean_schema(bundle)?,
                CheckedExpressionNode::Equals {
                    left: Box::new(left),
                    right: Box::new(right),
                },
            )
        }
        Expression::IsVariant { value, variant } => {
            let value = recurse(value)?;
            if !variants(bundle, &value.schema)?.contains(variant) {
                return Err(error(
                    DomainErrorKind::InvalidAssignment,
                    variant,
                    "variant not declared",
                ));
            }
            (
                boolean_schema(bundle)?,
                CheckedExpressionNode::IsVariant {
                    value: Box::new(value),
                    variant: variant.clone(),
                },
            )
        }
        Expression::All { items } => (
            boolean_schema(bundle)?,
            CheckedExpressionNode::All {
                items: bools(items)?,
            },
        ),
        Expression::Any { items } => (
            boolean_schema(bundle)?,
            CheckedExpressionNode::Any {
                items: bools(items)?,
            },
        ),
        Expression::Not { value } => {
            let value = recurse(value)?;
            compatible(
                bundle,
                &boolean_schema(bundle)?,
                &value.schema,
                &owner.key.0,
            )?;
            (
                boolean_schema(bundle)?,
                CheckedExpressionNode::Not {
                    value: Box::new(value),
                },
            )
        }
        Expression::Map {
            source,
            schema: key,
            value,
        } => {
            let source = recurse(source)?;
            let SchemaShape::List {
                item: input,
                max_items: source_max,
            } = schema(bundle, &source.schema)?
            else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    key.to_string(),
                    "map source is not a list",
                ));
            };
            let SchemaShape::List {
                item: output,
                max_items: target_max,
            } = schema(bundle, key)?
            else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    key.to_string(),
                    "map output is not a list",
                ));
            };
            if source_max > target_max {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    key.to_string(),
                    "map could exceed target cardinality",
                ));
            }
            let context = Context {
                item: Some(input.clone()),
                ..context.clone()
            };
            let value = compile_expression(bundle, owner, value, &context, depth + 1)?;
            compatible(bundle, output, &value.schema, &key.0)?;
            (
                key.clone(),
                CheckedExpressionNode::Map {
                    source: Box::new(source),
                    value: Box::new(value),
                },
            )
        }
        Expression::Every { source, predicate } => {
            let source = recurse(source)?;
            let SchemaShape::List { item, .. } = schema(bundle, &source.schema)? else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    owner.key.to_string(),
                    "quantifier source is not a list",
                ));
            };
            let context = Context {
                item: Some(item.clone()),
                ..context.clone()
            };
            let predicate = compile_expression(bundle, owner, predicate, &context, depth + 1)?;
            compatible(
                bundle,
                &boolean_schema(bundle)?,
                &predicate.schema,
                &owner.key.0,
            )?;
            (
                boolean_schema(bundle)?,
                CheckedExpressionNode::Every {
                    source: Box::new(source),
                    predicate: Box::new(predicate),
                },
            )
        }
    };
    Ok(CheckedExpression {
        schema: result,
        node,
    })
}
