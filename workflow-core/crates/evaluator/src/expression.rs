use super::*;
pub(super) fn path(value: &Value, parts: &[&str]) -> Option<Value> {
    let mut current = value;
    for part in parts {
        current = current.get(*part)?;
    }
    Some(current.clone())
}
/// What names are bound while an expression is walked: the collection
/// member (`each`), the list element inside a list function (`item`), and
/// the body a validate check binds to its artifact's key.
#[derive(Clone, Copy)]
pub(super) struct Bindings<'a> {
    each: Option<&'a Value>,
    item: Option<&'a Value>,
    body: Option<(&'a str, &'a Value)>,
}
/// Walk a resolved stage expression. The compiler already type-checked it,
/// so an unresolvable read is None rather than an error.
pub fn eval_expression(
    expression: &Expression,
    unit: &UnitState,
    state: &StepSnapshot,
    each: Option<&Value>,
    own_body: Option<(&str, &Value)>,
    context: &mut EvaluationContext<'_>,
) -> Result<Option<Value>, EvalError> {
    let bindings = Bindings {
        each,
        item: None,
        body: own_body,
    };
    let result = eval_expression_inner(expression, unit, state, bindings, context)?;
    if let Some(value) = &result {
        context.check_value(value)?;
    }
    Ok(result)
}
pub(super) fn eval_expression_inner(
    expression: &Expression,
    unit: &UnitState,
    state: &StepSnapshot,
    bindings: Bindings<'_>,
    context: &mut EvaluationContext<'_>,
) -> Result<Option<Value>, EvalError> {
    context.charge()?;
    fn decided(
        state: &StepSnapshot,
        unit: &UnitState,
        artifact: &SymbolKey,
        is_request_changes: bool,
    ) -> Value {
        Value::Bool(latest(state, &unit.id, artifact).is_some_and(|revision| {
            state.decisions.iter().any(|decision| {
                decision.unit() == &unit.id
                    && decision.target() == &revision.id
                    && decision.effect().is_some_and(|effect| {
                        matches!(effect, DecisionEffect::RequestChanges { .. })
                            == is_request_changes
                    })
            })
        }))
    }
    macro_rules! resolved {
        ($value:expr) => {
            match $value {
                Some(value) => value,
                None => return Ok(None),
            }
        };
    }
    macro_rules! eval {
        ($inner:expr) => {
            eval_expression_inner($inner, unit, state, bindings, context)?
        };
    }
    macro_rules! eval_item {
        ($inner:expr, $item:expr) => {{
            let bound = Bindings {
                item: Some($item),
                ..bindings
            };
            eval_expression_inner($inner, unit, state, bound, context)?
        }};
    }
    macro_rules! boolean {
        ($inner:expr) => {
            resolved!(resolved!(eval!($inner)).as_bool())
        };
    }
    macro_rules! list {
        ($inner:expr) => {{
            let Value::Array(items) = resolved!(eval!($inner)) else {
                return Ok(None);
            };
            context.check_list_len(items.len())?;
            items
        }};
    }
    macro_rules! integers {
        ($left:expr, $right:expr) => {
            (
                resolved!(resolved!(eval!($left)).as_i64()),
                resolved!(resolved!(eval!($right)).as_i64()),
            )
        };
    }
    Ok(match expression {
        Expression::Literal { value, .. } => Some(value.clone()),
        Expression::Len { value } => Some(Value::from(match resolved!(eval!(value)) {
            Value::String(text) => text.chars().count(),
            Value::Array(items) => items.len(),
            _ => return Ok(None),
        })),
        Expression::GreaterThan { left, right } => {
            let (left, right) = integers!(left, right);
            Some(Value::Bool(left > right))
        }
        Expression::GreaterOrEqual { left, right } => {
            let (left, right) = integers!(left, right);
            Some(Value::Bool(left >= right))
        }
        Expression::LessThan { left, right } => {
            let (left, right) = integers!(left, right);
            Some(Value::Bool(left < right))
        }
        Expression::LessOrEqual { left, right } => {
            let (left, right) = integers!(left, right);
            Some(Value::Bool(left <= right))
        }
        // `a and b` reads b only where a holds, so a false a short-circuits
        // and an unresolved a leaves the conjunction unresolved.
        Expression::All { items } => {
            for item in items {
                if !boolean!(item) {
                    return Ok(Some(Value::Bool(false)));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Any { items } => {
            for item in items {
                if boolean!(item) {
                    return Ok(Some(Value::Bool(true)));
                }
            }
            Some(Value::Bool(false))
        }
        Expression::Not { value } => Some(Value::Bool(!boolean!(value))),
        Expression::Equals { left, right } => Some(Value::Bool(
            resolved!(eval!(left)) == resolved!(eval!(right)),
        )),
        Expression::Every { source, predicate } => {
            for item in list!(source) {
                if !resolved!(resolved!(eval_item!(predicate, &item)).as_bool()) {
                    return Ok(Some(Value::Bool(false)));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Filter { source, predicate } => {
            let mut kept = Vec::new();
            for item in list!(source) {
                if resolved!(resolved!(eval_item!(predicate, &item)).as_bool()) {
                    kept.push(item);
                }
            }
            Some(Value::Array(kept))
        }
        Expression::Contains { source, value } => {
            let value = resolved!(eval!(value));
            Some(Value::Bool(list!(source).contains(&value)))
        }
        Expression::Lookup {
            source,
            key_field,
            key,
        } => {
            let key = resolved!(eval!(key));
            let mut matches = list!(source)
                .into_iter()
                .filter(|item| item.get(key_field) == Some(&key));
            let found = resolved!(matches.next());
            // Exactly one: an ambiguous key resolves to nothing.
            matches.next().is_none().then_some(found)
        }
        Expression::Field { value, key } => resolved!(eval!(value)).get(key).cloned(),
        Expression::CheckCollection {
            source,
            key_field,
            dependencies_field,
        } => Some(Value::Bool(is_valid_graph(
            &list!(source),
            key_field,
            dependencies_field,
        ))),
        Expression::Record { fields, .. } => {
            let mut record = serde_json::Map::new();
            for field in fields {
                record.insert(field.key.clone(), resolved!(eval!(&field.value)));
            }
            Some(Value::Object(record))
        }
        Expression::List { items, .. } => {
            context.check_list_len(items.len())?;
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                values.push(resolved!(eval!(item)));
            }
            Some(Value::Array(values))
        }
        Expression::Map {
            source,
            value: projection,
            ..
        } => {
            let source = list!(source);
            let mut values = Vec::with_capacity(source.len());
            for item in &source {
                values.push(resolved!(eval_item!(projection, item)));
            }
            Some(Value::Array(values))
        }
        Expression::Reference {
            root,
            path: segments,
        } => {
            let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
            let read = |value: &Value| -> Option<Value> {
                if parts.is_empty() {
                    Some(value.clone())
                } else {
                    path(value, &parts)
                }
            };
            match root {
                ReferenceRoot::UnitInput => match &unit.input {
                    Some(input) => read(input),
                    // A launched root always has resolved input. JSON null becomes
                    // None when Option<Value> is deserialized from a snapshot.
                    None if unit.id == state.run.root => read(&Value::Null),
                    None => None,
                },
                ReferenceRoot::EachMember => read(resolved!(bindings.each)),
                ReferenceRoot::Item => read(resolved!(bindings.item)),
                ReferenceRoot::ValidationBody { artifact } => {
                    let (bound, body) = resolved!(bindings.body);
                    (bound == artifact.0).then(|| read(body)).flatten()
                }
                ReferenceRoot::Latest { artifact } => {
                    read(&resolved!(latest(state, &unit.id, artifact)).body)
                }
                ReferenceRoot::Published { artifact } => {
                    Some(Value::Bool(latest(state, &unit.id, artifact).is_some()))
                }
                ReferenceRoot::Approved { artifact } => Some(decided(state, unit, artifact, false)),
                ReferenceRoot::ChangesRequested { artifact } => {
                    Some(decided(state, unit, artifact, true))
                }
                ReferenceRoot::MemberOutcomes { unit: collection } => {
                    let mut values = Vec::new();
                    let mut children: Vec<_> = state
                        .units
                        .iter()
                        .filter(|candidate| {
                            candidate.parent.as_ref() == Some(&unit.id)
                                && candidate.declaration.0 == collection.0
                        })
                        .collect();
                    children.sort_by(|left, right| left.id.cmp(&right.id));
                    context.check_list_len(children.len())?;
                    for child in children {
                        let UnitStatus::Done { outcome } = &child.status else {
                            return Ok(None);
                        };
                        values.push(resolved!(read(outcome)));
                    }
                    Some(Value::Array(values))
                }
                ReferenceRoot::UnitOutcome { unit: child_key } => {
                    // The compiler admits only a non-collection unit
                    // here, so its declaration names exactly one member.
                    let child = resolved!(state.units.iter().find(|candidate| {
                        candidate.parent.as_ref() == Some(&unit.id)
                            && candidate.declaration == *child_key
                    }));
                    let UnitStatus::Done { outcome } = &child.status else {
                        return Ok(None);
                    };
                    read(outcome)
                }
            }
        }
    })
}
pub(super) fn eval_fields(
    fields: &[CheckedNamedExpression],
    unit: &UnitState,
    state: &StepSnapshot,
    each: Option<&Value>,
    context: &mut EvaluationContext<'_>,
) -> Result<Option<Value>, StepError> {
    let mut result = serde_json::Map::new();
    for field in fields {
        let Some(value) =
            eval_expression(&field.value.expression, unit, state, each, None, context)?
        else {
            return Ok(None);
        };
        result.insert(field.key.clone(), value);
    }
    Ok(Some(Value::Object(result)))
}
