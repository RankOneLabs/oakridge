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
) -> Result<TypeExpression, DomainError> {
    item_type(&resolve_type(ty, scope.aliases))
        .ok_or_else(|| failure(9, format!("{function} requires a list")))
}
fn require_boolean(ty: TypeExpression, what: &str) -> Result<(), DomainError> {
    if ty != boolean() {
        return Err(failure(9, format!("{what} must be boolean")));
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
) -> Result<(), DomainError> {
    let (Some(variants), StageExpr::Text(literal)) =
        (enum_variants(&comparison_shape(ty, scope)), other)
    else {
        return Ok(());
    };
    if !variants.contains(literal) {
        return Err(failure(
            9,
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
) -> Result<TypeExpression, DomainError> {
    if path.is_empty() {
        return Ok(ty.clone());
    }
    field_type(ty, &segments(path), scope.aliases).ok_or_else(|| failure(1, missing.to_owned()))
}
pub(crate) fn infer(
    expression: &StageExpr,
    scope: &Scope<'_>,
) -> Result<TypeExpression, DomainError> {
    match expression {
        StageExpr::Or(left, right) | StageExpr::And(left, right) => {
            require_boolean(infer(left, scope)?, "a conjunction's operands")?;
            // `a and b` reads b only where a holds, so a's guards type b.
            let right_scope = match expression {
                StageExpr::And(..) => scope.guarded_by(left),
                _ => scope.clone(),
            };
            require_boolean(infer(right, &right_scope)?, "a conjunction's operands")?;
            Ok(boolean())
        }
        StageExpr::Not(inner) => {
            require_boolean(infer(inner, scope)?, "not's operand")?;
            Ok(boolean())
        }
        StageExpr::Equality { left, right, .. } => {
            let (left_type, right_type) = (infer(left, scope)?, infer(right, scope)?);
            if !comparable(&left_type, &right_type, scope) {
                return Err(failure(
                    9,
                    format!("cannot compare {} with {}", left_type, right_type),
                ));
            }
            check_enum_literal(&left_type, right, scope)?;
            check_enum_literal(&right_type, left, scope)?;
            Ok(boolean())
        }
        StageExpr::Compare { left, right, .. } => {
            if infer(left, scope)? != integer() || infer(right, scope)? != integer() {
                return Err(failure(9, "integer comparison requires integer operands"));
            }
            Ok(boolean())
        }
        StageExpr::Len(inner) => {
            let ty = resolve_type(&infer(inner, scope)?, scope.aliases);
            if ty != Type::Text && item_type(&ty).is_none() {
                return Err(failure(9, "len requires text or list"));
            }
            Ok(integer())
        }
        StageExpr::Published(artifact)
        | StageExpr::Approved(artifact)
        | StageExpr::ChangesRequested(artifact) => {
            if !scope.artifacts.contains_key(artifact) {
                return Err(failure(1, format!("artifact {artifact} absent")));
            }
            Ok(boolean())
        }
        StageExpr::Latest { artifact, path } => {
            let schema = &scope
                .artifacts
                .get(artifact)
                .ok_or_else(|| failure(1, format!("artifact {artifact} absent")))?
                .schema;
            // A guard names the artifact it proves. Treating any publication
            // guard as proof for every artifact let an unguarded field read
            // of a sibling artifact past check 9.
            if !scope.guaranteed.contains(artifact) {
                if !path.is_empty() {
                    return Err(failure(9, "nullable latest must be guarded"));
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
            let item = list_item(&source_type, scope, "a list predicate")?;
            require_boolean(
                infer(predicate, &scope.with_item(item))?,
                "a list predicate",
            )?;
            Ok(match expression {
                StageExpr::Filter { .. } => source_type,
                _ => boolean(),
            })
        }
        StageExpr::MapOf { source, value } => {
            let item = list_item(&infer(source, scope)?, scope, "map")?;
            let value_type = infer(value, &scope.with_item(item))?;
            Ok(Type::List {
                item: Box::new(value_type),
            })
        }
        StageExpr::Contains { source, value } => {
            let item = list_item(&infer(source, scope)?, scope, "contains")?;
            let value_type = infer(value, scope)?;
            if !comparable(&item, &value_type, scope) {
                return Err(failure(
                    9,
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
            let item = list_item(&infer(source, scope)?, scope, "lookup")?;
            let field_ty = field_type(&item, &[field], scope.aliases)
                .ok_or_else(|| failure(1, format!("lookup field {field} absent")))?;
            if !comparable(&field_ty, &infer(key, scope)?, scope) {
                return Err(failure(
                    9,
                    format!("lookup key does not compare with {field}"),
                ));
            }
            read_path(&item, path, scope, "lookup field absent")
        }
        StageExpr::ValidGraph {
            source,
            key_field,
            dependencies_field,
        } => {
            let item = list_item(&infer(source, scope)?, scope, "valid_graph")?;
            let key = field_type(&item, &[key_field], scope.aliases)
                .map(|ty| comparison_shape(&ty, scope))
                .filter(is_string_like)
                .ok_or_else(|| failure(9, format!("valid_graph key {key_field} must be text")))?;
            let dependencies = field_type(&item, &[dependencies_field], scope.aliases)
                .and_then(|ty| item_type(&resolve_type(&ty, scope.aliases)))
                .ok_or_else(|| {
                    failure(
                        9,
                        format!("valid_graph {dependencies_field} must be a list"),
                    )
                })?;
            if !comparable(&key, &dependencies, scope) {
                return Err(failure(9, "valid_graph dependencies must be keys"));
            }
            Ok(boolean())
        }
        StageExpr::Record(fields) => Ok(Type::Record {
            fields: fields
                .iter()
                .map(|(key, value)| Ok((key.clone(), infer(value, scope)?)))
                .collect::<Result<_, DomainError>>()?,
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
                .ok_or_else(|| failure(3, "each outside collection"))?;
            read_path(each, path, scope, "each field absent")
        }
        StageExpr::Item(path) => {
            let item = scope
                .item
                .as_ref()
                .ok_or_else(|| failure(1, "item outside every, any, filter or map"))?;
            read_path(item, path, scope, "item field absent")
        }
        StageExpr::Outcome { unit, path } => {
            if scope.collections.contains(unit) {
                return Err(failure(
                    4,
                    format!("collection {unit} outcome is read only through map"),
                ));
            }
            // A unit input's scope holds exactly the outcomes of its `after`
            // units, so a miss there is a read outside `after` (check 3).
            let ty = scope.outcomes.get(unit).ok_or_else(|| {
                failure(
                    3,
                    format!("unit outcome {unit} absent or outside read scope"),
                )
            })?;
            if path.is_empty() {
                return Ok(ty.clone());
            }
            field_type(ty, &segments(path), scope.aliases)
                .ok_or_else(|| failure(4, "unit outcome field absent"))
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
                return Err(failure(4, "expression reads inside another unit"));
            }
            Err(failure(1, format!("unknown expression {head}")))
        }
        StageExpr::Boolean(_) => Ok(boolean()),
        StageExpr::Integer(_) => Ok(integer()),
        StageExpr::Text(_) => Ok(Type::Text),
    }
}
