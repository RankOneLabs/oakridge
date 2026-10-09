use crate::expressions::{compatible, compile_expression, Context};
use crate::trees::compile_tree;
use crate::{check_value, error, schema, scope};
use std::collections::BTreeSet;
use workflow_model::*;
pub fn compile_scope(
    bundle: &DefinitionBundle,
    owner: &ScopeDefinition,
) -> CoreResult<CheckedScope> {
    let initial = check_value(bundle, &owner.state_schema, &owner.initial).map_err(|mut e| {
        e.kind = DomainErrorKind::InvalidAssignment;
        e
    })?;
    if let Some(key) = &owner.entry_command {
        let state = match &initial.data {
            CheckedData::Variant { variant, .. } | CheckedData::Enum { variant } => Some(variant),
            _ => None,
        };
        if !owner.commands.iter().any(|command| {
            command.key == *key && state.is_some_and(|state| command.available_in.contains(state))
        }) {
            return Err(error(
                DomainErrorKind::InvalidAssignment,
                key.to_string(),
                "entry command must be available in the initial state",
            ));
        }
    }
    let tree = compile_tree(
        bundle,
        owner,
        &owner.tree,
        &Context::default(),
        &mut BTreeSet::new(),
        0,
    )?;
    let mut children = Vec::new();
    for child in &owner.children {
        let mut context = Context::default();
        let collection = if let Some(c) = &child.collection {
            let source = compile_expression(bundle, owner, &c.source, &context, 0)?;
            let SchemaShape::List { item, max_items } = schema(bundle, &source.schema)? else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "collection source must be a typed list",
                ));
            };
            if *max_items > c.max_items {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "source bound exceeds collection bound",
                ));
            }
            let SchemaShape::Record { fields, .. } = schema(bundle, item)? else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "collection member must be a record",
                ));
            };
            let field = |name: &str| {
                fields
                    .iter()
                    .enumerate()
                    .find(|(_, f)| f.key == name && f.required)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::InvalidTemplate,
                            name,
                            "mapping requires a named required field",
                        )
                    })
            };
            let (key_field, key) = field(&c.key_field)?;
            let (input_field, input) = field(&c.input_field)?;
            let (dependencies_field, deps) = field(&c.dependencies_field)?;
            if !matches!(schema(bundle, &key.schema)?, SchemaShape::String { .. }) {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "member key must be a string",
                ));
            }
            compatible(
                bundle,
                &scope(bundle, &child.scope)?.input_schema,
                &input.schema,
                &child.key.0,
            )
            .map_err(|mut e| {
                e.kind = DomainErrorKind::InvalidTemplate;
                e
            })?;
            let SchemaShape::List {
                item: dependency, ..
            } = schema(bundle, &deps.schema)?
            else {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "dependencies must be a string list",
                ));
            };
            if !matches!(schema(bundle, dependency)?, SchemaShape::String { .. }) {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "dependency key must be a string",
                ));
            }
            context.item = Some(item.clone());
            Some(CheckedCollection {
                source,
                key_field,
                input_field,
                dependencies_field,
            })
        } else {
            None
        };
        let input = compile_expression(bundle, owner, &child.input, &context, 0)?;
        compatible(
            bundle,
            &scope(bundle, &child.scope)?.input_schema,
            &input.schema,
            &child.key.0,
        )?;
        children.push(CheckedChild {
            key: child.key.clone(),
            input,
            collection,
        });
    }
    let mut command_targets = Vec::new();
    for command in &owner.commands {
        let mut context = Context {
            guards: vec![(ReferenceRoot::Trigger, vec![], command.key.0.clone())],
            item: None,
        };
        if command.available_in.len() == 1 {
            context.guards.push((
                ReferenceRoot::State,
                vec![],
                command.available_in[0].clone(),
            ));
        }
        let targets = command
            .targets
            .iter()
            .map(|e| compile_expression(bundle, owner, e, &context, 0))
            .collect::<CoreResult<Vec<_>>>()?;
        // Projections resolve targets and prefill from observed roots, so only a
        // direct reference to a whole observed value is resolvable outside the core.
        if command.targets.iter().any(|e| !is_whole_reference(e)) {
            return Err(error(
                DomainErrorKind::InvalidAssignment,
                command.key.to_string(),
                "targets must be direct references without a path",
            ));
        }
        check_prefill(bundle, owner, command, &context)?;
        if targets.iter().any(|e| {
            let shape = schema(bundle, &e.schema);
            let target_shape = match shape {
                Ok(SchemaShape::List { item, .. }) => schema(bundle, item),
                other => other,
            };
            !matches!(
                target_shape,
                Ok(SchemaShape::Reference {
                    brand: ReferenceBrand::ArtifactRevision
                        | ReferenceBrand::Execution
                        | ReferenceBrand::Resource
                })
            )
        }) {
            return Err(error(
                DomainErrorKind::InvalidAssignment,
                command.key.to_string(),
                "targets must be exact revision/execution/resource references",
            ));
        }
        command_targets.push(CheckedCommandTargets {
            command: command.key.clone(),
            targets,
        });
    }
    Ok(CheckedScope {
        key: owner.key.clone(),
        reads: observation_reads(owner),
        initial,
        tree,
        children,
        command_targets,
    })
}

