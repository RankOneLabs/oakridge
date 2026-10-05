use crate::expressions::{evaluate_expression, EvaluationContext};
use crate::{failure, owner, snapshot_valid};
use std::collections::HashSet;
use workflow_model::*;
fn field(value: &CheckedValue, index: usize) -> CoreResult<&CheckedValue> {
    let CheckedData::Record { fields, .. } = &value.data else {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            value.schema.to_string(),
            "collection member not record",
        ));
    };
    fields
        .iter()
        .find(|f| f.field_id == index)
        .and_then(|f| f.value.as_ref())
        .ok_or_else(|| {
            failure(
                DomainErrorKind::InvalidTemplate,
                value.schema.to_string(),
                "collection field missing",
            )
        })
}
fn text(value: &CheckedValue) -> CoreResult<String> {
    if let CheckedData::String { value } = &value.data {
        Ok(value.clone())
    } else {
        Err(failure(
            DomainErrorKind::InvalidTemplate,
            value.schema.to_string(),
            "member key is not a string",
        ))
    }
}
/// Entire batch is checked before returning any instance; caller commits membership atomically.
pub fn materialize(
    program: &CheckedProgram,
    snapshot: &Snapshot,
    template: &SymbolKey,
) -> CoreResult<Materialization> {
    snapshot_valid(program, snapshot)?;
    let mut budget = program.source.limits.evaluation_budget;
    materialize_with_budget(program, snapshot, template, &mut budget)
}
pub(crate) fn materialize_with_budget(
    program: &CheckedProgram,
    snapshot: &Snapshot,
    template: &SymbolKey,
    budget: &mut usize,
) -> CoreResult<Materialization> {
    let (owner, checked) = owner(program, snapshot)?;
    let source = owner
        .children
        .iter()
        .find(|c| c.key == *template)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                template.to_string(),
                "child template missing",
            )
        })?;
    let child = checked
        .children
        .iter()
        .find(|c| c.key == *template)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                template.to_string(),
                "checked template missing",
            )
        })?;
    let mut context = EvaluationContext {
        program,
        snapshot,
        item: None,
        budget,
    };
    let Some(collection) = &child.collection else {
        return Ok(Materialization {
            children: vec![MaterializedChild {
                key: template.0.clone(),
                scope: source.scope.clone(),
                input: evaluate_expression(&child.input, &mut context)?,
                depends_on: source.depends_on.iter().map(|k| k.0.clone()).collect(),
            }],
            empty_outcome: None,
        });
    };
    let Some(policy) = &source.collection else {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            template.to_string(),
            "collection policy missing",
        ));
    };
    let values = evaluate_expression(&collection.source, &mut context)?;
    let CheckedData::List { items } = values.data else {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            template.to_string(),
            "source is not checked list",
        ));
    };
    if items.len() > policy.max_items || items.len() < policy.min_items {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            template.to_string(),
            "collection cardinality violated",
        ));
    }
    if items.is_empty() {
        return match &collection.empty_outcome {
            Some(e) => Ok(Materialization {
                children: vec![],
                empty_outcome: Some(evaluate_expression(e, &mut context)?),
            }),
            None => Err(failure(
                DomainErrorKind::InvalidTemplate,
                template.to_string(),
                "empty collection rejected by policy",
            )),
        };
    }
    let mut keys = HashSet::new();
    let mut children = Vec::new();
    for item in &items {
        let key = text(field(item, collection.key_field)?)?;
        if key.is_empty()
            || key.len() > 256
            || key.chars().any(|c| c.is_control() || c == '/' || c == '\\')
            || !keys.insert(key.clone())
        {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                template.to_string(),
                "empty, illegal or duplicate member key",
            ));
        }
        let CheckedData::List {
            items: dependencies,
        } = &field(item, collection.dependencies_field)?.data
        else {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                template.to_string(),
                "dependencies not list",
            ));
        };
        let depends_on = dependencies
            .iter()
            .map(text)
            .collect::<CoreResult<Vec<_>>>()?;
        if depends_on.iter().collect::<HashSet<_>>().len() != depends_on.len() {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                key,
                "duplicate prerequisites",
            ));
        }
        let mut member_context = EvaluationContext {
            program,
            snapshot,
            item: Some(item),
            budget: context.budget,
        };
        let input = evaluate_expression(&child.input, &mut member_context)?;
        let expected = program
            .source
            .scopes
            .iter()
            .find(|s| s.key == source.scope)
            .ok_or_else(|| {
                failure(
                    DomainErrorKind::MissingSymbol,
                    source.scope.to_string(),
                    "target scope missing",
                )
            })?;
        workflow_compiler::validate_checked_value(&program.source, &expected.input_schema, &input)?;
        children.push(MaterializedChild {
            key,
            scope: source.scope.clone(),
            input,
            depends_on,
        });
    }
    if children
        .iter()
        .any(|c| c.depends_on.iter().any(|d| !keys.contains(d)))
    {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            template.to_string(),
            "prerequisite references missing member",
        ));
    }
    let mut complete = HashSet::new();
    while complete.len() < children.len() {
        let ready: Vec<_> = children
            .iter()
            .filter(|c| {
                !complete.contains(&c.key) && c.depends_on.iter().all(|d| complete.contains(d))
            })
            .collect();
        if ready.is_empty() {
            return Err(failure(
                DomainErrorKind::CyclicPrerequisite,
                template.to_string(),
                "collection prerequisite cycle",
            ));
        }
        for c in ready {
            complete.insert(c.key.clone());
        }
    }
    Ok(Materialization {
        children,
        empty_outcome: None,
    })
}
