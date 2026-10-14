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
    context: &EvaluationContext<'_>,
) -> Result<Option<Value>, StepError> {
    let bindings = Bindings {
        each,
        item: None,
        body: own_body,
    };
    let result = eval_expression_inner(expression, unit, state, bindings, context);
    if let Some(reason) = context.limit_error.get() {
        return Err(rejected(reason));
    }
    if context.exhausted.get() {
        return Err(rejected("evaluation_budget exceeded"));
    }
    if let Some(value) = &result {
        context.check_value(value)?;
    }
    Ok(result)
}
/// The graph check behind `valid_graph`: every key a legal ident and
/// unique, every dependency list free of repeats and naming a key, and no
/// cycle. Malformed members fail the check rather than the evaluation.
pub(super) fn eval_expression_inner(
    expression: &Expression,
    unit: &UnitState,
    state: &StepSnapshot,
    bindings: Bindings<'_>,
    context: &EvaluationContext<'_>,
) -> Option<Value> {
    if !context.charge() {
        return None;
    }
    fn decided(
        state: &StepSnapshot,
        unit: &UnitState,
        artifact: &SymbolKey,
        effect: DecisionEffect,
    ) -> Value {
        Value::Bool(latest(state, &unit.id, artifact).is_some_and(|revision| {
            state.decisions.iter().any(|decision| {
                decision.unit == unit.id
                    && decision.target == revision.id
                    && decision.effect == effect
            })
        }))
    }
    let eval = |inner: &Expression| eval_expression_inner(inner, unit, state, bindings, context);
    let eval_item = |inner: &Expression, item: &Value| {
        let bound = Bindings {
            item: Some(item),
            ..bindings
        };
        eval_expression_inner(inner, unit, state, bound, context)
    };
    let boolean = |inner: &Expression| eval(inner)?.as_bool();
    let list = |inner: &Expression| -> Option<Vec<Value>> {
        let Value::Array(items) = eval(inner)? else {
            return None;
        };
        context.check_list_len(items.len()).then_some(items)
    };
    let integers = |left: &Expression, right: &Expression| -> Option<(i64, i64)> {
        Some((eval(left)?.as_i64()?, eval(right)?.as_i64()?))
    };
    match expression {
        Expression::Literal { value, .. } => Some(value.clone()),
        Expression::Len { value } => Some(Value::from(match eval(value)? {
            Value::String(text) => text.chars().count(),
            Value::Array(items) => items.len(),
            _ => return None,
        })),
        Expression::GreaterThan { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left > right))
        }
        Expression::GreaterOrEqual { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left >= right))
        }
        Expression::LessThan { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left < right))
        }
        Expression::LessOrEqual { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left <= right))
        }
        // `a and b` reads b only where a holds, so a false a short-circuits
        // and an unresolved a leaves the conjunction unresolved.
        Expression::All { items } => {
            for item in items {
                if !boolean(item)? {
                    return Some(Value::Bool(false));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Any { items } => {
            for item in items {
                if boolean(item)? {
                    return Some(Value::Bool(true));
                }
            }
            Some(Value::Bool(false))
        }
        Expression::Not { value } => Some(Value::Bool(!boolean(value)?)),
        Expression::Equals { left, right } => Some(Value::Bool(eval(left)? == eval(right)?)),
        Expression::Every { source, predicate } => {
            for item in list(source)? {
                if !eval_item(predicate, &item)?.as_bool()? {
                    return Some(Value::Bool(false));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Filter { source, predicate } => {
            let mut kept = Vec::new();
            for item in list(source)? {
                if eval_item(predicate, &item)?.as_bool()? {
                    kept.push(item);
                }
            }
            Some(Value::Array(kept))
        }
        Expression::Contains { source, value } => {
            let value = eval(value)?;
            Some(Value::Bool(list(source)?.contains(&value)))
        }
        Expression::Lookup {
            source,
            key_field,
            key,
        } => {
            let key = eval(key)?;
            let mut matches = list(source)?
                .into_iter()
                .filter(|item| item.get(key_field) == Some(&key));
            let found = matches.next()?;
            // Exactly one: an ambiguous key resolves to nothing.
            matches.next().is_none().then_some(found)
        }
        Expression::Field { value, key } => eval(value)?.get(key).cloned(),
        Expression::CheckCollection {
            source,
            key_field,
            dependencies_field,
        } => Some(Value::Bool(is_valid_graph(
            &list(source)?,
            key_field,
            dependencies_field,
        ))),
        Expression::Record { fields, .. } => {
            let mut record = serde_json::Map::new();
            for field in fields {
                record.insert(field.key.clone(), eval(&field.value)?);
            }
            Some(Value::Object(record))
        }
        Expression::List { items, .. } => {
            if !context.check_list_len(items.len()) {
                return None;
            }
            items
                .iter()
                .map(eval)
                .collect::<Option<Vec<_>>>()
                .map(Value::Array)
        }
        Expression::Map {
            source,
            value: projection,
            ..
        } => list(source)?
            .iter()
            .map(|item| eval_item(projection, item))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
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
                ReferenceRoot::UnitInput => read(&unit.input),
                ReferenceRoot::EachMember => read(bindings.each?),
                ReferenceRoot::Item => read(bindings.item?),
                ReferenceRoot::ValidationBody { artifact } => {
                    let (bound, body) = bindings.body?;
                    (bound == artifact.0).then(|| read(body)).flatten()
                }
                ReferenceRoot::Latest { artifact } => {
                    read(&latest(state, &unit.id, artifact)?.body)
                }
                ReferenceRoot::Published { artifact } => {
                    Some(Value::Bool(latest(state, &unit.id, artifact).is_some()))
                }
                ReferenceRoot::Approved { artifact } => {
                    Some(decided(state, unit, artifact, DecisionEffect::Approve))
                }
                ReferenceRoot::ChangesRequested { artifact } => Some(decided(
                    state,
                    unit,
                    artifact,
                    DecisionEffect::RequestChanges,
                )),
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
                    if !context.check_list_len(children.len()) {
                        return None;
                    }
                    for child in children {
                        let UnitStatus::Done { outcome } = &child.status else {
                            return None;
                        };
                        values.push(read(outcome)?);
                    }
                    Some(Value::Array(values))
                }
                ReferenceRoot::UnitOutcome { unit: child_key } => {
                    // The compiler admits only a non-collection unit
                    // here, so its declaration names exactly one member.
                    let child = state.units.iter().find(|candidate| {
                        candidate.parent.as_ref() == Some(&unit.id)
                            && candidate.declaration == *child_key
                    })?;
                    let UnitStatus::Done { outcome } = &child.status else {
                        return None;
                    };
                    read(outcome)
                }
            }
        }
    }
}
pub(super) fn eval_fields(
    fields: &[CheckedNamedExpression],
    unit: &UnitState,
    state: &StepSnapshot,
    each: Option<&Value>,
    context: &EvaluationContext<'_>,
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
