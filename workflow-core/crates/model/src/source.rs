use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Half-open UTF-8 byte range in a source expression.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceSpan {
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub start: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub end: usize,
}

/// Location in the workflow source, using dotted configuration segments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct SourcePath(pub String);

impl std::fmt::Display for SourcePath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}
/// The compiler check that rejected a source location.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    Name,
    Collection,
    Scope,
    Outcome,
    DependencyCycle,
    Workspace,
    Worker,
    Review,
    ExpressionType,
    Prompt,
    Schema,
    Operation,
}
impl CheckKind {
    pub fn number(self) -> u8 {
        match self {
            Self::Name => 1,
            Self::Collection => 2,
            Self::Scope => 3,
            Self::Outcome => 4,
            Self::DependencyCycle => 5,
            Self::Workspace => 6,
            Self::Worker => 7,
            Self::Review => 8,
            Self::ExpressionType => 9,
            Self::Prompt => 10,
            Self::Schema => 11,
            Self::Operation => 12,
        }
    }
}

/// A located compiler diagnostic. Spans are half-open byte ranges in the
/// source value named by `path`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CompileError {
    pub check: CheckKind,
    pub path: SourcePath,
    pub span: SourceSpan,
    pub detail: String,
}

impl CompileError {
    pub fn new(
        check: CheckKind,
        path: impl Into<String>,
        span: SourceSpan,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            check,
            path: SourcePath(path.into()),
            span,
            detail: detail.into(),
        }
    }
    pub fn as_domain_error(&self) -> DomainError {
        let mut error = DomainError::new(
            DomainErrorKind::InvalidWorkflow,
            format!("check {}", self.check.number()),
            self.detail.clone(),
        );
        error.path = self.path.0.clone().into();
        error.actual = format!("{}..{}", self.span.start, self.span.end).into();
        error
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimits {
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub max_list_items: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub max_depth: usize,
    #[serde(with = "crate::wire_numbers::index")]
    #[schemars(schema_with = "crate::wire_numbers::index::schema")]
    pub evaluation_budget: usize,
}
impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_list_items: 10_000,
            max_depth: crate::protocol::MAX_DEPTH_CEILING,
            evaluation_budget: 1_000_000,
        }
    }
}
impl ResourceLimits {
    /// Bound every JSON container before the compiler or evaluator walks it.
    pub fn check_value(&self, value: &Value) -> Result<(), &'static str> {
        fn visit(limits: &ResourceLimits, value: &Value, depth: usize) -> Result<(), &'static str> {
            match value {
                Value::Array(items) => {
                    if depth >= limits.max_depth {
                        return Err("max_depth exceeded");
                    }
                    if items.len() > limits.max_list_items {
                        return Err("max_list_items exceeded");
                    }
                    for item in items {
                        visit(limits, item, depth + 1)?;
                    }
                }
                Value::Object(fields) => {
                    if depth >= limits.max_depth {
                        return Err("max_depth exceeded");
                    }
                    for field in fields.values() {
                        visit(limits, field, depth + 1)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        visit(self, value, 0)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReferenceRoot {
    // The §2.2 stage scope. The compiler resolves stage expression text to
    // these roots so nothing re-parses the source at evaluation time.
    /// The element a finite list transform binds.
    Item,
    UnitInput,
    EachMember,
    ValidationBody {
        artifact: SymbolKey,
    },
    Latest {
        artifact: SymbolKey,
    },
    Published {
        artifact: SymbolKey,
    },
    Approved {
        artifact: SymbolKey,
    },
    ChangesRequested {
        artifact: SymbolKey,
    },
    UnitOutcome {
        unit: SymbolKey,
    },
    /// Every member outcome of a collection, in key order.
    MemberOutcomes {
        unit: SymbolKey,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expression {
    Literal {
        schema: SchemaId,
        #[serde(with = "crate::wire_numbers::json")]
        #[schemars(with = "Value")]
        value: Value,
    },
    Reference {
        root: ReferenceRoot,
        path: Vec<String>,
    },
    Record {
        fields: Vec<FieldExpression>,
    },
    List {
        schema: SchemaId,
        items: Vec<Expression>,
    },
    Equals {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Len {
        value: Box<Expression>,
    },
    GreaterThan {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    GreaterOrEqual {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    LessThan {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    LessOrEqual {
        left: Box<Expression>,
        right: Box<Expression>,
    },
    All {
        items: Vec<Expression>,
    },
    Any {
        items: Vec<Expression>,
    },
    Not {
        value: Box<Expression>,
    },
    Map {
        source: Box<Expression>,
        value: Box<Expression>,
    },
    Field {
        value: Box<Expression>,
        key: String,
    },
    Contains {
        source: Box<Expression>,
        value: Box<Expression>,
    },
    Lookup {
        source: Box<Expression>,
        key_field: String,
        key: Box<Expression>,
    },
    Filter {
        source: Box<Expression>,
        predicate: Box<Expression>,
    },
    CheckCollection {
        source: Box<Expression>,
        key_field: String,
        dependencies_field: String,
    },
    Every {
        source: Box<Expression>,
        predicate: Box<Expression>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FieldExpression {
    pub key: String,
    pub value: Expression,
}
// The workflow source model mirrors sections 2.1–2.3 of the core specification.
// Expressions are source text here; the compiler resolves them to Expression.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Workflow {
    pub workflow: SymbolKey,
    pub input: TypeExpression,
    #[serde(default)]
    pub schemas: BTreeMap<String, TypeExpression>,
    pub run: Group,
    pub stages: BTreeMap<String, Stage>,
}

/// A type is parsed once when a source workflow is loaded. `OutcomeOf` stays
/// unresolved until W5's name-resolution pass knows the stage's outcome.
#[derive(Clone, Debug, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Type {
    Text,
    Ident,
    RepoPath,
    Boolean,
    Integer,
    Enum { variants: Vec<String> },
    Optional { value: Box<Type> },
    List { item: Box<Type> },
    Record { fields: BTreeMap<String, Type> },
    Named { schema: SchemaKey },
    OutcomeOf { stage: SymbolKey },
}

#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct SchemaKey(pub String);

pub type TypeExpression = Type;

impl Type {
    /// Compatibility constructor for programmatic operation contracts.
    #[allow(non_snake_case)]
    pub fn Name(text: String) -> Self {
        Self::parse(&text).expect("programmatic type must be valid")
    }

    #[allow(non_snake_case)]
    pub fn Record(fields: BTreeMap<String, Type>) -> Self {
        Self::Record { fields }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if let Some(inner) = text.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            let mut fields = BTreeMap::new();
            if !inner.trim().is_empty() {
                for field in split_type_fields(inner)? {
                    let (key, value) = field
                        .split_once(':')
                        .ok_or_else(|| format!("malformed record field {field}"))?;
                    let key = key.trim();
                    if key.is_empty() || value.trim().is_empty() {
                        return Err(format!("malformed record field {field}"));
                    }
                    if fields.insert(key.to_owned(), Self::parse(value)?).is_some() {
                        return Err(format!("duplicate record field {key}"));
                    }
                }
            }
            return Ok(Self::Record { fields });
        }
        let nested = |name: &str| {
            text.strip_prefix(name)?
                .strip_prefix('(')?
                .strip_suffix(')')
        };
        if let Some(inner) = nested("list") {
            return Ok(Self::List {
                item: Box::new(Self::parse(inner)?),
            });
        }
        if let Some(inner) = nested("optional") {
            return Ok(Self::Optional {
                value: Box::new(Self::parse(inner)?),
            });
        }
        if let Some(inner) = nested("enum") {
            let variants = split_type_fields(inner)?
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let valid = |variant: &String| {
                !variant.is_empty()
                    && variant
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            };
            let unique = variants.iter().collect::<std::collections::BTreeSet<_>>();
            if !variants.iter().all(valid) || unique.len() != variants.len() {
                return Err(format!("malformed enum {text}"));
            }
            return Ok(Self::Enum { variants });
        }
        if let Some(inner) = nested("outcome_of") {
            if inner.trim().is_empty() {
                return Err(format!("malformed outcome_of {text}"));
            }
            return Ok(Self::OutcomeOf {
                stage: SymbolKey(inner.trim().to_owned()),
            });
        }
        match text {
            "text" => Ok(Self::Text),
            "ident" => Ok(Self::Ident),
            "repo_path" => Ok(Self::RepoPath),
            "boolean" => Ok(Self::Boolean),
            "integer" => Ok(Self::Integer),
            _ if !text.is_empty()
                && text.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || ch == '-'
                }) =>
            {
                Ok(Self::Named {
                    schema: SchemaKey(text.to_owned()),
                })
            }
            _ => Err(format!("malformed type {text}")),
        }
    }
}

impl std::fmt::Display for Type {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text => f.write_str("text"),
            Self::Ident => f.write_str("ident"),
            Self::RepoPath => f.write_str("repo_path"),
            Self::Boolean => f.write_str("boolean"),
            Self::Integer => f.write_str("integer"),
            Self::Enum { variants } => write!(f, "enum({})", variants.join(", ")),
            Self::Optional { value } => write!(f, "optional({value})"),
            Self::List { item } => write!(f, "list({item})"),
            Self::Record { fields } => write!(
                f,
                "{{{}}}",
                fields
                    .iter()
                    .map(|(key, ty)| format!("{key}: {ty}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::Named { schema } => f.write_str(&schema.0),
            Self::OutcomeOf { stage } => write!(f, "outcome_of({stage})"),
        }
    }
}

fn split_type_fields(text: &str) -> Result<Vec<&str>, String> {
    let (mut depth, mut start, mut fields) = (0isize, 0usize, Vec::new());
    for (index, ch) in text.char_indices() {
        match ch {
            '{' | '(' => depth += 1,
            '}' | ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("malformed type {text}"));
                }
            }
            ',' if depth == 0 => {
                fields.push(text[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(format!("malformed type {text}"));
    }
    fields.push(text[start..].trim());
    Ok(fields)
}

impl<'de> Deserialize<'de> for Type {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TypeVisitor;
        impl<'de> serde::de::Visitor<'de> for TypeVisitor {
            type Value = Type;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("compact type string or record")
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Type, E> {
                Type::parse(text).map_err(E::custom)
            }
            fn visit_string<E: serde::de::Error>(self, text: String) -> Result<Type, E> {
                self.visit_str(&text)
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Type, M::Error> {
                let mut fields = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Type>()? {
                    if fields.insert(key.clone(), value).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate record field {key}"
                        )));
                    }
                }
                Ok(Type::Record { fields })
            }
        }
        deserializer.deserialize_any(TypeVisitor)
    }
}

impl Serialize for Type {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        let kind = match self {
            Self::Text => "text",
            Self::Ident => "ident",
            Self::RepoPath => "repo_path",
            Self::Boolean => "boolean",
            Self::Integer => "integer",
            Self::Enum { .. } => "enum",
            Self::Optional { .. } => "optional",
            Self::List { .. } => "list",
            Self::Record { .. } => "record",
            Self::Named { .. } => "named",
            Self::OutcomeOf { .. } => "outcome_of",
        };
        map.serialize_entry("kind", kind)?;
        match self {
            Self::Enum { variants } => map.serialize_entry("variants", variants)?,
            Self::Optional { value } => map.serialize_entry("value", value)?,
            Self::List { item } => map.serialize_entry("item", item)?,
            Self::Record { fields } => map.serialize_entry("fields", fields)?,
            Self::Named { schema } => map.serialize_entry("schema", schema)?,
            Self::OutcomeOf { stage } => map.serialize_entry("stage", stage)?,
            _ => {}
        }
        map.end()
    }
}

#[cfg(test)]
mod type_tests {
    use super::*;

    #[test]
    fn compact_input_serializes_as_tagged_contract() {
        let ty: Type = serde_json::from_str("\"list(optional(text))\"").unwrap();
        assert_eq!(
            serde_json::to_value(ty).unwrap(),
            serde_json::json!({"kind":"list","item":{"kind":"optional","value":{"kind":"text"}}})
        );
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn misspelled_revise_prompt_is_a_load_error() {
        let source = include_str!("../../../fixtures/bundles/review-loop.json");
        let mut config: Value = serde_json::from_str(source).unwrap();
        config["stages"]["document"]["workers"]["writer"]["prompts"] =
            serde_json::json!({"initial": "write.md", "revsie": "revise.md"});
        assert!(serde_json::from_value::<Workflow>(config).is_err());
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Group {
    #[serde(default)]
    #[serde(with = "crate::wire_numbers::word_map")]
    #[schemars(schema_with = "crate::wire_numbers::word_map::schema")]
    pub pools: BTreeMap<String, u32>,
    pub units: BTreeMap<String, Unit>,
    pub outcome: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Unit {
    pub stage: Option<SymbolKey>,
    pub group: Option<Box<Group>>,
    #[serde(default)]
    pub input: BTreeMap<String, String>,
    #[serde(default)]
    pub after: UnitDependencies,
    pub for_each: Option<String>,
    pub key: Option<String>,
    pub pool: Option<SymbolKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum UnitDependencies {
    #[default]
    None,
    Fixed(Vec<SymbolKey>),
    Each(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub input: TypeExpression,
    pub artifacts: BTreeMap<String, Artifact>,
    pub workers: BTreeMap<String, Worker>,
    #[serde(default)]
    pub reviews: BTreeMap<String, Review>,
    pub done_when: Option<String>,
    pub outcome: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub schema: TypeExpression,
    #[serde(default)]
    pub validate: Vec<ValidationCheck>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ValidationCheck {
    pub check: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Worker {
    Agent {
        prompts: Prompts,
        inputs: BTreeMap<String, String>,
        creates: Vec<SymbolKey>,
        reviews: Option<SymbolKey>,
        runtime: Option<WorkerRuntime>,
        workspace: Option<String>,
        session: Option<SessionMode>,
        /// Optional guard: the worker is wanted only while it holds, and the
        /// artifacts it proves published type the worker's inputs.
        when: Option<String>,
    },
    Code {
        operation: SymbolKey,
        inputs: BTreeMap<String, String>,
        creates: Vec<SymbolKey>,
        every: Option<String>,
        when: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Prompts {
    pub initial: Option<String>,
    pub revise: Option<String>,
    pub review: Option<String>,
    pub handoff: Option<String>,
}

impl Prompts {
    pub fn get(&self, mode: &str) -> Option<&String> {
        match mode {
            "initial" => self.initial.as_ref(),
            "revise" => self.revise.as_ref(),
            "review" => self.review.as_ref(),
            "handoff" => self.handoff.as_ref(),
            _ => None,
        }
    }
    pub fn contains_key(&self, mode: &str) -> bool {
        self.get(mode).is_some()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &String)> {
        [
            ("initial", self.initial.as_ref()),
            ("revise", self.revise.as_ref()),
            ("review", self.review.as_ref()),
            ("handoff", self.handoff.as_ref()),
        ]
        .into_iter()
        .filter_map(|(mode, path)| path.map(|path| (mode, path)))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkerRuntime {
    pub harness: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Resume,
    Fresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub of: SymbolKey,
    pub by: ReviewBy,
    pub prompt: Option<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
    pub decisions: BTreeMap<String, ReviewDecision>,
    /// Optional for an operator review: it awaits a decision only while this
    /// holds. Required for an engine review: the engine decides when it holds.
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewBy {
    Operator,
    /// Decided by the engine, once per target revision, when `when` holds.
    Engine,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewDecision {
    pub effect: DeclaredDecisionEffect,
    pub on: Option<SymbolKey>,
    pub label: String,
    pub payload: Option<TypeExpression>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// The fixed feedback an engine review's `request_changes` carries.
    pub feedback: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeclaredDecisionEffect {
    Approve,
    RequestChanges,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeOperation {
    pub key: SymbolKey,
    pub input_schema: TypeExpression,
    pub output_schema: TypeExpression,
    #[serde(default)]
    pub error_codes: Vec<String>,
}
