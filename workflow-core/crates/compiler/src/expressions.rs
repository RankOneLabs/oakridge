//! Stage expressions (part 1 §2.4): parsed once into a typed shape, checked
//! against a scope, and resolved to the shared Expression tree the evaluator
//! walks.
//!
//! Precedence, loosest first: `or`, `and`, `not`, a comparison (`==`, `!=`,
//! `>`, `>=`, `<`, `<=`), then an atom: a call, a record literal, a literal or
//! a read. Inside `every`, `any`, `filter` and `map`, `item` is the element.
use crate::scopes::{field_type, item_type, parse_type, reject, render_type, resolve_type};
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Comparison {
    Greater,
    GreaterOrEqual,
    Less,
    LessOrEqual,
}
#[derive(Clone, Debug)]
pub(crate) enum StageExpr {
    Or(Box<StageExpr>, Box<StageExpr>),
    And(Box<StageExpr>, Box<StageExpr>),
    Not(Box<StageExpr>),
    /// `==` (or `!=` when negated): JSON equality of comparable values.
    Equality {
        is_negated: bool,
        left: Box<StageExpr>,
        right: Box<StageExpr>,
    },
    /// All four integer comparisons share one typing rule; the operator is
    /// carried so the resolved expression keeps it.
    Compare {
        operator: Comparison,
        left: Box<StageExpr>,
        right: Box<StageExpr>,
    },
    Len(Box<StageExpr>),
    Published(String),
    Approved(String),
    ChangesRequested(String),
    Latest {
        artifact: String,
        path: Vec<String>,
    },
    Every {
        source: Box<StageExpr>,
        predicate: Box<StageExpr>,
    },
    Any {
        source: Box<StageExpr>,
        predicate: Box<StageExpr>,
    },
    Filter {
        source: Box<StageExpr>,
        predicate: Box<StageExpr>,
    },
    MapOf {
        source: Box<StageExpr>,
        value: Box<StageExpr>,
    },
    Contains {
        source: Box<StageExpr>,
        value: Box<StageExpr>,
    },
    /// The one element whose `field` equals `key`, then `path` into it.
    Lookup {
        source: Box<StageExpr>,
        field: String,
        key: Box<StageExpr>,
        path: Vec<String>,
    },
    /// Keys legal and unique, dependencies unique and present, no cycle.
    ValidGraph {
        source: Box<StageExpr>,
        key_field: String,
        dependencies_field: String,
    },
    Record(Vec<(String, StageExpr)>),
    Input(Vec<String>),
    Each(Vec<String>),
    Item(Vec<String>),
    /// A bare name and field path: the validate-check binding when the name
    /// matches the artifact under validation, and otherwise unresolvable.
    Name {
        head: String,
        path: Vec<String>,
    },
    Outcome {
        unit: String,
        path: Vec<String>,
    },
    Boolean(bool),
    Integer(i64),
    Text(String),
}

