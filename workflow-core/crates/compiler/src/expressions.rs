//! Stage expressions (part 1 §2.4): parsed once into a typed shape, checked
//! against a scope, and resolved to the shared Expression tree the evaluator
//! walks.
//!
//! Precedence, loosest first: `or`, `and`, `not`, a comparison (`==`, `!=`,
//! `>`, `>=`, `<`, `<=`), then an atom: a call, a record literal, a literal or
//! a read. Inside `every`, `any`, `filter` and `map`, `item` is the element.
use crate::workflow::failure;
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

#[path = "expression_check.rs"]
mod check;
#[path = "expression_lower.rs"]
mod lower;
/// Byte offsets of `text` that sit outside quotes and at bracket depth zero.
/// A backslash escapes the next character inside a quoted literal.
#[path = "expression_parse.rs"]
mod parse;
pub(crate) use check::infer;
pub(crate) use guaranteed_artifacts as proven_artifacts;
use lower::resolve;
pub(crate) use parse::parse_expression;
pub(crate) use parse::parse_repository;
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
    /// Collection units in `outcomes`: a collection has one outcome per
    /// member, so its outcome is read only through `map`.
    pub collections: BTreeSet<String>,
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
    if value_type != Type::Boolean {
        return Err(failure(class, format!("{what} is not boolean")));
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
