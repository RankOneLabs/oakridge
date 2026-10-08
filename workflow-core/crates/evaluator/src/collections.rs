use crate::expressions::{charge, evaluate_expression, EvaluationContext};
use crate::{failure, owner, snapshot_valid};
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;
pub(crate) fn field(value: &CheckedValue, index: usize) -> CoreResult<&CheckedValue> {
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
pub(crate) fn text(value: &CheckedValue, budget: &mut usize) -> CoreResult<String> {
    if let CheckedData::String { value } = &value.data {
        charge(
            budget,
            value.len().div_ceil(256).max(1),
            "collection member key",
        )?;
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
    let mut budget = program.derived.limits.evaluation_budget;
    snapshot_valid(program, snapshot, &mut budget)?;
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
    let mut keys = BTreeSet::new();
    let mut children = Vec::new();
    for item in &items {
        let key = text(field(item, collection.key_field)?, context.budget)?;
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
            .map(|value| text(value, context.budget))
            .collect::<CoreResult<Vec<_>>>()?;
        if depends_on.iter().collect::<BTreeSet<_>>().len() != depends_on.len() {
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
            .derived
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
        workflow_compiler::validate_checked_value(
            &program.derived,
            &expected.input_schema,
            &input,
        )?;
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
    let members: Vec<_> = children
        .iter()
        .map(|c| {
            (
                c.key.as_str(),
                c.depends_on.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    check_acyclic(&members, &template.0, context.budget)?;
    Ok(Materialization { children })
}

/// Checked collection constraints apply before acceptance as well as materialization.
pub(crate) fn validate_collection(
    items: &[CheckedValue],
    key_field: usize,
    dependencies_field: usize,
    budget: &mut usize,
) -> CoreResult<()> {
    let mut keys = BTreeSet::new();
    let mut members = Vec::new();
    for item in items {
        let key = text(field(item, key_field)?, budget)?;
        if key.is_empty()
            || key.len() > 256
            || key.chars().any(|c| c.is_control() || c == '/' || c == '\\')
            || !keys.insert(key.clone())
        {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                key,
                "illegal or duplicate member key",
            ));
        }
        let CheckedData::List { items: deps } = &field(item, dependencies_field)?.data else {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                key,
                "dependencies not list",
            ));
        };
        let deps = deps
            .iter()
            .map(|value| text(value, budget))
            .collect::<CoreResult<Vec<_>>>()?;
        if deps.iter().collect::<BTreeSet<_>>().len() != deps.len() {
            return Err(failure(
                DomainErrorKind::InvalidTemplate,
                key,
                "duplicate prerequisites",
            ));
        }
        members.push((key, deps));
    }
    if members
        .iter()
        .any(|(_, deps)| deps.iter().any(|key| !keys.contains(key)))
    {
        return Err(failure(
            DomainErrorKind::InvalidTemplate,
            "collection",
            "prerequisite references missing member",
        ));
    }
    let members: Vec<_> = members
        .iter()
        .map(|(key, deps)| (key.as_str(), deps.iter().map(String::as_str).collect()))
        .collect();
    check_acyclic(&members, "collection", budget)
}

/// Members ordered by their prerequisites (Kahn's algorithm). The work is one
/// visit per member and one per prerequisite edge, so exactly that is charged
/// before it runs; a dense graph cannot do more work than it paid for.
/// Prerequisites must already name existing members.
fn check_acyclic(
    members: &[(&str, Vec<&str>)],
    entity: &str,
    budget: &mut usize,
) -> CoreResult<()> {
    let edges = members
        .iter()
        .fold(0usize, |total, (_, deps)| total.saturating_add(deps.len()));
    charge(budget, members.len().saturating_add(edges), entity)?;
    let position: BTreeMap<&str, usize> = members
        .iter()
        .enumerate()
        .map(|(index, (key, _))| (*key, index))
        .collect();
    let mut unmet: Vec<usize> = members.iter().map(|(_, deps)| deps.len()).collect();
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); members.len()];
    for (index, (_, deps)) in members.iter().enumerate() {
        for dep in deps {
            if let Some(&prerequisite) = position.get(dep) {
                dependents[prerequisite].push(index);
            }
        }
    }
    let mut ready: Vec<usize> = (0..members.len())
        .filter(|&index| unmet[index] == 0)
        .collect();
    let mut completed = 0;
    while let Some(index) = ready.pop() {
        completed += 1;
        for &dependent in &dependents[index] {
            unmet[dependent] -= 1;
            if unmet[dependent] == 0 {
                ready.push(dependent);
            }
        }
    }
    if completed < members.len() {
        return Err(failure(
            DomainErrorKind::CyclicPrerequisite,
            entity,
            "collection prerequisite cycle",
        ));
    }
    Ok(())
}
