use super::*;
use crate::workflow::{field_type, item_type, resolve_type};
fn boolean() -> TypeExpression {
    Type::Boolean
}
fn integer() -> TypeExpression {
    Type::Integer
}
fn list_item(
    ty: &TypeExpression,
    scope: &Scope<'_>,
    function: &str,
) -> Result<TypeExpression, CompileError> {
    item_type(&resolve_type(ty, scope.aliases)).ok_or_else(|| {
        scope.error(
            CheckKind::ExpressionType,
            format!("{function} requires a list"),
        )
    })
}
fn require_boolean(ty: TypeExpression, what: &str, scope: &Scope<'_>) -> Result<(), CompileError> {
    if ty != boolean() {
        return Err(scope.error(CheckKind::ExpressionType, format!("{what} must be boolean")));
    }
    Ok(())
}
/// The variants of an `enum(a, b, …)` type.
pub(crate) fn enum_variants(ty: &TypeExpression) -> Option<Vec<String>> {
    match ty {
        Type::Enum { variants } => Some(variants.clone()),
        _ => None,
    }
}
/// A type with its aliases resolved and an outer `optional(...)` removed, so
/// a value compares with a nullable value of its own type.
fn comparison_shape(ty: &TypeExpression, scope: &Scope<'_>) -> TypeExpression {
    let resolved = resolve_type(ty, scope.aliases);
    if let Type::Optional { value } = &resolved {
        return comparison_shape(value, scope);
    }
    resolved
}
fn is_string_like(ty: &TypeExpression) -> bool {
    matches!(ty, Type::Text | Type::Ident | Type::RepoPath) || enum_variants(ty).is_some()
}
fn comparable(left: &TypeExpression, right: &TypeExpression, scope: &Scope<'_>) -> bool {
    let (left, right) = (
        comparison_shape(left, scope),
        comparison_shape(right, scope),
    );
    if left == right || (is_string_like(&left) && is_string_like(&right)) {
        return true;
    }
    match (item_type(&left), item_type(&right)) {
        (Some(left), Some(right)) => comparable(&left, &right, scope),
        _ => false,
    }
}
/// A text literal compared with an enum must be one of its variants.
fn check_enum_literal(
    ty: &TypeExpression,
    other: &StageExpr,
    scope: &Scope<'_>,
) -> Result<(), CompileError> {
    if let StageExpr::Spanned(inner, span) = other {
        let scope = Scope {
            diagnostic_span: *span,
            ..scope.clone()
        };
        return check_enum_literal(ty, inner, &scope);
    }
    let (Some(variants), StageExpr::Text(literal)) =
        (enum_variants(&comparison_shape(ty, scope)), other)
    else {
        return Ok(());
    };
    if !variants.contains(literal) {
        return Err(scope.error(
            CheckKind::ExpressionType,
            format!(
                "\"{literal}\" is not a variant of enum({})",
                variants.join(", ")
            ),
        ));
    }
    Ok(())
}
fn read_path(
    ty: &TypeExpression,
    path: &[String],
    scope: &Scope<'_>,
    missing: &str,
) -> Result<TypeExpression, CompileError> {
    if path.is_empty() {
        return Ok(ty.clone());
    }
    let mut current = resolve_type(ty, scope.aliases);
    for (index, segment) in path.iter().enumerate() {
        if matches!(current, Type::Optional { .. }) {
            return Err(scope.error(
                CheckKind::ExpressionType,
                format!("optional field {} needs default", path[..=index].join(".")),
            ));
        }
        current = match current {
            Type::Record { fields } => fields.get(segment).cloned(),
            _ => None,
        }
        .ok_or_else(|| scope.error(CheckKind::Name, missing.to_owned()))?;
        current = resolve_type(&current, scope.aliases);
    }
    Ok(current)
}
pub(crate) fn infer(
    expression: &StageExpr,
    scope: &Scope<'_>,
) -> Result<TypeExpression, CompileError> {
    match expression {
        StageExpr::Spanned(inner, span) => {
            let scope = Scope {
                diagnostic_span: *span,
                ..scope.clone()
            };
            infer(inner, &scope)
        }
        StageExpr::Or(left, right) | StageExpr::And(left, right) => {
            require_boolean(
                infer(left, scope)?,
                "a conjunction's operands",
                &scope.for_expr(left),
            )?;
            // `a and b` reads b only where a holds, so a's guards type b.
            let right_scope = match expression {
                StageExpr::And(..) => scope.guarded_by(left),
                _ => scope.clone(),
            };
            require_boolean(
                infer(right, &right_scope)?,
                "a conjunction's operands",
                &right_scope.for_expr(right),
            )?;
            Ok(boolean())
        }
        StageExpr::Not(inner) => {
            require_boolean(
                infer(inner, scope)?,
                "not's operand",
                &scope.for_expr(inner),
            )?;
            Ok(boolean())
        }
        StageExpr::Equality { left, right, .. } => {
            let (left_type, right_type) = (infer(left, scope)?, infer(right, scope)?);
            if !comparable(&left_type, &right_type, scope) {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    format!("cannot compare {} with {}", left_type, right_type),
                ));
            }
            check_enum_literal(&left_type, right, scope)?;
            check_enum_literal(&right_type, left, scope)?;
            Ok(boolean())
        }
        StageExpr::Compare { left, right, .. } => {
            if infer(left, scope)? != integer() || infer(right, scope)? != integer() {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    "integer comparison requires integer operands",
                ));
            }
            Ok(boolean())
        }
        StageExpr::Len(inner) => {
            let ty = resolve_type(&infer(inner, scope)?, scope.aliases);
            if ty != Type::Text && item_type(&ty).is_none() {
                return Err(scope
                    .for_expr(inner)
                    .error(CheckKind::ExpressionType, "len requires text or list"));
            }
            Ok(integer())
        }
        StageExpr::Published(artifact)
        | StageExpr::Approved(artifact)
        | StageExpr::ChangesRequested(artifact) => {
            if !scope.artifacts.contains_key(artifact) {
                return Err(scope.error(CheckKind::Name, format!("artifact {artifact} absent")));
            }
            Ok(boolean())
        }
        StageExpr::Latest { artifact, path } => {
            let schema = &scope
                .artifacts
                .get(artifact)
                .ok_or_else(|| scope.error(CheckKind::Name, format!("artifact {artifact} absent")))?
                .schema;
            // A guard names the artifact it proves. Treating any publication
            // guard as proof for every artifact let an unguarded field read
            // of a sibling artifact past check 9.
            if !scope.guaranteed.contains(artifact) {
                if !path.is_empty() {
                    return Err(
                        scope.error(CheckKind::ExpressionType, "nullable latest must be guarded")
                    );
                }
                return Ok(Type::Optional {
                    value: Box::new(schema.clone()),
                });
            }
            read_path(schema, path, scope, "artifact field absent")
        }
        StageExpr::Every { source, predicate }
        | StageExpr::Any { source, predicate }
        | StageExpr::Filter { source, predicate } => {
            let source_type = infer(source, scope)?;
            let item = list_item(&source_type, &scope.for_expr(source), "a list predicate")?;
            require_boolean(
                infer(predicate, &scope.with_item(item))?,
                "a list predicate",
                &scope.for_expr(predicate),
            )?;
            Ok(match expression {
                StageExpr::Filter { .. } => source_type,
                _ => boolean(),
            })
        }
        StageExpr::MapOf { source, value } => {
            if let StageExpr::Name { head, path } = source.clone().into_unspanned() {
                if path.is_empty() && scope.collections.contains(&head) {
                    let member = scope.outcomes.get(&head).ok_or_else(|| {
                        scope.error(
                            CheckKind::Scope,
                            format!("collection {head} outside read scope"),
                        )
                    })?;
                    if let StageExpr::Outcome { unit, path } = value.clone().into_unspanned() {
                        if unit == head {
                            let value_type =
                                read_path(member, &path, scope, "collection outcome field absent")?;
                            return Ok(Type::List {
                                item: Box::new(value_type),
                            });
                        }
                    }
                    return Err(scope.error(
                        CheckKind::Outcome,
                        "map projection outside collection outcome",
                    ));
                }
            }
            let item = list_item(&infer(source, scope)?, &scope.for_expr(source), "map")?;
            let value_type = infer(value, &scope.with_item(item))?;
            Ok(Type::List {
                item: Box::new(value_type),
            })
        }
        StageExpr::Contains { source, value } => {
            let item = list_item(&infer(source, scope)?, &scope.for_expr(source), "contains")?;
            let value_type = infer(value, scope)?;
            if !comparable(&item, &value_type, scope) {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    "contains compares a list's items with a value of another type",
                ));
            }
            Ok(boolean())
        }
        StageExpr::Lookup {
            source,
            field,
            key,
            path,
        } => {
            let item = list_item(&infer(source, scope)?, &scope.for_expr(source), "lookup")?;
            let field_ty = field_type(&item, &[field], scope.aliases).ok_or_else(|| {
                scope.error(CheckKind::Name, format!("lookup field {field} absent"))
            })?;
            if !comparable(&field_ty, &infer(key, scope)?, scope) {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    format!("lookup key does not compare with {field}"),
                ));
            }
            if !path.is_empty() {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    format!("optional lookup field {} needs default", path.join(".")),
                ));
            }
            Ok(Type::Optional {
                value: Box::new(item),
            })
        }
        StageExpr::Default {
            value,
            fallback,
            path,
        } => {
            let value_type = resolve_type(&infer(value, scope)?, scope.aliases);
            let Type::Optional { value: inner } = value_type else {
                return Err(
                    scope.error(CheckKind::ExpressionType, "default requires optional value")
                );
            };
            let fallback_type = resolve_type(&infer(fallback, scope)?, scope.aliases);
            if *inner != fallback_type {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    format!("default fallback must be {inner}, got {fallback_type}"),
                ));
            }
            read_path(&inner, path, scope, "default field absent")
        }
        StageExpr::Require { value, path } => {
            let value_type = resolve_type(&infer(value, scope)?, scope.aliases);
            let Type::Optional { value: inner } = value_type else {
                return Err(scope.error(CheckKind::ExpressionType, "require needs optional value"));
            };
            read_path(&inner, path, scope, "required field absent")
        }
        StageExpr::Field { value, path } => {
            read_path(&infer(value, scope)?, path, scope, "let field absent")
        }
        StageExpr::ValidGraph {
            source,
            key_field,
            dependencies_field,
        } => {
            let item = list_item(
                &infer(source, scope)?,
                &scope.for_expr(source),
                "valid_graph",
            )?;
            let key = field_type(&item, &[key_field], scope.aliases)
                .map(|ty| comparison_shape(&ty, scope))
                .filter(is_string_like)
                .ok_or_else(|| {
                    scope.error(
                        CheckKind::ExpressionType,
                        format!("valid_graph key {key_field} must be text"),
                    )
                })?;
            let dependencies = field_type(&item, &[dependencies_field], scope.aliases)
                .and_then(|ty| item_type(&resolve_type(&ty, scope.aliases)))
                .ok_or_else(|| {
                    scope.error(
                        CheckKind::ExpressionType,
                        format!("valid_graph {dependencies_field} must be a list"),
                    )
                })?;
            if !comparable(&key, &dependencies, scope) {
                return Err(scope.error(
                    CheckKind::ExpressionType,
                    "valid_graph dependencies must be keys",
                ));
            }
            Ok(boolean())
        }
        StageExpr::Record(fields) => Ok(Type::Record {
            fields: fields
                .iter()
                .map(|(key, value)| Ok((key.clone(), infer(value, scope)?)))
                .collect::<Result<_, CompileError>>()?,
        }),
        StageExpr::Input(path) => read_path(
            scope.input,
            path,
            scope,
            &format!("input field {} absent", path.join(".")),
        ),
        StageExpr::Each(path) => {
            let each = scope
                .each
                .as_ref()
                .ok_or_else(|| scope.error(CheckKind::Scope, "each outside collection"))?;
            read_path(each, path, scope, "each field absent")
        }
        StageExpr::Item(path) => {
            let item = scope.item.as_ref().ok_or_else(|| {
                scope.error(CheckKind::Name, "item outside every, any, filter or map")
            })?;
            read_path(item, path, scope, "item field absent")
        }
        StageExpr::Outcome { unit, path } => {
            if scope.collections.contains(unit) {
                return Err(scope.error(
                    CheckKind::Outcome,
                    format!("collection {unit} outcome is read only through map"),
                ));
            }
            // A unit input's scope holds exactly the outcomes of its `after`
            // units, so a miss there is a read outside `after` (check 3).
            let ty = scope.outcomes.get(unit).ok_or_else(|| {
                scope.error(
                    CheckKind::Scope,
                    format!("unit outcome {unit} absent or outside read scope"),
                )
            })?;
            if path.is_empty() {
                return Ok(ty.clone());
            }
            read_path(ty, path, scope, "unit outcome field absent").map_err(|mut error| {
                if error.check == CheckKind::Name {
                    error.check = CheckKind::Outcome;
                }
                error
            })
        }
        StageExpr::Name { head, path } => {
            if let Some((bound, ty)) = scope.body {
                if head == bound {
                    return read_path(ty, path, scope, "validation body field absent");
                }
            }
            // Whole segments, so a unit outcome field named `input` reads as
            // one rather than tripping this class on a substring match.
            if path
                .iter()
                .any(|segment| ["input", "artifact", "state"].contains(&segment.as_str()))
            {
                return Err(scope.error(CheckKind::Outcome, "expression reads inside another unit"));
            }
            Err(scope.error(CheckKind::Name, format!("unknown expression {head}")))
        }
        StageExpr::Boolean(_) => Ok(boolean()),
        StageExpr::Integer(_) => Ok(integer()),
        StageExpr::Text(_) => Ok(Type::Text),
    }
}