/// Byte offsets of `text` that sit outside quotes and at bracket depth zero.
/// A backslash escapes the next character inside a quoted literal.
fn top_level_offsets(text: &str) -> Vec<usize> {
    let mut offsets = Vec::new();
    let mut depth = 0usize;
    let mut is_quoted = false;
    let mut is_escaped = false;
    for (index, ch) in text.char_indices() {
        if is_quoted {
            match ch {
                _ if is_escaped => is_escaped = false,
                '\\' => is_escaped = true,
                '"' => is_quoted = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => is_quoted = true,
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => offsets.push(index),
            _ => {}
        }
    }
    offsets
}
/// Operands either side of the first top-level `keyword` set off by whitespace.
fn split_keyword<'a>(text: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    let bytes = text.as_bytes();
    top_level_offsets(text).into_iter().find_map(|index| {
        let end = index + keyword.len();
        let is_word = text[index..].starts_with(keyword)
            && index > 0
            && bytes[index - 1].is_ascii_whitespace()
            && bytes.get(end).is_some_and(u8::is_ascii_whitespace);
        is_word.then(|| (text[..index].trim(), text[end..].trim()))
    })
}
/// Comma-separated arguments at bracket depth zero and outside quotes.
fn split_arguments(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0usize;
    for index in top_level_offsets(text) {
        if text.as_bytes()[index] == b',' {
            pieces.push(text[start..index].trim());
            start = index + 1;
        }
    }
    pieces.push(text[start..].trim());
    pieces
}
/// The argument of `function(..)` and whatever trails its closing paren,
/// matched at depth and outside quotes so a nested call or a quoted paren does
/// not end the argument early.
pub(crate) fn split_call<'a>(text: &'a str, function: &str) -> Option<(&'a str, &'a str)> {
    let inner = text.strip_prefix(function)?.strip_prefix('(')?;
    let mut depth = 1usize;
    let mut is_quoted = false;
    let mut is_escaped = false;
    for (index, ch) in inner.char_indices() {
        if is_quoted {
            match ch {
                _ if is_escaped => is_escaped = false,
                '\\' => is_escaped = true,
                '"' => is_quoted = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => is_quoted = true,
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return (ch == ')').then(|| (inner[..index].trim(), inner[index + 1..].trim()));
                }
            }
            _ => {}
        }
    }
    None
}
/// Operands and operator at the first top-level comparison.
fn split_comparison(text: &str) -> Option<(&str, &str, &str)> {
    let bytes = text.as_bytes();
    top_level_offsets(text).into_iter().find_map(|index| {
        let next = bytes.get(index + 1).copied();
        let operator = match (bytes[index], next) {
            (b'=', Some(b'=')) => "==",
            (b'!', Some(b'=')) => "!=",
            (b'>', Some(b'=')) => ">=",
            (b'<', Some(b'=')) => "<=",
            (b'>', _) => ">",
            (b'<', _) => "<",
            _ => return None,
        };
        let end = index + operator.len();
        Some((text[..index].trim(), operator, text[end..].trim()))
    })
}
fn path_of(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('.').map(|part| part.trim().to_owned()).collect()
    }
}
/// What trails a call: nothing, or `.field.path` when `allows_path`.
fn trailing_path(
    trailing: &str,
    function: &str,
    allows_path: bool,
) -> Result<Vec<String>, DomainError> {
    match trailing.strip_prefix('.') {
        Some(path) if allows_path && !path.is_empty() => Ok(path_of(path)),
        None if trailing.is_empty() => Ok(Vec::new()),
        _ => Err(reject(1, format!("unexpected {trailing} after {function}"))),
    }
}
fn arguments<'a>(
    inner: &'a str,
    function: &str,
    count: usize,
) -> Result<Vec<&'a str>, DomainError> {
    let parts = split_arguments(inner);
    if parts.len() != count || parts.iter().any(|part| part.is_empty()) {
        return Err(reject(1, format!("{function} takes {count} arguments")));
    }
    Ok(parts)
}
fn field_name(text: &str, function: &str) -> Result<String, DomainError> {
    let is_name = !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if !is_name {
        return Err(reject(1, format!("{function} field {text} is not a name")));
    }
    Ok(text.to_owned())
}
fn boxed(text: &str) -> Result<Box<StageExpr>, DomainError> {
    parse_expression(text).map(Box::new)
}
pub(crate) fn parse_expression(text: &str) -> Result<StageExpr, DomainError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(reject(1, "empty expression"));
    }
    if let Some((left, right)) = split_keyword(text, "or") {
        return Ok(StageExpr::Or(boxed(left)?, boxed(right)?));
    }
    if let Some((left, right)) = split_keyword(text, "and") {
        return Ok(StageExpr::And(boxed(left)?, boxed(right)?));
    }
    if let Some(rest) = text
        .strip_prefix("not")
        .filter(|rest| rest.starts_with(char::is_whitespace))
    {
        return Ok(StageExpr::Not(boxed(rest)?));
    }
    if let Some((left, operator, right)) = split_comparison(text) {
        let (left, right) = (boxed(left)?, boxed(right)?);
        let compare = |operator| StageExpr::Compare {
            operator,
            left: left.clone(),
            right: right.clone(),
        };
        return Ok(match operator {
            "==" | "!=" => StageExpr::Equality {
                is_negated: operator == "!=",
                left,
                right,
            },
            ">" => compare(Comparison::Greater),
            ">=" => compare(Comparison::GreaterOrEqual),
            "<" => compare(Comparison::Less),
            _ => compare(Comparison::LessOrEqual),
        });
    }
    parse_atom(text)
}
fn parse_atom(text: &str) -> Result<StageExpr, DomainError> {
    if let Some((argument, trailing)) = split_call(text, "len") {
        trailing_path(trailing, "len", false)?;
        return Ok(StageExpr::Len(boxed(argument)?));
    }
    for function in ["published", "approved", "changes_requested"] {
        if let Some((artifact, trailing)) = split_call(text, function) {
            trailing_path(trailing, function, false)?;
            let artifact = artifact.to_owned();
            return Ok(match function {
                "published" => StageExpr::Published(artifact),
                "approved" => StageExpr::Approved(artifact),
                _ => StageExpr::ChangesRequested(artifact),
            });
        }
    }
    if let Some((artifact, trailing)) = split_call(text, "latest") {
        let path = trailing_path(trailing, "latest", true)
            .map_err(|_| reject(1, "latest path malformed"))?;
        return Ok(StageExpr::Latest {
            artifact: artifact.to_owned(),
            path,
        });
    }
    for function in ["every", "any", "filter", "map", "contains"] {
        if let Some((inner, trailing)) = split_call(text, function) {
            trailing_path(trailing, function, false)?;
            let parts = arguments(inner, function, 2)?;
            let (source, second) = (boxed(parts[0])?, boxed(parts[1])?);
            return Ok(match function {
                "every" => StageExpr::Every {
                    source,
                    predicate: second,
                },
                "any" => StageExpr::Any {
                    source,
                    predicate: second,
                },
                "filter" => StageExpr::Filter {
                    source,
                    predicate: second,
                },
                "map" => StageExpr::MapOf {
                    source,
                    value: second,
                },
                _ => StageExpr::Contains {
                    source,
                    value: second,
                },
            });
        }
    }
    if let Some((inner, trailing)) = split_call(text, "lookup") {
        let path = trailing_path(trailing, "lookup", true)?;
        let parts = arguments(inner, "lookup", 3)?;
        return Ok(StageExpr::Lookup {
            source: boxed(parts[0])?,
            field: field_name(parts[1], "lookup")?,
            key: boxed(parts[2])?,
            path,
        });
    }
    if let Some((inner, trailing)) = split_call(text, "valid_graph") {
        trailing_path(trailing, "valid_graph", false)?;
        let parts = arguments(inner, "valid_graph", 3)?;
        return Ok(StageExpr::ValidGraph {
            source: boxed(parts[0])?,
            key_field: field_name(parts[1], "valid_graph")?,
            dependencies_field: field_name(parts[2], "valid_graph")?,
        });
    }
    if let Some(body) = text
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
    {
        let mut fields = Vec::new();
        let mut seen = BTreeSet::new();
        if !body.trim().is_empty() {
            for field in split_arguments(body) {
                let (key, value) = field
                    .split_once(':')
                    .ok_or_else(|| reject(1, format!("malformed record field {field}")))?;
                let key = field_name(key.trim(), "record")?;
                if !seen.insert(key.clone()) {
                    return Err(reject(11, format!("duplicate record field {key}")));
                }
                fields.push((key, parse_expression(value)?));
            }
        }
        return Ok(StageExpr::Record(fields));
    }
    if text == "true" || text == "false" {
        return Ok(StageExpr::Boolean(text == "true"));
    }
    if let Ok(value) = text.parse::<i64>() {
        return Ok(StageExpr::Integer(value));
    }
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        return serde_json::from_str::<String>(text)
            .map(StageExpr::Text)
            .map_err(|error| reject(1, format!("malformed text literal: {error}")));
    }
    if text.contains(['(', ')', '{', '}', '"', ' ', ',']) {
        return Err(reject(1, format!("unknown expression {text}")));
    }
    let (head, trailing) = text.split_once('.').unwrap_or((text, ""));
    let path = path_of(trailing);
    match head {
        "input" => Ok(StageExpr::Input(path)),
        "each" => Ok(StageExpr::Each(path)),
        "item" => Ok(StageExpr::Item(path)),
        _ if path.first().is_some_and(|segment| segment == "outcome") => Ok(StageExpr::Outcome {
            unit: head.to_owned(),
            path: path[1..].to_vec(),
        }),
        _ => Ok(StageExpr::Name {
            head: head.to_owned(),
            path,
        }),
    }
}
/// Artifacts an expression that holds proves already have a revision: a bare
/// publication or approval guard, either side of an `and`, both sides of an
/// `or`. A comparison, a length or a negation proves nothing about one.
pub(crate) fn guaranteed_artifacts(expression: &StageExpr) -> BTreeSet<String> {
    match expression {
        StageExpr::Published(artifact) | StageExpr::Approved(artifact) => {
            BTreeSet::from([artifact.clone()])
        }
        StageExpr::And(left, right) => guaranteed_artifacts(left)
            .union(&guaranteed_artifacts(right))
            .cloned()
            .collect(),
        StageExpr::Or(left, right) => guaranteed_artifacts(left)
            .intersection(&guaranteed_artifacts(right))
            .cloned()
            .collect(),
        _ => BTreeSet::new(),
    }
}
fn segments(path: &[String]) -> Vec<&str> {
    path.iter().map(String::as_str).collect()
}
#[derive(Clone)]
pub(crate) struct Scope<'a> {
    pub input: &'a TypeExpression,
    pub artifacts: &'a BTreeMap<String, Artifact>,
    pub outcomes: &'a BTreeMap<String, TypeExpression>,
    pub each: Option<TypeExpression>,
    pub item: Option<TypeExpression>,
    pub aliases: &'a BTreeMap<String, TypeExpression>,
    pub body: Option<(&'a str, &'a TypeExpression)>,
    pub guaranteed: BTreeSet<String>,
}
impl Scope<'_> {
    fn guarded_by(&self, expression: &StageExpr) -> Self {
        let mut scope = self.clone();
        scope.guaranteed.extend(guaranteed_artifacts(expression));
        scope
    }
    fn with_item(&self, item: TypeExpression) -> Self {
        Self {
            item: Some(item),
            ..self.clone()
        }
    }
}
fn boolean() -> TypeExpression {
    TypeExpression::Name("boolean".into())
}
fn integer() -> TypeExpression {
    TypeExpression::Name("integer".into())
}
fn list_item(
    ty: &TypeExpression,
    scope: &Scope<'_>,
    function: &str,
) -> Result<TypeExpression, DomainError> {
    item_type(&resolve_type(ty, scope.aliases))
        .ok_or_else(|| reject(9, format!("{function} requires a list")))
}
fn require_boolean(ty: TypeExpression, what: &str) -> Result<(), DomainError> {
    if ty != boolean() {
        return Err(reject(9, format!("{what} must be boolean")));
    }
    Ok(())
}
/// The variants of an `enum(a, b, …)` type.
pub(crate) fn enum_variants(ty: &TypeExpression) -> Option<Vec<String>> {
    let TypeExpression::Name(name) = ty else {
        return None;
    };
    let inner = name.trim().strip_prefix("enum(")?.strip_suffix(')')?;
    Some(inner.split(',').map(|v| v.trim().to_owned()).collect())
}
/// A type with its aliases resolved and an outer `optional(...)` removed, so
/// a value compares with a nullable value of its own type.
fn comparison_shape(ty: &TypeExpression, scope: &Scope<'_>) -> TypeExpression {
    let resolved = resolve_type(ty, scope.aliases);
    if let TypeExpression::Name(name) = &resolved {
        if let Some(inner) = name
            .strip_prefix("optional(")
            .and_then(|s| s.strip_suffix(')'))
        {
            return comparison_shape(&parse_type(inner).unwrap_or(resolved.clone()), scope);
        }
    }
    resolved
}
fn is_string_like(ty: &TypeExpression) -> bool {
    matches!(ty, TypeExpression::Name(name) if ["text", "ident", "repo_path"].contains(&name.as_str()))
        || enum_variants(ty).is_some()
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
        return Err(reject(
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
    field_type(ty, &segments(path), scope.aliases).ok_or_else(|| reject(1, missing.to_owned()))
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
                return Err(reject(
                    9,
                    format!(
                        "cannot compare {} with {}",
                        render_type(&left_type),
                        render_type(&right_type)
                    ),
                ));
            }
            check_enum_literal(&left_type, right, scope)?;
            check_enum_literal(&right_type, left, scope)?;
            Ok(boolean())
        }
        StageExpr::Compare { left, right, .. } => {
            if infer(left, scope)? != integer() || infer(right, scope)? != integer() {
                return Err(reject(9, "integer comparison requires integer operands"));
            }
            Ok(boolean())
        }
        StageExpr::Len(inner) => {
            let ty = resolve_type(&infer(inner, scope)?, scope.aliases);
            if ty != TypeExpression::Name("text".into()) && item_type(&ty).is_none() {
                return Err(reject(9, "len requires text or list"));
            }
            Ok(integer())
        }
        StageExpr::Published(artifact)
        | StageExpr::Approved(artifact)
        | StageExpr::ChangesRequested(artifact) => {
            if !scope.artifacts.contains_key(artifact) {
                return Err(reject(1, format!("artifact {artifact} absent")));
            }
            Ok(boolean())
        }
        StageExpr::Latest { artifact, path } => {
            let schema = &scope
                .artifacts
                .get(artifact)
                .ok_or_else(|| reject(1, format!("artifact {artifact} absent")))?
                .schema;
            // A guard names the artifact it proves. Treating any publication
            // guard as proof for every artifact let an unguarded field read
            // of a sibling artifact past check 9.
            if !scope.guaranteed.contains(artifact) {
                if !path.is_empty() {
                    return Err(reject(9, "nullable latest must be guarded"));
                }
                return Ok(TypeExpression::Name(format!(
                    "optional({})",
                    render_type(schema)
                )));
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
            Ok(TypeExpression::Name(format!(
                "list({})",
                render_type(&value_type)
            )))
        }
        StageExpr::Contains { source, value } => {
            let item = list_item(&infer(source, scope)?, scope, "contains")?;
            let value_type = infer(value, scope)?;
            if !comparable(&item, &value_type, scope) {
                return Err(reject(
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
                .ok_or_else(|| reject(1, format!("lookup field {field} absent")))?;
            if !comparable(&field_ty, &infer(key, scope)?, scope) {
                return Err(reject(
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
                .ok_or_else(|| reject(9, format!("valid_graph key {key_field} must be text")))?;
            let dependencies = field_type(&item, &[dependencies_field], scope.aliases)
                .and_then(|ty| item_type(&resolve_type(&ty, scope.aliases)))
                .ok_or_else(|| {
                    reject(
                        9,
                        format!("valid_graph {dependencies_field} must be a list"),
                    )
                })?;
            if !comparable(&key, &dependencies, scope) {
                return Err(reject(9, "valid_graph dependencies must be keys"));
            }
            Ok(boolean())
        }
        StageExpr::Record(fields) => Ok(TypeExpression::Record(
            fields
                .iter()
                .map(|(key, value)| Ok((key.clone(), infer(value, scope)?)))
                .collect::<Result<_, DomainError>>()?,
        )),
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
                .ok_or_else(|| reject(3, "each outside collection"))?;
            read_path(each, path, scope, "each field absent")
        }
        StageExpr::Item(path) => {
            let item = scope
                .item
                .as_ref()
                .ok_or_else(|| reject(1, "item outside every, any, filter or map"))?;
            read_path(item, path, scope, "item field absent")
        }
        StageExpr::Outcome { unit, path } => {
            let ty = scope.outcomes.get(unit).ok_or_else(|| {
                reject(
                    1,
                    format!("unit outcome {unit} absent or outside read scope"),
                )
            })?;
            if path.is_empty() {
                return Ok(ty.clone());
            }
            field_type(ty, &segments(path), scope.aliases)
                .ok_or_else(|| reject(4, "unit outcome field absent"))
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
                return Err(reject(4, "expression reads inside another unit"));
            }
            Err(reject(1, format!("unknown expression {head}")))
        }
        StageExpr::Boolean(_) => Ok(boolean()),
        StageExpr::Integer(_) => Ok(integer()),
        StageExpr::Text(_) => Ok(TypeExpression::Name("text".into())),
    }
}
/// Resolve a parsed stage expression to the shared Expression tree, so the
/// evaluator walks a compiled form instead of re-parsing the source.
pub(crate) fn resolve(expression: &StageExpr) -> Expression {
    fn reference(root: ReferenceRoot, path: &[String]) -> Expression {
        Expression::Reference {
            root,
            path: path.to_vec(),
        }
    }
    fn artifact(key: &str) -> SymbolKey {
        SymbolKey::from(key)
    }
    let boxed = |inner: &StageExpr| Box::new(resolve(inner));
    match expression {
        StageExpr::Or(left, right) => Expression::Any {
            items: vec![resolve(left), resolve(right)],
        },
        StageExpr::And(left, right) => Expression::All {
            items: vec![resolve(left), resolve(right)],
        },
        StageExpr::Not(inner) => Expression::Not {
            value: boxed(inner),
        },
        StageExpr::Equality {
            is_negated,
            left,
            right,
        } => {
            let equals = Expression::Equals {
                left: boxed(left),
                right: boxed(right),
            };
            if *is_negated {
                Expression::Not {
                    value: Box::new(equals),
                }
            } else {
                equals
            }
        }
        StageExpr::Compare {
            operator,
            left,
            right,
        } => {
            let (left, right) = (boxed(left), boxed(right));
            match operator {
                Comparison::Greater => Expression::GreaterThan { left, right },
                Comparison::GreaterOrEqual => Expression::GreaterOrEqual { left, right },
                Comparison::Less => Expression::LessThan { left, right },
                Comparison::LessOrEqual => Expression::LessOrEqual { left, right },
            }
        }
        StageExpr::Len(inner) => Expression::Len {
            value: boxed(inner),
        },
        StageExpr::Published(key) => reference(
            ReferenceRoot::Published {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::Approved(key) => reference(
            ReferenceRoot::Approved {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::ChangesRequested(key) => reference(
            ReferenceRoot::ChangesRequested {
                artifact: artifact(key),
            },
            &[],
        ),
        StageExpr::Latest {
            artifact: key,
            path,
        } => reference(
            ReferenceRoot::Latest {
                artifact: artifact(key),
            },
            path,
        ),
        StageExpr::Every { source, predicate } => Expression::Every {
            source: boxed(source),
            predicate: boxed(predicate),
        },
        // any(xs, p) is not every(xs, not p).
        StageExpr::Any { source, predicate } => Expression::Not {
            value: Box::new(Expression::Every {
                source: boxed(source),
                predicate: Box::new(Expression::Not {
                    value: boxed(predicate),
                }),
            }),
        },
        StageExpr::Filter { source, predicate } => Expression::Filter {
            source: boxed(source),
            predicate: boxed(predicate),
        },
        StageExpr::MapOf { source, value } => Expression::Map {
            source: boxed(source),
            schema: SchemaId::from("map"),
            value: boxed(value),
        },
        StageExpr::Contains { source, value } => Expression::Contains {
            source: boxed(source),
            value: boxed(value),
        },
        StageExpr::Lookup {
            source,
            field,
            key,
            path,
        } => path.iter().fold(
            Expression::Lookup {
                source: boxed(source),
                key_field: field.clone(),
                key: boxed(key),
            },
            |value, segment| Expression::Field {
                value: Box::new(value),
                key: segment.clone(),
            },
        ),
        StageExpr::ValidGraph {
            source,
            key_field,
            dependencies_field,
        } => Expression::CheckCollection {
            source: boxed(source),
            key_field: key_field.clone(),
            dependencies_field: dependencies_field.clone(),
        },
        StageExpr::Record(fields) => Expression::Record {
            schema: SchemaId::from("record"),
            fields: fields
                .iter()
                .map(|(key, value)| FieldExpression {
                    key: key.clone(),
                    value: resolve(value),
                })
                .collect(),
        },
        StageExpr::Input(path) => reference(ReferenceRoot::UnitInput, path),
        StageExpr::Each(path) => reference(ReferenceRoot::EachMember, path),
        StageExpr::Item(path) => reference(ReferenceRoot::Item, path),
        StageExpr::Name { head, path } => reference(
            ReferenceRoot::ValidationBody {
                artifact: artifact(head),
            },
            path,
        ),
        StageExpr::Outcome { unit, path } => reference(
            ReferenceRoot::UnitOutcome {
                unit: SymbolKey::from(unit.as_str()),
            },
            path,
        ),
        StageExpr::Boolean(value) => Expression::Literal {
            schema: SchemaId::from("boolean"),
            value: serde_json::Value::Bool(*value),
        },
        StageExpr::Integer(value) => Expression::Literal {
            schema: SchemaId::from("integer"),
            value: serde_json::Value::from(*value),
        },
        StageExpr::Text(value) => Expression::Literal {
            schema: SchemaId::from("text"),
            value: serde_json::Value::String(value.clone()),
        },
    }
}
pub(crate) fn checked(
    text: &str,
    scope: &Scope<'_>,
) -> Result<CheckedStageExpression, DomainError> {
    let parsed = parse_expression(text)?;
    Ok(CheckedStageExpression {
        source: text.into(),
        value_type: infer(&parsed, scope)?,
        expression: resolve(&parsed),
    })
}
/// A boolean guard (`done_when`, a worker's or review's `when`), and the
/// artifacts it proves published when it holds.
pub(crate) fn checked_guard(
    text: &str,
    scope: &Scope<'_>,
    class: u8,
    what: &str,
) -> Result<(CheckedStageExpression, BTreeSet<String>), DomainError> {
    let parsed = parse_expression(text)?;
    let value_type = infer(&parsed, scope)?;
    if value_type != boolean() {
        return Err(reject(class, format!("{what} is not boolean")));
    }
    Ok((
        CheckedStageExpression {
            source: text.into(),
            value_type,
            expression: resolve(&parsed),
        },
        guaranteed_artifacts(&parsed),
    ))
}
