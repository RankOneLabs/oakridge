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
            let empty_outcome = match &c.empty {
                EmptyPolicy::Reject => None,
                EmptyPolicy::Complete { outcome } => {
                    let value = compile_expression(bundle, owner, outcome, &Context::default(), 0)?;
                    compatible(bundle, &owner.outcome_schema, &value.schema, &child.key.0)?;
                    Some(value)
                }
            };
            Some(CheckedCollection {
                source,
                key_field,
                input_field,
                dependencies_field,
                empty_outcome,
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
        initial,
        tree,
        children,
        command_targets,
    })
}
