//! Stage expressions (part 1 §2.4): parsed once into a typed shape, checked
//! against a scope, and resolved to the shared Expression tree the evaluator
//! walks.
//!
//! Precedence, loosest first: `or`, `and`, `not`, a comparison (`==`, `!=`,
//! `>`, `>=`, `<`, `<=`), then an atom: a call, a record literal, a literal or
//! a read. Inside `every`, `any`, `filter` and `map`, `item` is the element.
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
    Spanned(Box<StageExpr>, SourceSpan),
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
    Default {
        value: Box<StageExpr>,
        fallback: Box<StageExpr>,
        path: Vec<String>,
    },
    Require {
        value: Box<StageExpr>,
        path: Vec<String>,
    },
    Field {
        value: Box<StageExpr>,
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
impl StageExpr {
    pub(crate) fn into_unspanned(self) -> Self {
        match self {
            Self::Spanned(inner, _) => inner.into_unspanned(),
            other => other,
        }
    }
}

#[path = "expression_check.rs"]
mod check;
#[path = "expression_lower.rs"]
mod lower;
#[path = "expression_parse.rs"]
mod parse;
pub(crate) use check::infer;
pub(crate) use guaranteed_artifacts as proven_artifacts;
use lower::resolve;
pub(crate) use parse::parse_expression;
pub(crate) use parse::parse_repository;
#[cfg(test)]
mod parser_regressions {
    use super::*;

    #[test]
    fn identifier_arguments_accept_expression_keywords() {
        let published = parse_expression("published(item)", "test").unwrap();
        assert!(matches!(published, StageExpr::Published(name) if name == "item"));
        let lookup = parse_expression("lookup(input.items, input, 1)", "test").unwrap();
        assert!(matches!(lookup, StageExpr::Lookup { field, .. } if field == "input"));
        let graph = parse_expression("valid_graph(input.items, each, not)", "test").unwrap();
        assert!(
            matches!(graph, StageExpr::ValidGraph { key_field, dependencies_field, .. }
            if key_field == "each" && dependencies_field == "not")
        );
    }
}
pub(crate) fn guaranteed_artifacts(expression: &StageExpr) -> BTreeSet<String> {
    match expression {
        StageExpr::Spanned(inner, _) => guaranteed_artifacts(inner),
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
#[derive(Clone)]
pub(crate) struct Scope<'a> {
    pub input: &'a TypeExpression,
    pub artifacts: &'a BTreeMap<String, Artifact>,
    pub outcomes: &'a BTreeMap<String, TypeExpression>,
    pub each: Option<TypeExpression>,
    pub item: Option<TypeExpression>,
    pub aliases: &'a BTreeMap<String, TypeExpression>,
    pub lets: &'a BTreeMap<String, String>,
    pub body: Option<(&'a str, &'a TypeExpression)>,
    pub guaranteed: BTreeSet<String>,
    /// Collection units in `outcomes`: a collection has one outcome per
    /// member, so its outcome is read only through `map`.
    pub collections: BTreeSet<String>,
    pub diagnostic_path: String,
    pub diagnostic_span: SourceSpan,
}
impl Scope<'_> {
    pub(crate) fn at(&self, path: &str, text: &str) -> Self {
        Self {
            diagnostic_path: path.to_owned(),
            diagnostic_span: SourceSpan {
                start: 0,
                end: text.len(),
            },
            ..self.clone()
        }
    }
    fn error(&self, check: CheckKind, detail: impl Into<String>) -> CompileError {
        CompileError::new(check, &self.diagnostic_path, self.diagnostic_span, detail)
    }
    fn for_expr(&self, expression: &StageExpr) -> Self {
        match expression {
            StageExpr::Spanned(_, span) => Self {
                diagnostic_span: *span,
                ..self.clone()
            },
            _ => self.clone(),
        }
    }
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
pub(crate) fn expand_lets(
    expression: StageExpr,
    definitions: &BTreeMap<String, String>,
    visiting: &mut BTreeSet<String>,
) -> Result<StageExpr, CompileError> {
    let expand = |value, visiting: &mut BTreeSet<String>| expand_lets(value, definitions, visiting);
    Ok(match expression {
        StageExpr::Name { head, path } if definitions.contains_key(&head) => {
            let source = &definitions[&head];
            let location = format!("stages.let.{head}");
            if !visiting.insert(head.clone()) {
                return Err(CompileError::new(
                    CheckKind::Name,
                    location,
                    SourceSpan {
                        start: 0,
                        end: source.len(),
                    },
                    format!("recursive let {head}"),
                ));
            }
            let value = expand(parse_expression(source, &location)?, visiting)?;
            visiting.remove(&head);
            if path.is_empty() {
                value
            } else {
                StageExpr::Field {
                    value: Box::new(value),
                    path,
                }
            }
        }
        StageExpr::Spanned(inner, span) => {
            StageExpr::Spanned(Box::new(expand(*inner, visiting)?), span)
        }
        StageExpr::Or(left, right) => StageExpr::Or(
            Box::new(expand(*left, visiting)?),
            Box::new(expand(*right, visiting)?),
        ),
        StageExpr::And(left, right) => StageExpr::And(
            Box::new(expand(*left, visiting)?),
            Box::new(expand(*right, visiting)?),
        ),
        StageExpr::Not(inner) => StageExpr::Not(Box::new(expand(*inner, visiting)?)),
        StageExpr::Equality {
            is_negated,
            left,
            right,
        } => StageExpr::Equality {
            is_negated,
            left: Box::new(expand(*left, visiting)?),
            right: Box::new(expand(*right, visiting)?),
        },
        StageExpr::Compare {
            operator,
            left,
            right,
        } => StageExpr::Compare {
            operator,
            left: Box::new(expand(*left, visiting)?),
            right: Box::new(expand(*right, visiting)?),
        },
        StageExpr::Len(inner) => StageExpr::Len(Box::new(expand(*inner, visiting)?)),
        StageExpr::Every { source, predicate } => StageExpr::Every {
            source: Box::new(expand(*source, visiting)?),
            predicate: Box::new(expand(*predicate, visiting)?),
        },
        StageExpr::Any { source, predicate } => StageExpr::Any {
            source: Box::new(expand(*source, visiting)?),
            predicate: Box::new(expand(*predicate, visiting)?),
        },
        StageExpr::Filter { source, predicate } => StageExpr::Filter {
            source: Box::new(expand(*source, visiting)?),
            predicate: Box::new(expand(*predicate, visiting)?),
        },
        StageExpr::MapOf { source, value } => StageExpr::MapOf {
            source: Box::new(expand(*source, visiting)?),
            value: Box::new(expand(*value, visiting)?),
        },
        StageExpr::Contains { source, value } => StageExpr::Contains {
            source: Box::new(expand(*source, visiting)?),
            value: Box::new(expand(*value, visiting)?),
        },
        StageExpr::Lookup {
            source,
            field,
            key,
            path,
        } => StageExpr::Lookup {
            source: Box::new(expand(*source, visiting)?),
            field,
            key: Box::new(expand(*key, visiting)?),
            path,
        },
        StageExpr::Default {
            value,
            fallback,
            path,
        } => StageExpr::Default {
            value: Box::new(expand(*value, visiting)?),
            fallback: Box::new(expand(*fallback, visiting)?),
            path,
        },
        StageExpr::Require { value, path } => StageExpr::Require {
            value: Box::new(expand(*value, visiting)?),
            path,
        },
        StageExpr::Field { value, path } => StageExpr::Field {
            value: Box::new(expand(*value, visiting)?),
            path,
        },
        StageExpr::ValidGraph {
            source,
            key_field,
            dependencies_field,
        } => StageExpr::ValidGraph {
            source: Box::new(expand(*source, visiting)?),
            key_field,
            dependencies_field,
        },
        StageExpr::Record(fields) => StageExpr::Record(
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, expand(value, visiting)?)))
                .collect::<Result<_, CompileError>>()?,
        ),
        other => other,
    })
}
pub(crate) fn checked(
    text: &str,
    scope: &Scope<'_>,
    path: &str,
) -> Result<CheckedStageExpression, CompileError> {
    let parsed = expand_lets(
        parse_expression(text, path)?,
        scope.lets,
        &mut BTreeSet::new(),
    )?;
    let scope = scope.at(path, text);
    Ok(CheckedStageExpression {
        source: text.into(),
        value_type: infer(&parsed, &scope)?,
        expression: resolve(&parsed),
    })
}
/// A boolean guard (`done_when`, a worker's or review's `when`), and the
/// artifacts it proves published when it holds.
pub(crate) fn checked_guard(
    text: &str,
    scope: &Scope<'_>,
    path: &str,
    check: CheckKind,
    what: &str,
) -> Result<(CheckedStageExpression, BTreeSet<String>), CompileError> {
    let parsed = expand_lets(
        parse_expression(text, path)?,
        scope.lets,
        &mut BTreeSet::new(),
    )?;
    let scope = scope.at(path, text);
    let value_type = infer(&parsed, &scope)?;
    if value_type != Type::Boolean {
        return Err(scope.error(check, format!("{what} is not boolean")));
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
