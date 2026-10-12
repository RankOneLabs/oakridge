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
            let key_field = if c.key.is_some() {
                0
            } else {
                field(&c.key_field)?.0
            };
            let (input_field, input) = field(&c.input_field)?;
            let dependencies_field = if c.after.is_some() {
                0
            } else {
                field(&c.dependencies_field)?.0
            };
            if c.key.is_none()
                && !matches!(
                    schema(bundle, &field(&c.key_field)?.1.schema)?,
                    SchemaShape::String { .. }
                )
            {
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
            context.item = Some(item.clone());
            let key = c
                .key
                .as_ref()
                .map(|expr| compile_expression(bundle, owner, expr, &context, 0))
                .transpose()?;
            let after = c
                .after
                .as_ref()
                .map(|expr| compile_expression(bundle, owner, expr, &context, 0))
                .transpose()?;
            let key_schema = if let Some(value) = &key {
                &value.schema
            } else {
                &field(&c.key_field)?.1.schema
            };
            if !matches!(schema(bundle, key_schema)?, SchemaShape::String { .. }) {
                return Err(error(
                    DomainErrorKind::InvalidTemplate,
                    child.key.to_string(),
                    "member key must be a string",
                ));
            }
            let after_schema = if let Some(value) = &after {
                &value.schema
            } else {
                &field(&c.dependencies_field)?.1.schema
            };
            let SchemaShape::List {
                item: dependency, ..
            } = schema(bundle, after_schema)?
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
            Some(CheckedCollection {
                source,
                key,
                after,
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
        if command.targets.iter().any(|e| !reads_observation(e)) {
            return Err(error(
                DomainErrorKind::InvalidAssignment,
                command.key.to_string(),
                "targets must reference an observed root, not input, state or trigger",
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
            | Expression::Len { value }
            | Expression::Field { value, .. } => expression(value, roots),
            Expression::Optional { value, .. } => {
                if let Some(value) = value {
                    expression(value, roots);
                }
            }
            Expression::Equals { left, right }
            | Expression::GreaterThan { left, right }
            | Expression::GreaterOrEqual { left, right }
            | Expression::LessThan { left, right }
            | Expression::LessOrEqual { left, right } => {
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
/// Input, state and trigger travel beside the snapshot's observations, so a
/// projection cannot resolve a target revision from them.
fn reads_observation(expression: &Expression) -> bool {
    matches!(expression, Expression::Reference { root, .. }
        if !matches!(root, ReferenceRoot::Input | ReferenceRoot::State | ReferenceRoot::Trigger | ReferenceRoot::Item))
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

pub mod workflow_v2 {
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, BTreeSet};
    use workflow_model::*;

    fn reject(class: u8, detail: impl Into<String>) -> DomainError {
        DomainError::new(
            DomainErrorKind::InvalidAssignment,
            format!("check {class}"),
            detail.into(),
        )
    }
    fn parse_type(text: &str) -> TypeExpression {
        let text = text.trim();
        if let Some(inner) = text.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            let fields = split_top_level(inner)
                .filter_map(|field| {
                    let (key, value) = field.split_once(':')?;
                    Some((key.trim().to_owned(), parse_type(value)))
                })
                .collect();
            TypeExpression::Record(fields)
        } else {
            TypeExpression::Name(text.to_owned())
        }
    }
    fn split_top_level(text: &str) -> impl Iterator<Item = &str> {
        let mut depth = 0usize;
        let mut start = 0usize;
        let mut pieces = Vec::new();
        for (index, ch) in text.char_indices() {
            match ch {
                '{' | '(' => depth += 1,
                '}' | ')' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    pieces.push(text[start..index].trim());
                    start = index + 1;
                }
                _ => {}
            }
        }
        pieces.push(text[start..].trim());
        pieces.into_iter()
    }
    fn inner_type<'a>(name: &'a str, function: &str) -> Option<&'a str> {
        name.strip_prefix(function)?
            .strip_prefix('(')?
            .strip_suffix(')')
    }
    fn validate_type(
        ty: &TypeExpression,
        aliases: &BTreeMap<String, TypeExpression>,
        visiting: &mut BTreeSet<String>,
    ) -> Result<(), DomainError> {
        match ty {
            TypeExpression::Record(fields) => {
                for (key, field) in fields {
                    if key.is_empty() {
                        return Err(reject(11, "empty schema field key"));
                    }
                    validate_type(field, aliases, visiting)?;
                }
            }
            TypeExpression::Name(name)
                if ["text", "ident", "repo_path", "integer", "boolean"]
                    .contains(&name.as_str()) => {}
            TypeExpression::Name(name)
                if inner_type(name, "list").is_some() || inner_type(name, "optional").is_some() =>
            {
                let inner = inner_type(name, "list")
                    .or_else(|| inner_type(name, "optional"))
                    .unwrap();
                validate_type(&parse_type(inner), aliases, visiting)?;
            }
            TypeExpression::Name(name) if aliases.contains_key(name) => {
                if !visiting.insert(name.clone()) {
                    return Err(reject(1, format!("recursive schema {name}")));
                }
                validate_type(&aliases[name], aliases, visiting)?;
                visiting.remove(name);
            }
            TypeExpression::Name(name) => return Err(reject(1, format!("schema {name} absent"))),
        }
        Ok(())
    }
    fn resolve_type(
        ty: &TypeExpression,
        aliases: &BTreeMap<String, TypeExpression>,
    ) -> TypeExpression {
        match ty {
            TypeExpression::Name(name) if aliases.contains_key(name) => {
                resolve_type(&aliases[name], aliases)
            }
            TypeExpression::Record(fields) => TypeExpression::Record(
                fields
                    .iter()
                    .map(|(k, v)| (k.clone(), resolve_type(v, aliases)))
                    .collect(),
            ),
            _ => ty.clone(),
        }
    }
    fn item_type(ty: &TypeExpression) -> Option<TypeExpression> {
        let TypeExpression::Name(name) = ty else {
            return None;
        };
        Some(parse_type(inner_type(name, "list")?))
    }
    fn field_type(
        ty: &TypeExpression,
        path: &[&str],
        aliases: &BTreeMap<String, TypeExpression>,
    ) -> Option<TypeExpression> {
        let mut current = resolve_type(ty, aliases);
        for part in path {
            current = match current {
                TypeExpression::Record(fields) => fields.get(*part)?.clone(),
                TypeExpression::Name(name) => {
                    let parsed = parse_type(&name);
                    if parsed == TypeExpression::Name(name.clone()) {
                        return None;
                    }
                    let TypeExpression::Record(fields) = parsed else {
                        return None;
                    };
                    fields.get(*part)?.clone()
                }
            };
        }
        Some(current)
    }
    /// A stage expression parsed once, so type-checking reads a shape with a
    /// typed payload per variant rather than re-scanning the source text.
    #[derive(Clone, Copy, Debug)]
    enum Comparison {
        Greater,
        GreaterOrEqual,
        Less,
        LessOrEqual,
    }
    #[derive(Clone, Debug)]
    enum StageExpr {
        /// All four comparisons share one typing rule; the operator is carried
        /// so the resolved expression keeps it.
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
        Input(Vec<String>),
        Each(Vec<String>),
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
    /// The argument of `function(..)` and whatever trails its closing paren,
    /// matched at depth so a nested call does not end the argument early.
    fn split_call<'a>(text: &'a str, function: &str) -> Option<(&'a str, &'a str)> {
        let inner = text.strip_prefix(function)?.strip_prefix('(')?;
        let mut depth = 1usize;
        let mut quoted = false;
        for (index, ch) in inner.char_indices() {
            match ch {
                '"' => quoted = !quoted,
                '(' if !quoted => depth += 1,
                ')' if !quoted => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((inner[..index].trim(), inner[index + 1..].trim()));
                    }
                }
                _ => {}
            }
        }
        None
    }
    /// Operands and operator at the first comparison at paren depth zero and
    /// outside quotes.
    fn split_comparison(text: &str) -> Option<(&str, Comparison, &str)> {
        let bytes = text.as_bytes();
        let mut depth = 0usize;
        let mut quoted = false;
        for index in 0..bytes.len() {
            match bytes[index] {
                b'"' => quoted = !quoted,
                b'(' | b'{' if !quoted => depth += 1,
                b')' | b'}' if !quoted => depth = depth.saturating_sub(1),
                symbol @ (b'>' | b'<') if !quoted && depth == 0 => {
                    let padded = bytes.get(index + 1) == Some(&b'=');
                    let operator = match (symbol, padded) {
                        (b'>', true) => Comparison::GreaterOrEqual,
                        (b'>', false) => Comparison::Greater,
                        (_, true) => Comparison::LessOrEqual,
                        (_, false) => Comparison::Less,
                    };
                    let width = if padded { 2 } else { 1 };
                    return Some((text[..index].trim(), operator, text[index + width..].trim()));
                }
                _ => {}
            }
        }
        None
    }
    fn path_of(text: &str) -> Vec<String> {
        if text.is_empty() {
            Vec::new()
        } else {
            text.split('.').map(|part| part.trim().to_owned()).collect()
        }
    }
    fn parse_expression(text: &str) -> Result<StageExpr, DomainError> {
        let text = text.trim();
        if let Some((left, operator, right)) = split_comparison(text) {
            return Ok(StageExpr::Compare {
                operator,
                left: Box::new(parse_expression(left)?),
                right: Box::new(parse_expression(right)?),
            });
        }
        if let Some((argument, trailing)) = split_call(text, "len") {
            if !trailing.is_empty() {
                return Err(reject(1, format!("unexpected {trailing} after len")));
            }
            return Ok(StageExpr::Len(Box::new(parse_expression(argument)?)));
        }
        for function in ["published", "approved", "changes_requested"] {
            if let Some((artifact, trailing)) = split_call(text, function) {
                if !trailing.is_empty() {
                    return Err(reject(1, format!("unexpected {trailing} after {function}")));
                }
                let artifact = artifact.to_owned();
                return Ok(match function {
                    "published" => StageExpr::Published(artifact),
                    "approved" => StageExpr::Approved(artifact),
                    _ => StageExpr::ChangesRequested(artifact),
                });
            }
        }
        if let Some((artifact, trailing)) = split_call(text, "latest") {
            let path = match trailing.strip_prefix('.') {
                Some(path) if !path.is_empty() => path_of(path),
                None if trailing.is_empty() => Vec::new(),
                _ => return Err(reject(1, "latest path malformed")),
            };
            return Ok(StageExpr::Latest {
                artifact: artifact.to_owned(),
                path,
            });
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
        if text.contains('(') || text.contains(')') {
            return Err(reject(1, format!("unknown expression {text}")));
        }
        let (head, trailing) = text.split_once('.').unwrap_or((text, ""));
        let path = path_of(trailing);
        match head {
            "input" => Ok(StageExpr::Input(path)),
            "each" => Ok(StageExpr::Each(path)),
            _ if path.first().is_some_and(|segment| segment == "outcome") => {
                Ok(StageExpr::Outcome {
                    unit: head.to_owned(),
                    path: path[1..].to_vec(),
                })
            }
            _ => Ok(StageExpr::Name {
                head: head.to_owned(),
                path,
            }),
        }
    }
    /// Artifacts a done_when expression proves already have a revision. The
    /// language has no conjunction, so only a bare publication or approval
    /// guard qualifies; a comparison or a length proves nothing about one.
    fn guaranteed_artifacts(expression: &StageExpr) -> BTreeSet<String> {
        match expression {
            StageExpr::Published(artifact) | StageExpr::Approved(artifact) => {
                BTreeSet::from([artifact.clone()])
            }
            _ => BTreeSet::new(),
        }
    }
    /// Render a type back into the syntax `parse_type` accepts, so a nullable
    /// latest reads as `optional(text)` and not as an embedded JSON encoding.
    fn render_type(ty: &TypeExpression) -> String {
        match ty {
            TypeExpression::Name(name) => name.clone(),
            TypeExpression::Record(fields) => format!(
                "{{{}}}",
                fields
                    .iter()
                    .map(|(key, value)| format!("{key}: {}", render_type(value)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
    fn segments(path: &[String]) -> Vec<&str> {
        path.iter().map(String::as_str).collect()
    }
    #[derive(Clone)]
    struct Scope<'a> {
        input: &'a TypeExpression,
        artifacts: &'a BTreeMap<String, Artifact>,
        outcomes: &'a BTreeMap<String, TypeExpression>,
        each: Option<TypeExpression>,
        aliases: &'a BTreeMap<String, TypeExpression>,
        body: Option<(&'a str, &'a TypeExpression)>,
        guaranteed: BTreeSet<String>,
    }
    fn infer(expression: &StageExpr, scope: &Scope<'_>) -> Result<TypeExpression, DomainError> {
        let integer = || TypeExpression::Name("integer".into());
        let boolean = || TypeExpression::Name("boolean".into());
        match expression {
            StageExpr::Compare { left, right, .. } => {
                if infer(left, scope)? != integer() || infer(right, scope)? != integer() {
                    return Err(reject(9, "integer comparison requires integer operands"));
                }
                Ok(boolean())
            }
            StageExpr::Len(inner) => {
                let ty = infer(inner, scope)?;
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
                if path.is_empty() {
                    return Ok(schema.clone());
                }
                field_type(schema, &segments(path), scope.aliases)
                    .ok_or_else(|| reject(1, "artifact field absent"))
            }
            StageExpr::Input(path) => {
                if path.is_empty() {
                    return Ok(scope.input.clone());
                }
                field_type(scope.input, &segments(path), scope.aliases)
                    .ok_or_else(|| reject(1, format!("input field {} absent", path.join("."))))
            }
            StageExpr::Each(path) => {
                let each = scope
                    .each
                    .as_ref()
                    .ok_or_else(|| reject(3, "each outside collection"))?;
                if path.is_empty() {
                    return Ok(each.clone());
                }
                field_type(each, &segments(path), scope.aliases)
                    .ok_or_else(|| reject(1, "each field absent"))
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
                        if path.is_empty() {
                            return Ok(ty.clone());
                        }
                        return field_type(ty, &segments(path), scope.aliases)
                            .ok_or_else(|| reject(1, "validation body field absent"));
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
    fn resolve(expression: &StageExpr) -> Expression {
        fn reference(root: ReferenceRoot, path: &[String]) -> Expression {
            Expression::Reference {
                root,
                path: path.to_vec(),
            }
        }
        match expression {
            StageExpr::Compare {
                operator,
                left,
                right,
            } => {
                let left = Box::new(resolve(left));
                let right = Box::new(resolve(right));
                match operator {
                    Comparison::Greater => Expression::GreaterThan { left, right },
                    Comparison::GreaterOrEqual => Expression::GreaterOrEqual { left, right },
                    Comparison::Less => Expression::LessThan { left, right },
                    Comparison::LessOrEqual => Expression::LessOrEqual { left, right },
                }
            }
            StageExpr::Len(inner) => Expression::Len {
                value: Box::new(resolve(inner)),
            },
            StageExpr::Published(artifact) => reference(
                ReferenceRoot::Published {
                    artifact: SymbolKey::from(artifact.as_str()),
                },
                &[],
            ),
            StageExpr::Approved(artifact) => reference(
                ReferenceRoot::Approved {
                    artifact: SymbolKey::from(artifact.as_str()),
                },
                &[],
            ),
            StageExpr::ChangesRequested(artifact) => reference(
                ReferenceRoot::ChangesRequested {
                    artifact: SymbolKey::from(artifact.as_str()),
                },
                &[],
            ),
            StageExpr::Latest { artifact, path } => reference(
                ReferenceRoot::Latest {
                    artifact: SymbolKey::from(artifact.as_str()),
                },
                path,
            ),
            StageExpr::Input(path) => reference(ReferenceRoot::UnitInput, path),
            StageExpr::Each(path) => reference(ReferenceRoot::EachMember, path),
            StageExpr::Name { head, path } => reference(
                ReferenceRoot::ValidationBody {
                    artifact: SymbolKey::from(head.as_str()),
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
    fn checked(text: &str, scope: &Scope<'_>) -> Result<CheckedStageExpression, DomainError> {
        let parsed = parse_expression(text)?;
        Ok(CheckedStageExpression {
            source: text.into(),
            value_type: infer(&parsed, scope)?,
            expression: resolve(&parsed),
        })
    }
    fn fields(
        values: &BTreeMap<String, String>,
        scope: &Scope<'_>,
    ) -> Result<Vec<CheckedNamedExpression>, DomainError> {
        values
            .iter()
            .map(|(key, source)| {
                Ok(CheckedNamedExpression {
                    key: key.clone(),
                    value: checked(source, scope)?,
                })
            })
            .collect()
    }
    fn checked_record(fields: &[CheckedNamedExpression]) -> TypeExpression {
        TypeExpression::Record(
            fields
                .iter()
                .map(|field| (field.key.clone(), field.value.value_type.clone()))
                .collect(),
        )
    }
    fn prompt(
        path: &str,
        inputs: &BTreeMap<String, String>,
        prompts: &BTreeMap<String, String>,
    ) -> Result<(), DomainError> {
        if path.trim().is_empty() {
            return Err(reject(7, "review or agent prompt missing"));
        }
        let body = prompts
            .get(path)
            .ok_or_else(|| reject(10, format!("prompt file {path} missing")))?;
        for part in body.split("{{").skip(1) {
            let key = part.split("}}").next().unwrap_or("").trim();
            if !inputs.contains_key(key) && !["previous", "feedback", "subject"].contains(&key) {
                return Err(reject(
                    10,
                    format!("prompt {path} names undeclared input {key}"),
                ));
            }
        }
        Ok(())
    }
    fn compile_stage(
        key: &str,
        stage: &Stage,
        workflow: &Workflow,
        operations: &[CodeOperation],
        prompts: &BTreeMap<String, String>,
    ) -> Result<(CheckedStage, TypeExpression), DomainError> {
        let empty = BTreeMap::new();
        let base = Scope {
            input: &stage.input,
            artifacts: &stage.artifacts,
            outcomes: &empty,
            each: None,
            aliases: &workflow.schemas,
            body: None,
            guaranteed: BTreeSet::new(),
        };
        let mut owners = BTreeMap::<String, String>::new();
        let mut workers = Vec::new();
        for (worker_key, worker) in &stage.workers {
            let created = match worker {
                Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates,
            };
            if created.is_empty() {
                return Err(reject(7, format!("worker {worker_key} creates nothing")));
            }
            for artifact in created {
                if !stage.artifacts.contains_key(&artifact.0) {
                    return Err(reject(1, format!("artifact {artifact} absent")));
                }
                if owners
                    .insert(artifact.0.clone(), worker_key.clone())
                    .is_some()
                {
                    return Err(reject(
                        7,
                        format!("artifact {artifact} has multiple creators"),
                    ));
                }
            }
            let inputs = match worker {
                Worker::Agent {
                    prompts: modes,
                    inputs,
                    creates,
                    reviews,
                    ..
                } => {
                    let input_fields = fields(inputs, &base)?;
                    if reviews.is_some() && !modes.contains_key("review") {
                        return Err(reject(
                            7,
                            format!("reviewer {worker_key} lacks review prompt"),
                        ));
                    }
                    if reviews.is_none() && !modes.contains_key("initial") {
                        return Err(reject(
                            7,
                            format!("agent {worker_key} lacks initial prompt"),
                        ));
                    }
                    if let Some(of) = reviews {
                        if !stage.artifacts.contains_key(&of.0) {
                            return Err(reject(8, format!("reviewed artifact {of} absent")));
                        }
                    }
                    let needs_revise = creates.iter().any(|artifact| {
                        !stage.artifacts[&artifact.0].validate.is_empty()
                            || stage
                                .reviews
                                .values()
                                .flat_map(|review| {
                                    review
                                        .decisions
                                        .values()
                                        .map(move |decision| (&review.of, decision))
                                })
                                .any(|(of, decision)| {
                                    of == artifact
                                        && decision.effect == DecisionEffect::RequestChanges
                                })
                    });
                    if needs_revise && !modes.contains_key("revise") {
                        return Err(reject(7, format!("agent {worker_key} lacks revise prompt")));
                    }
                    for path in modes.values() {
                        prompt(path, inputs, prompts)?;
                    }
                    input_fields
                }
                Worker::Code {
                    operation,
                    inputs,
                    creates,
                    ..
                } => {
                    if creates.len() != 1 {
                        return Err(reject(
                            12,
                            format!("code worker {worker_key} must create one artifact"),
                        ));
                    }
                    let contract = operations
                        .iter()
                        .find(|o| o.key == *operation)
                        .ok_or_else(|| reject(12, format!("operation {operation} absent")))?;
                    let input_fields = fields(inputs, &base)?;
                    if resolve_type(&checked_record(&input_fields), &workflow.schemas)
                        != resolve_type(&contract.input_schema, &workflow.schemas)
                    {
                        return Err(reject(12, format!("operation {operation} input mismatch")));
                    }
                    if resolve_type(&stage.artifacts[&creates[0].0].schema, &workflow.schemas)
                        != resolve_type(&contract.output_schema, &workflow.schemas)
                    {
                        return Err(reject(12, format!("operation {operation} output mismatch")));
                    }
                    input_fields
                }
            };
            workers.push(CheckedWorker {
                key: WorkerKey::from(worker_key.as_str()),
                inputs,
            });
        }
        for artifact in stage.artifacts.keys() {
            if !owners.contains_key(artifact) {
                return Err(reject(7, format!("artifact {artifact} has no creator")));
            }
        }
        let mut validations = Vec::new();
        for (artifact_key, artifact) in &stage.artifacts {
            let own = Scope {
                body: Some((artifact_key, &artifact.schema)),
                ..base.clone()
            };
            let checks = artifact
                .validate
                .iter()
                .map(|rule| {
                    let expression = checked(&rule.check, &own)?;
                    if expression.value_type != TypeExpression::Name("boolean".into()) {
                        return Err(reject(8, "validation check must be boolean"));
                    }
                    Ok(expression)
                })
                .collect::<Result<Vec<_>, _>>()?;
            validations.push(CheckedArtifactValidation {
                artifact: SymbolKey::from(artifact_key.as_str()),
                checks,
            });
        }
        for (review_key, review) in &stage.reviews {
            if !stage.artifacts.contains_key(&review.of.0) {
                return Err(reject(8, format!("review {review_key} artifact absent")));
            }
            let _ = fields(&review.inputs, &base).map_err(|mut error| {
                error.entity_id = "check 8".into();
                error
            })?;
            let review_prompt = review
                .prompt
                .as_deref()
                .ok_or_else(|| reject(7, format!("review {review_key} lacks prompt")))?;
            if review_prompt.trim().is_empty() {
                return Err(reject(7, format!("review {review_key} lacks prompt")));
            }
            prompt(review_prompt, &review.inputs, prompts)?;
            for decision in review.decisions.values() {
                let target = decision.on.as_ref().unwrap_or(&review.of);
                let Some(owner) = owners.get(&target.0) else {
                    return Err(reject(8, format!("decision target {target} absent")));
                };
                if !matches!(stage.workers[owner], Worker::Agent { reviews: None, .. }) {
                    return Err(reject(
                        8,
                        format!("decision target {target} is not agent-created"),
                    ));
                }
            }
        }
        let done = stage
            .done_when
            .as_deref()
            .ok_or_else(|| reject(9, format!("stage {key} lacks done_when")))?;
        let done_expression = parse_expression(done)?;
        let done_when = CheckedStageExpression {
            source: done.into(),
            value_type: infer(&done_expression, &base)?,
            expression: resolve(&done_expression),
        };
        if done_when.value_type != TypeExpression::Name("boolean".into()) {
            return Err(reject(9, format!("stage {key} done_when is not boolean")));
        }
        let outcome_scope = Scope {
            guaranteed: guaranteed_artifacts(&done_expression),
            ..base
        };
        let outcome = fields(&stage.outcome, &outcome_scope)?;
        let outcome_type = checked_record(&outcome);
        Ok((
            CheckedStage {
                key: SymbolKey::from(key),
                workers,
                done_when,
                outcome,
                validations,
            },
            outcome_type,
        ))
    }
    fn compile_group(
        group: &Group,
        input: &TypeExpression,
        stage_outcomes: &BTreeMap<String, TypeExpression>,
        workflow: &Workflow,
    ) -> Result<(CheckedGroup, TypeExpression), DomainError> {
        for (key, unit) in &group.units {
            if unit.stage.is_some() == unit.group.is_some() {
                return Err(reject(
                    2,
                    format!("unit {key} needs exactly one stage or group"),
                ));
            }
            if unit.for_each.is_some() != unit.key.is_some() {
                return Err(reject(2, format!("collection {key} needs key")));
            }
            if let Some(pool) = &unit.pool {
                if group
                    .pools
                    .get(&pool.0)
                    .is_none_or(|capacity| *capacity == 0)
                {
                    return Err(reject(1, format!("pool {pool} absent or empty")));
                }
            }
            if let UnitDependencies::Fixed(after) = &unit.after {
                for dependency in after {
                    if !group.units.contains_key(&dependency.0) {
                        return Err(reject(1, format!("unit {dependency} absent")));
                    }
                }
            }
            let allowed: BTreeSet<_> = match &unit.after {
                UnitDependencies::Fixed(after) => after.iter().map(|key| key.0.as_str()).collect(),
                _ => BTreeSet::new(),
            };
            for expression in unit.input.values() {
                if let Some((other, _)) = expression.split_once(".outcome") {
                    if !allowed.contains(other) {
                        return Err(reject(3, format!("unit {key} reads {other} outside after")));
                    }
                }
            }
        }
        fn visit(
            key: &str,
            group: &Group,
            visiting: &mut BTreeSet<String>,
            done: &mut BTreeSet<String>,
            order: &mut Vec<String>,
        ) -> Result<(), DomainError> {
            if done.contains(key) {
                return Ok(());
            }
            if !visiting.insert(key.to_owned()) {
                return Err(reject(5, format!("dependency cycle through {key}")));
            }
            if let Some(UnitDependencies::Fixed(after)) = group.units.get(key).map(|u| &u.after) {
                for dependency in after {
                    visit(&dependency.0, group, visiting, done, order)?;
                }
            }
            visiting.remove(key);
            done.insert(key.to_owned());
            order.push(key.to_owned());
            Ok(())
        }
        let mut order = Vec::new();
        let mut visiting = BTreeSet::new();
        let mut done = BTreeSet::new();
        for key in group.units.keys() {
            visit(key, group, &mut visiting, &mut done, &mut order)?;
        }
        let empty = BTreeMap::new();
        let mut outcomes = BTreeMap::<String, TypeExpression>::new();
        let mut checked_units = Vec::new();
        for key in &order {
            let unit = &group.units[key];
            let after_keys: Vec<_> = if let UnitDependencies::Fixed(after) = &unit.after {
                after.clone()
            } else {
                vec![]
            };
            let allowed: BTreeMap<_, _> = after_keys
                .iter()
                .filter_map(|key| outcomes.get(&key.0).map(|ty| (key.0.clone(), ty.clone())))
                .collect();
            let mut scope = Scope {
                input,
                artifacts: &empty,
                outcomes: &allowed,
                each: None,
                aliases: &workflow.schemas,
                body: None,
                guaranteed: BTreeSet::new(),
            };
            let collection = if let Some(source) = &unit.for_each {
                let source = checked(source, &scope)?;
                let each = item_type(&source.value_type)
                    .ok_or_else(|| reject(2, format!("collection {key} source is not list")))?;
                scope.each = Some(each);
                let key_expr = checked(unit.key.as_ref().unwrap(), &scope)?;
                if key_expr.value_type != TypeExpression::Name("ident".into())
                    && key_expr.value_type != TypeExpression::Name("text".into())
                {
                    return Err(reject(2, "collection key is not text"));
                }
                let after = match &unit.after {
                    UnitDependencies::Each(text) => checked(text, &scope)?,
                    _ => CheckedStageExpression {
                        source: "[]".into(),
                        value_type: TypeExpression::Name("list(ident)".into()),
                        expression: Expression::List {
                            schema: SchemaId::from("list(ident)"),
                            items: vec![],
                        },
                    },
                };
                Some(CheckedUnitCollection {
                    source,
                    key: key_expr,
                    after,
                })
            } else {
                None
            };
            let checked_input = fields(&unit.input, &scope)?;
            let input_type = checked_record(&checked_input);
            let (nested, outcome_type) = if let Some(stage) = &unit.stage {
                let target = workflow
                    .stages
                    .get(&stage.0)
                    .ok_or_else(|| reject(1, format!("stage {stage} absent")))?;
                if resolve_type(&input_type, &workflow.schemas)
                    != resolve_type(&target.input, &workflow.schemas)
                {
                    return Err(reject(
                        6,
                        format!("unit {key} input does not match stage {stage}"),
                    ));
                }
                (
                    None,
                    stage_outcomes
                        .get(&stage.0)
                        .cloned()
                        .ok_or_else(|| reject(1, "stage outcome absent"))?,
                )
            } else {
                let (nested, outcome_type) = compile_group(
                    unit.group.as_ref().unwrap(),
                    &input_type,
                    stage_outcomes,
                    workflow,
                )?;
                (Some(Box::new(nested)), outcome_type)
            };
            outcomes.insert(key.clone(), outcome_type);
            checked_units.push(CheckedUnit {
                key: SymbolKey::from(key.as_str()),
                input: checked_input,
                after: after_keys,
                collection,
                group: nested,
            });
        }
        let scope = Scope {
            input,
            artifacts: &empty,
            outcomes: &outcomes,
            each: None,
            aliases: &workflow.schemas,
            body: None,
            guaranteed: BTreeSet::new(),
        };
        let mut checked_outcome = Vec::new();
        for (key, source) in &group.outcome {
            let value = if let Some(inner) = inner_type(source, "map") {
                let (collection, projection) = inner
                    .split_once(',')
                    .ok_or_else(|| reject(4, "map needs collection and projection"))?;
                let collection = collection.trim();
                let projection = projection.trim();
                let member = outcomes
                    .get(collection)
                    .ok_or_else(|| reject(4, "map collection absent"))?;
                let suffix = projection
                    .strip_prefix(collection)
                    .and_then(|v| v.strip_prefix(".outcome"))
                    .ok_or_else(|| reject(4, "map projection outside outcome"))?;
                let item = if suffix.is_empty() {
                    member.clone()
                } else {
                    field_type(
                        member,
                        &suffix
                            .strip_prefix('.')
                            .unwrap_or("")
                            .split('.')
                            .collect::<Vec<_>>(),
                        &workflow.schemas,
                    )
                    .ok_or_else(|| reject(4, "map field absent"))?
                };
                let item_type = TypeExpression::Name(format!(
                    "list({})",
                    serde_json::to_string(&item).unwrap_or_default()
                ));
                CheckedStageExpression {
                    source: source.clone(),
                    expression: Expression::Map {
                        source: Box::new(Expression::Reference {
                            root: ReferenceRoot::MemberOutcomes {
                                unit: SymbolKey::from(collection),
                            },
                            path: vec![],
                        }),
                        schema: SchemaId::from("map"),
                        value: Box::new(Expression::Reference {
                            root: ReferenceRoot::Item,
                            path: suffix
                                .strip_prefix('.')
                                .map(|rest| rest.split('.').map(str::to_owned).collect())
                                .unwrap_or_default(),
                        }),
                    },
                    value_type: item_type,
                }
            } else {
                checked(source, &scope)?
            };
            checked_outcome.push(CheckedNamedExpression {
                key: key.clone(),
                value,
            });
        }
        let outcome_type = checked_record(&checked_outcome);
        Ok((
            CheckedGroup {
                units: checked_units,
                outcome: checked_outcome,
            },
            outcome_type,
        ))
    }
    pub fn compile_workflow(
        source: &Workflow,
        operations: &[CodeOperation],
        prompts: &BTreeMap<String, String>,
    ) -> Result<CheckedWorkflow, DomainError> {
        validate_type(&source.input, &source.schemas, &mut BTreeSet::new())?;
        for ty in source.schemas.values() {
            validate_type(ty, &source.schemas, &mut BTreeSet::new())?;
        }
        for stage in source.stages.values() {
            validate_type(&stage.input, &source.schemas, &mut BTreeSet::new())?;
            for artifact in stage.artifacts.values() {
                validate_type(&artifact.schema, &source.schemas, &mut BTreeSet::new())?;
            }
            for review in stage.reviews.values() {
                for decision in review.decisions.values() {
                    if let Some(payload) = &decision.payload {
                        validate_type(payload, &source.schemas, &mut BTreeSet::new())?;
                    }
                }
            }
        }
        let mut stages = Vec::new();
        let mut stage_outcomes = BTreeMap::new();
        for (key, stage) in &source.stages {
            let (checked, outcome_type) = compile_stage(key, stage, source, operations, prompts)?;
            stages.push(checked);
            stage_outcomes.insert(key.clone(), outcome_type);
        }
        let (root, _) = compile_group(&source.run, &source.input, &stage_outcomes, source)?;
        let encoded = serde_json::to_vec(source).map_err(|error| reject(11, error.to_string()))?;
        let digest = BundleDigest(format!("{:x}", Sha256::digest(encoded)));
        Ok(CheckedWorkflow {
            source: source.clone(),
            digest,
            stages,
            root,
        })
    }
    pub fn decode_workflow(bytes: &[u8]) -> Result<Workflow, DomainError> {
        let value = crate::decode_unique_json(bytes)?;
        if let Some(stages) = value.get("stages").and_then(serde_json::Value::as_object) {
            for stage in stages.values() {
                if let Some(workers) = stage.get("workers").and_then(serde_json::Value::as_object) {
                    for (key, worker) in workers {
                        let kind = worker
                            .get("kind")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let forbidden: &[&str] = match kind {
                            "code" => &["prompts", "runtime", "workspace", "session", "reviews"],
                            "agent" => &["operation", "every"],
                            _ => &[],
                        };
                        if let Some(field) =
                            forbidden.iter().find(|field| worker.get(**field).is_some())
                        {
                            return Err(reject(12, format!("worker {key} cannot set {field}")));
                        }
                    }
                }
            }
        }
        serde_json::from_value(value).map_err(|error| reject(11, error.to_string()))
    }
}
