use crate::expressions::{trigger_schema, Context};
use crate::{error, schema, scope, DefinitionView};
use workflow_model::*;
pub(crate) fn optional_field_schema(record: &SchemaId, index: usize) -> SchemaId {
    SchemaId(format!("$optional/{record}/{index}"))
}
fn reference_schema(
    bundle: &impl DefinitionView,
    owner: &ScopeDefinition,
    root: &ReferenceRoot,
    context: &Context,
) -> CoreResult<SchemaId> {
    Ok(match root {
        ReferenceRoot::Input => owner.input_schema.clone(),
        ReferenceRoot::State => owner.state_schema.clone(),
        ReferenceRoot::Trigger => trigger_schema(owner),
        ReferenceRoot::Output { key } => owner
            .outputs
            .iter()
            .find(|x| x.key == *key)
            .map(|x| x.schema.clone())
            .ok_or_else(|| {
                error(
                    DomainErrorKind::MissingSymbol,
                    key.to_string(),
                    "output not declared",
                )
            })?,
        ReferenceRoot::Result { worker } => owner
            .workers
            .iter()
            .find(|x| x.key == *worker)
            .map(|x| x.result_schema.clone())
            .ok_or_else(|| {
                error(
                    DomainErrorKind::MissingSymbol,
                    worker.to_string(),
                    "worker result not declared",
                )
            })?,
        ReferenceRoot::Resource { key } => owner
            .resources
            .iter()
            .find(|x| x.key == *key)
            .map(|x| x.schema.clone())
            .ok_or_else(|| {
                error(
                    DomainErrorKind::MissingSymbol,
                    key.to_string(),
                    "resource observation not declared",
                )
            })?,
        ReferenceRoot::Child { key, export } => {
            let child = owner
                .children
                .iter()
                .find(|x| x.key == *key)
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::MissingSymbol,
                        key.to_string(),
                        "child not declared",
                    )
                })?;
            if !child.imports.contains(export) {
                return Err(error(
                    DomainErrorKind::PrivateRead,
                    key.to_string(),
                    "parent cannot read child private fields or unimported exports",
                ));
            }
            scope(bundle, &child.scope)?
                .exports
                .iter()
                .find(|x| x.key == *export)
                .map(|x| x.schema.clone())
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::PrivateRead,
                        key.to_string(),
                        "not a child export",
                    )
                })?
        }
        ReferenceRoot::OutputCollection {
            key,
            schema: target,
        }
        | ReferenceRoot::OutputRevisions {
            key,
            schema: target,
        }
        | ReferenceRoot::OutputRevision {
            key,
            schema: target,
        }
        | ReferenceRoot::OptionalOutputRevision {
            key,
            schema: target,
        } => {
            let output = owner
                .outputs
                .iter()
                .find(|o| o.key == *key)
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::MissingSymbol,
                        key.to_string(),
                        "output undeclared",
                    )
                })?;
            let valid = match root {
                ReferenceRoot::OutputCollection { .. } => {
                    output.collection_key.is_some()
                        && matches!(schema(bundle, target)?, SchemaShape::List { item, .. } if *item == output.schema)
                }
                ReferenceRoot::OutputRevisions { .. } => {
                    output.collection_key.is_some()
                        && match schema(bundle, target)? {
                            SchemaShape::List { item, .. } => matches!(
                                schema(bundle, item)?,
                                SchemaShape::Reference {
                                    brand: ReferenceBrand::ArtifactRevision
                                }
                            ),
                            _ => false,
                        }
                }
                ReferenceRoot::OutputRevision { .. } => {
                    output.collection_key.is_none()
                        && matches!(
                            schema(bundle, target)?,
                            SchemaShape::Reference {
                                brand: ReferenceBrand::ArtifactRevision
                            }
                        )
                }
                _ => {
                    output.collection_key.is_none()
                        && match schema(bundle, target)? {
                            SchemaShape::Optional { item } => matches!(
                                schema(bundle, item)?,
                                SchemaShape::Reference {
                                    brand: ReferenceBrand::ArtifactRevision
                                }
                            ),
                            _ => false,
                        }
                }
            };
            if !valid {
                return Err(error(
                    DomainErrorKind::IncompatiblePort,
                    key.to_string(),
                    "output observation schema mismatch",
                ));
            }
            if matches!(
                root,
                ReferenceRoot::OutputCollection { .. } | ReferenceRoot::OutputRevisions { .. }
            ) {
                if let SchemaShape::List {
                    max_items: target_max,
                    ..
                } = schema(bundle, target)?
                {
                    if *target_max < bundle.limits().max_list_items {
                        return Err(error(
                            DomainErrorKind::IncompatiblePort,
                            key.to_string(),
                            format!(
                                "list bound {target_max} is below output collection max_items {}",
                                bundle.limits().max_list_items
                            ),
                        ));
                    }
                }
            }
            target.clone()
        }
        ReferenceRoot::Children {
            key,
            schema: target,
            ..
        }
        | ReferenceRoot::ChildrenOutcomes {
            key,
            schema: target,
        }
        | ReferenceRoot::ChildrenComplete {
            key,
            schema: target,
        } => {
            let child = owner
                .children
                .iter()
                .find(|c| c.key == *key)
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::MissingSymbol,
                        key.to_string(),
                        "child undeclared",
                    )
                })?;
            let child_scope = scope(bundle, &child.scope)?;
            let expected = match root {
                ReferenceRoot::Children { export, .. } => {
                    if !child.imports.contains(export) {
                        return Err(error(
                            DomainErrorKind::PrivateRead,
                            key.to_string(),
                            "unimported child export",
                        ));
                    }
                    &child_scope
                        .exports
                        .iter()
                        .find(|e| e.key == *export)
                        .ok_or_else(|| {
                            error(
                                DomainErrorKind::PrivateRead,
                                key.to_string(),
                                "child export missing",
                            )
                        })?
                        .schema
                }
                _ => &child_scope.outcome_schema,
            };
            let valid = if matches!(root, ReferenceRoot::ChildrenComplete { .. }) {
                matches!(schema(bundle, target)?, SchemaShape::Boolean)
            } else {
                matches!(schema(bundle, target)?, SchemaShape::List { item, .. } if item == expected)
            };
            if !valid {
                return Err(error(
                    DomainErrorKind::IncompatiblePort,
                    key.to_string(),
                    "child observation schema mismatch",
                ));
            }
            if let SchemaShape::List {
                max_items: target_max,
                ..
            } = schema(bundle, target)?
            {
                let source_max = child
                    .collection
                    .as_ref()
                    .map_or(1, |collection| collection.max_items);
                if *target_max < source_max {
                    return Err(error(
                        DomainErrorKind::IncompatiblePort,
                        key.to_string(),
                        format!(
                            "list bound {target_max} is below collection max_items {source_max}"
                        ),
                    ));
                }
            }
            target.clone()
        }
        ReferenceRoot::Item => context.item.clone().ok_or_else(|| {
            error(
                DomainErrorKind::MissingBinding,
                "item",
                "item outside bounded list transform",
            )
        })?,
    })
}
pub(crate) fn compile_reference(
    bundle: &impl DefinitionView,
    owner: &ScopeDefinition,
    root: &ReferenceRoot,
    path: &[String],
    context: &Context,
) -> CoreResult<CheckedExpression> {
    let mut key = reference_schema(bundle, owner, root, context)?;
    let mut selectors = Vec::new();
    let mut consumed = Vec::new();
    for name in path {
        // Tagged payload and optional access require a dominating match on the same reference.
        loop {
            match schema(bundle, &key)? {
                SchemaShape::Optional { item } => {
                    if !context
                        .guards
                        .iter()
                        .rev()
                        .find(|(r, p, _)| r == root && p == &consumed)
                        .is_some_and(|(_, _, variant)| variant == "some")
                    {
                        return Err(error(
                            DomainErrorKind::UnguardedOptional,
                            owner.key.to_string(),
                            "optional reference is not narrowed",
                        ));
                    }
                    key = item.clone();
                    selectors.push(Selector::Optional);
                }
                SchemaShape::Union { variants } => {
                    let guard = context
                        .guards
                        .iter()
                        .rev()
                        .find(|(r, p, _)| r == root && p == &consumed)
                        .map(|(_, _, v)| v);
                    let selected = guard
                        .and_then(|v| variants.iter().find(|x| x.key == *v))
                        .ok_or_else(|| {
                            error(
                                DomainErrorKind::UnguardedOptional,
                                owner.key.to_string(),
                                "union payload is not narrowed",
                            )
                        })?;
                    key = selected.schema.clone();
                    selectors.push(Selector::Variant {
                        variant: selected.key.clone(),
                    });
                }
                _ => break,
            }
        }
        let SchemaShape::Record { fields, .. } = schema(bundle, &key)? else {
            return Err(error(
                DomainErrorKind::InvalidAssignment,
                owner.key.to_string(),
                "field read from a nonrecord",
            ));
        };
        let (index, field) = fields
            .iter()
            .enumerate()
            .find(|(_, f)| f.key == *name)
            .ok_or_else(|| error(DomainErrorKind::MissingSymbol, name, "field not declared"))?;
        if field.required {
            key = field.schema.clone();
            selectors.push(Selector::Field { index });
        } else {
            key = optional_field_schema(&key, index);
            selectors.push(Selector::OptionalField {
                index,
                schema: key.clone(),
            });
        }
        consumed.push(name.clone());
    }
    // A dominating match also narrows a whole payload bound to a required port.
    loop {
        let guard = context
            .guards
            .iter()
            .rev()
            .find(|(r, p, _)| r == root && p == &consumed)
            .map(|(_, _, v)| v);
        match schema(bundle, &key)? {
            SchemaShape::Optional { item } if guard.is_some_and(|v| v == "some") => {
                key = item.clone();
                selectors.push(Selector::Optional);
            }
            SchemaShape::Union { variants } if guard.is_some() => {
                let Some(selected) = variants.iter().find(|v| Some(&v.key) == guard) else {
                    break;
                };
                key = selected.schema.clone();
                selectors.push(Selector::Variant {
                    variant: selected.key.clone(),
                });
            }
            _ => break,
        }
    }
    Ok(CheckedExpression {
        schema: key,
        node: CheckedExpressionNode::Reference {
            root: root.clone(),
            selectors,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn latest_guard_controls_optional_narrowing() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap();
        value["schemas"].as_array_mut().unwrap().extend([
            json!({"key":"guarded_record","shape":{"kind":"record","fields":[{"key":"value","schema":"unit","required":true}],"dictionary":null}}),
            json!({"key":"guarded_optional","shape":{"kind":"optional","item":"guarded_record"}}),
        ]);
        value["scopes"][0]["resources"][0]["schema"] = json!("guarded_optional");
        let bundle: DefinitionBundle = serde_json::from_value(value).unwrap();
        let owner = &bundle.scopes[0];
        let root = ReferenceRoot::Resource {
            key: SymbolKey("source".into()),
        };
        let context = Context {
            guards: vec![
                (root.clone(), vec![], "some".into()),
                (root.clone(), vec![], "none".into()),
            ],
            item: None,
        };
        assert_eq!(
            compile_reference(&bundle, owner, &root, &["value".into()], &context)
                .unwrap_err()
                .kind,
            DomainErrorKind::UnguardedOptional
        );
    }
}
