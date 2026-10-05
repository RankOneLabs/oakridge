use crate::expressions::{trigger_schema, Context};
use crate::{error, schema, scope};
use workflow_model::*;
pub(crate) fn optional_field_schema(record: &SchemaId, index: usize) -> SchemaId {
    SchemaId(format!("$optional/{record}/{index}"))
}
fn reference_schema(
    bundle: &DefinitionBundle,
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
    bundle: &DefinitionBundle,
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
                        .any(|(r, p, v)| r == root && p == &consumed && v == "some")
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
