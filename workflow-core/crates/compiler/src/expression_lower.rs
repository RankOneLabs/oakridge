use super::*;
pub(crate) fn resolve(expression: &StageExpr) -> Expression {
    fn reference(root: ReferenceRoot, path: &[String]) -> Expression {
        Expression::Reference {
            root,
            path: path.to_vec(),
        }
    }
    fn artifact(key: &str) -> SymbolKey {
        SymbolKey::from(key)
    }
    let boxed = |inner: &StageExpr| Box::new(resolve(inner));
    match expression {
        StageExpr::Spanned(inner, _) => resolve(inner),
        StageExpr::Or(left, right) => Expression::Any {
            items: vec![resolve(left), resolve(right)],
        },
        StageExpr::And(left, right) => Expression::All {
            items: vec![resolve(left), resolve(right)],
        },
        StageExpr::Not(inner) => Expression::Not {
            value: boxed(inner),
        },
        StageExpr::Equality {
            is_negated,
            left,
            right,
        } => {
            let equals = Expression::Equals {
                left: boxed(left),
                right: boxed(right),
            };
            if *is_negated {
                Expression::Not {
                    value: Box::new(equals),
                }
            } else {
                equals
            }
        }
        StageExpr::Compare {
            operator,
            left,
            right,
        } => {
            let (left, right) = (boxed(left), boxed(right));
            match operator {
                Comparison::Greater => Expression::GreaterThan { left, right },
                Comparison::GreaterOrEqual => Expression::GreaterOrEqual { left, right },
                Comparison::Less => Expression::LessThan { left, right },
                Comparison::LessOrEqual => Expression::LessOrEqual { left, right },
            }
        }
        StageExpr::Len(inner) => Expression::Len {
            value: boxed(inner),
        },
        StageExpr::Published(key) => reference(
            ReferenceRoot::Published {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::Approved(key) => reference(
            ReferenceRoot::Approved {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::ChangesRequested(key) => reference(
            ReferenceRoot::ChangesRequested {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::Latest {
            artifact: key,
            path,
        } => reference(
            ReferenceRoot::Latest {
                artifact: artifact(key),
            },
            path,
        ),
        StageExpr::Every { source, predicate } => Expression::Every {
            source: boxed(source),
            predicate: boxed(predicate),
        },
        // any(xs, p) is not every(xs, not p).
        StageExpr::Any { source, predicate } => Expression::Not {
            value: Box::new(Expression::Every {
                source: boxed(source),
                predicate: Box::new(Expression::Not {
                    value: boxed(predicate),
                }),
            }),
        },
        StageExpr::Filter { source, predicate } => Expression::Filter {
            source: boxed(source),
            predicate: boxed(predicate),
        },
        StageExpr::MapOf { source, value } => {
            if let StageExpr::Name { head, path } = source.clone().into_unspanned() {
                if path.is_empty() {
                    if let StageExpr::Outcome { unit, path } = value.clone().into_unspanned() {
                        if head == unit {
                            return Expression::Map {
                                source: Box::new(reference(
                                    ReferenceRoot::MemberOutcomes {
                                        unit: SymbolKey::from(head.as_str()),
                                    },
                                    &[],
                                )),
                                value: Box::new(reference(ReferenceRoot::Item, &path)),
                            };
                        }
                    }
                }
            }
            Expression::Map {
                source: boxed(source),
                value: boxed(value),
            }
        }
        StageExpr::Contains { source, value } => Expression::Contains {
            source: boxed(source),
            value: boxed(value),
        },
        StageExpr::Lookup {
            source,
            field,
            key,
            path,
        } => path.iter().fold(
            Expression::Lookup {
                source: boxed(source),
                key_field: field.clone(),
                key: boxed(key),
            },
            |value, segment| Expression::Field {
                value: Box::new(value),
                key: segment.clone(),
            },
        ),
        StageExpr::Default {
            value,
            fallback,
            path,
        } => path.iter().fold(
            Expression::Default {
                value: boxed(value),
                fallback: boxed(fallback),
            },
            |value, segment| Expression::Field {
                value: Box::new(value),
                key: segment.clone(),
            },
        ),
        StageExpr::Require { value, path } => path.iter().fold(
            Expression::Require {
                value: boxed(value),
            },
            |value, segment| Expression::Field {
                value: Box::new(value),
                key: segment.clone(),
            },
        ),
        StageExpr::Field { value, path } => {
            path.iter()
                .fold(resolve(value), |value, segment| Expression::Field {
                    value: Box::new(value),
                    key: segment.clone(),
                })
        }
        StageExpr::ValidGraph {
            source,
            key_field,
            dependencies_field,
        } => Expression::CheckCollection {
            source: boxed(source),
            key_field: key_field.clone(),
            dependencies_field: dependencies_field.clone(),
        },
        StageExpr::Record(fields) => Expression::Record {
            fields: fields
                .iter()
                .map(|(key, value)| FieldExpression {
                    key: key.clone(),
                    value: resolve(value),
                })
                .collect(),
        },
        StageExpr::Input(path) => reference(ReferenceRoot::UnitInput, path),
        StageExpr::Each(path) => reference(ReferenceRoot::EachMember, path),
        StageExpr::Item(path) => reference(ReferenceRoot::Item, path),
        StageExpr::Name { head, path } => reference(
            ReferenceRoot::ValidationBody {
                artifact: artifact(head),
            },
            path,
        ),
        StageExpr::Outcome { unit, path } => reference(
            ReferenceRoot::UnitOutcome {
                unit: SymbolKey::from(unit.as_str()),
            },
            path,
        ),
        StageExpr::Boolean(value) => Expression::Literal {
            schema: SchemaId::from("boolean"),
            value: serde_json::Value::Bool(*value),
        },
        StageExpr::Integer(value) => Expression::Literal {
            schema: SchemaId::from("integer"),
            value: serde_json::Value::from(*value),
        },
        StageExpr::Text(value) => Expression::Literal {
            schema: SchemaId::from("text"),
            value: serde_json::Value::String(value.clone()),
        },
    }
}