fn observation_reads(owner: &ScopeDefinition) -> Vec<ReferenceRoot> {
    fn expression(value: &Expression, roots: &mut Vec<ReferenceRoot>) {
        match value {
            Expression::Reference { root, .. } => {
                if !roots.contains(root) {
                    roots.push(root.clone());
                }
            }
            Expression::Record { fields, .. } => fields
                .iter()
                .for_each(|field| expression(&field.value, roots)),
            Expression::List { items, .. }
            | Expression::All { items }
            | Expression::Any { items } => items.iter().for_each(|item| expression(item, roots)),
            Expression::Variant { value, .. }
            | Expression::IsVariant { value, .. }
            | Expression::Not { value }
            | Expression::Field { value, .. } => expression(value, roots),
            Expression::Optional { value, .. } => {
                if let Some(value) = value {
                    expression(value, roots);
                }
            }
            Expression::Equals { left, right } => {
                expression(left, roots);
                expression(right, roots);
            }
            Expression::Map { source, value, .. }
            | Expression::Contains { source, value }
            | Expression::Filter {
                source,
                predicate: value,
            }
            | Expression::Every {
                source,
                predicate: value,
            } => {
                expression(source, roots);
                expression(value, roots);
            }
            Expression::FilterBy { source, key, .. } | Expression::Lookup { source, key, .. } => {
                expression(source, roots);
                expression(key, roots);
            }
            Expression::UniqueBy { source, .. } | Expression::CheckCollection { source, .. } => {
                expression(source, roots)
            }
            Expression::Literal { .. } => {}
        }
    }
    fn tree(value: &DecisionTree, roots: &mut Vec<ReferenceRoot>) {
        match value {
            DecisionTree::Match {
                value,
                cases,
                otherwise,
                ..
            } => {
                expression(value, roots);
                cases.iter().for_each(|case| tree(&case.node, roots));
                if let Some(otherwise) = otherwise {
                    tree(otherwise, roots);
                }
            }
            DecisionTree::If {
                condition,
                then,
                otherwise,
                ..
            } => {
                expression(condition, roots);
                tree(then, roots);
                tree(otherwise, roots);
            }
            DecisionTree::Apply {
                mutations, outcome, ..
            } => {
                for mutation in mutations {
                    match mutation {
                        Mutation::SetState { value }
                        | Mutation::Export { value, .. }
                        | Mutation::BindResource { value, .. } => expression(value, roots),
                        _ => {}
                    }
                }
                if let Some(outcome) = outcome {
                    expression(outcome, roots);
                }
            }
            DecisionTree::Wait { .. } | DecisionTree::Reject { .. } => {}
        }
    }
    let mut roots = Vec::new();
    tree(&owner.tree, &mut roots);
    for worker in &owner.workers {
        for action in &worker.actions {
            expression(&action.input, &mut roots);
        }
    }
    for command in &owner.commands {
        for target in &command.targets {
            expression(target, &mut roots);
        }
        for prefill in &command.prefill {
            expression(&prefill.value, &mut roots);
        }
    }
    for child in &owner.children {
        expression(&child.input, &mut roots);
        if let Some(collection) = &child.collection {
            expression(&collection.source, &mut roots);
        }
    }
    roots
}
fn is_whole_reference(expression: &Expression) -> bool {
    matches!(expression, Expression::Reference { path, .. } if path.is_empty())
}
/// Prefill roots are the observed outputs and resources a projection reads.
fn is_observed_root(root: &ReferenceRoot) -> bool {
    matches!(
        root,
        ReferenceRoot::Output { .. }
            | ReferenceRoot::OutputCollection { .. }
            | ReferenceRoot::OutputRevision { .. }
            | ReferenceRoot::OutputRevisions { .. }
            | ReferenceRoot::OptionalOutputRevision { .. }
            | ReferenceRoot::Resource { .. }
    )
}
/// Each prefilled field names a payload record field once and reads an observed
/// root whose value is the field's schema, or an optional of it that the
/// projection unwraps when present.
fn check_prefill(
    bundle: &DefinitionBundle,
    owner: &ScopeDefinition,
    command: &CommandDefinition,
    context: &Context,
) -> CoreResult<()> {
    if command.prefill.is_empty() {
        return Ok(());
    }
    let invalid = |detail: &str| {
        error(
            DomainErrorKind::InvalidAssignment,
            command.key.to_string(),
            detail,
        )
    };
    let SchemaShape::Record { fields, .. } = schema(bundle, &command.payload_schema)? else {
        return Err(invalid("prefill requires a record payload"));
    };
    let mut seen = BTreeSet::new();
    for prefill in &command.prefill {
        if !seen.insert(prefill.key.as_str()) {
            return Err(invalid("prefill names a payload field twice"));
        }
        let field = fields
            .iter()
            .find(|field| field.key == prefill.key)
            .ok_or_else(|| invalid("prefill names an undeclared payload field"))?;
        let Expression::Reference { root, .. } = &prefill.value else {
            return Err(invalid("prefill must be a direct reference"));
        };
        if !is_observed_root(root) {
            return Err(invalid("prefill must read an observed output or resource"));
        }
        let value = compile_expression(bundle, owner, &prefill.value, context, 0)?;
        let unwrapped = match schema(bundle, &value.schema)? {
            SchemaShape::Optional { item } => item,
            _ => &value.schema,
        };
        if value.schema != field.schema && *unwrapped != field.schema {
            return Err(invalid(
                "prefill value schema differs from the payload field",
            ));
        }
    }
    Ok(())
}
