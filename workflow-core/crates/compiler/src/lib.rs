use serde_json::Value;
use std::collections::{HashMap, HashSet};
use workflow_model::{
    payload_matches, Binding, CoreResult, Decision, DefinitionBundle, DomainError, DomainErrorKind,
    Expression, PayloadType,
};

pub struct CompiledProgram<'a> {
    pub bundle: &'a DefinitionBundle,
    pub scope_order: Vec<String>,
}

fn reject(id: &str, kind: DomainErrorKind, detail: &str) -> DomainError {
    DomainError::new("compile", id, kind, detail)
}

pub fn compile(bundle: &DefinitionBundle) -> CoreResult<CompiledProgram<'_>> {
    if bundle.id.is_empty() || bundle.version == 0 || bundle.scopes.is_empty() {
        return Err(reject(
            &bundle.id,
            DomainErrorKind::InvalidShape,
            "id, positive version and scopes are required",
        ));
    }
    let mut facts = HashSet::new();
    for fact in &bundle.facts {
        if fact.is_empty() || !facts.insert(fact.as_str()) {
            return Err(reject(
                fact,
                DomainErrorKind::DuplicateFact,
                "fact id is empty or duplicate",
            ));
        }
    }
    let mut scopes = HashMap::new();
    for scope in &bundle.scopes {
        if scope.id.is_empty() || scopes.insert(scope.id.as_str(), scope).is_some() {
            return Err(reject(
                &scope.id,
                DomainErrorKind::DuplicateScope,
                "scope id is empty or duplicate",
            ));
        }
        if scope.states.is_empty() || scope.actions.is_empty() {
            return Err(reject(
                &scope.id,
                DomainErrorKind::InvalidShape,
                "scope requires states and actions",
            ));
        }
        let mut states = HashSet::new();
        for state in &scope.states {
            if state.is_empty() || !states.insert(state.as_str()) {
                return Err(reject(&scope.id, DomainErrorKind::DuplicateState, state));
            }
        }
        let mut actions = HashSet::new();
        for action in &scope.actions {
            if action.is_empty() || !actions.insert(action.as_str()) {
                return Err(reject(&scope.id, DomainErrorKind::DuplicateAction, action));
            }
        }
        let mut dependencies = HashSet::new();
        for dependency in &scope.depends_on {
            if !dependencies.insert(dependency.as_str()) {
                return Err(reject(
                    &scope.id,
                    DomainErrorKind::DuplicateDependency,
                    dependency,
                ));
            }
        }
    }
    let mut order = Vec::new();
    let mut pending: HashSet<&str> = scopes.keys().copied().collect();
    while !pending.is_empty() {
        let ready: Vec<&str> = bundle
            .scopes
            .iter()
            .map(|s| s.id.as_str())
            .filter(|id| {
                pending.contains(id)
                    && scopes[id]
                        .depends_on
                        .iter()
                        .all(|dep| !pending.contains(dep.as_str()))
            })
            .collect();
        if ready.is_empty() {
            return Err(reject(
                &bundle.id,
                DomainErrorKind::CyclicScope,
                "scope dependency cycle",
            ));
        }
        for id in ready {
            for dep in &scopes[id].depends_on {
                if !scopes.contains_key(dep.as_str()) {
                    return Err(reject(id, DomainErrorKind::UnknownScope, dep));
                }
            }
            pending.remove(id);
            order.push(id.to_owned());
        }
    }
    let mut collections = HashSet::new();
    for collection in &bundle.collections {
        if !collections.insert(collection.id.as_str()) {
            return Err(reject(
                &collection.id,
                DomainErrorKind::DuplicateCollection,
                "duplicate collection",
            ));
        }
        if !scopes.contains_key(collection.scope.as_str()) {
            return Err(reject(
                &collection.id,
                DomainErrorKind::UnknownScope,
                &collection.scope,
            ));
        }
    }
    let mut policies = HashSet::new();
    for policy in &bundle.policies {
        if !policies.insert(policy.id.as_str()) {
            return Err(reject(
                &policy.id,
                DomainErrorKind::DuplicatePolicy,
                "duplicate policy",
            ));
        }
        if !collections.contains(policy.collection.as_str()) {
            return Err(reject(
                &policy.id,
                DomainErrorKind::UnknownCollection,
                &policy.collection,
            ));
        }
    }
    let mut bindings = HashSet::new();
    for binding in &bundle.bindings {
        if !bindings.insert(binding.id.as_str()) {
            return Err(reject(
                &binding.id,
                DomainErrorKind::DuplicateBinding,
                "duplicate binding",
            ));
        }
        if binding.source.is_empty() || binding.target.is_empty() {
            return Err(reject(
                &binding.id,
                DomainErrorKind::InvalidShape,
                "binding source and target required",
            ));
        }
    }
    validate_decision(&bundle.decision, &scopes, &bindings, &facts, bundle, 0)?;
    Ok(CompiledProgram {
        bundle,
        scope_order: order,
    })
}

fn validate_decision(
    decision: &Decision,
    scopes: &HashMap<&str, &workflow_model::Scope>,
    bindings: &HashSet<&str>,
    facts: &HashSet<&str>,
    bundle: &DefinitionBundle,
    depth: usize,
) -> CoreResult<()> {
    if depth > 256 {
        return Err(reject(
            "decision",
            DomainErrorKind::CyclicDecision,
            "decision depth exceeded",
        ));
    }
    match decision {
        Decision::If {
            expression,
            then,
            otherwise,
        } => {
            validate_expression(expression, bindings, facts, bundle, depth + 1)?;
            validate_decision(then, scopes, bindings, facts, bundle, depth + 1)?;
            validate_decision(otherwise, scopes, bindings, facts, bundle, depth + 1)
        }
        Decision::Apply {
            scope,
            state,
            action,
        } => {
            let Some(def) = scopes.get(scope.as_str()) else {
                return Err(reject(
                    scope,
                    DomainErrorKind::UnknownScope,
                    "decision scope",
                ));
            };
            if !def.states.contains(state) {
                return Err(reject(scope, DomainErrorKind::UnknownState, state));
            }
            if !def.actions.contains(action) {
                return Err(reject(scope, DomainErrorKind::UnknownAction, action));
            }
            Ok(())
        }
        Decision::Wait { reason } | Decision::Reject { reason } => {
            if reason.is_empty() {
                Err(reject(
                    "decision",
                    DomainErrorKind::InvalidShape,
                    "reason required",
                ))
            } else {
                Ok(())
            }
        }
    }
}

fn validate_expression(
    expression: &Expression,
    bindings: &HashSet<&str>,
    facts: &HashSet<&str>,
    bundle: &DefinitionBundle,
    depth: usize,
) -> CoreResult<()> {
    if depth > 256 {
        return Err(reject(
            "expression",
            DomainErrorKind::InvalidExpression,
            "expression depth exceeded",
        ));
    }
    match expression {
        Expression::Fact { name } => {
            if !facts.contains(name.as_str()) {
                Err(reject("expression", DomainErrorKind::UnknownFact, name))
            } else {
                Ok(())
            }
        }
        Expression::Equals { binding, value } => {
            if !bindings.contains(binding.as_str()) {
                return Err(reject(
                    binding,
                    DomainErrorKind::UnknownBinding,
                    "expression binding",
                ));
            }
            let declaration = bundle.bindings.iter().find(|item| item.id == *binding);
            if let Some(declaration) = declaration {
                if !payload_matches(value, &declaration.value_type) {
                    return Err(reject(
                        binding,
                        DomainErrorKind::InvalidLiteral,
                        "literal does not match binding type",
                    ));
                }
            }
            Ok(())
        }
        Expression::All { items } | Expression::Any { items } => {
            if items.is_empty() {
                return Err(reject(
                    "expression",
                    DomainErrorKind::InvalidExpression,
                    "empty expression list",
                ));
            }
            for item in items {
                validate_expression(item, bindings, facts, bundle, depth + 1)?;
            }
            Ok(())
        }
        Expression::Not { item } => validate_expression(item, bindings, facts, bundle, depth + 1),
    }
}

pub fn validate_payload(
    bundle: &DefinitionBundle,
    collection_id: &str,
    payload: &Value,
) -> CoreResult<()> {
    let collection = bundle
        .collections
        .iter()
        .find(|c| c.id == collection_id)
        .ok_or_else(|| {
            reject(
                collection_id,
                DomainErrorKind::UnknownCollection,
                "payload collection",
            )
        })?;
    if payload_matches(payload, &collection.item_type) {
        Ok(())
    } else {
        Err(DomainError::new(
            "validate_payload",
            collection_id,
            DomainErrorKind::PayloadTypeMismatch,
            "payload does not match declared item_type",
        ))
    }
}

pub fn binding_value<'a>(values: &'a Value, binding: &Binding) -> CoreResult<&'a Value> {
    let pointer = format!("/{}", binding.source.replace('~', "~0").replace('/', "~1"));
    let value = values
        .get(&binding.source)
        .or_else(|| values.pointer(&pointer))
        .ok_or_else(|| {
            DomainError::new(
                "evaluate",
                &binding.id,
                DomainErrorKind::MissingPayloadField,
                &binding.source,
            )
        })?;
    if payload_matches(value, &binding.value_type) {
        Ok(value)
    } else {
        Err(DomainError::new(
            "evaluate",
            &binding.id,
            DomainErrorKind::PayloadTypeMismatch,
            &binding.source,
        ))
    }
}

pub fn payload_type_of(value: &Value) -> PayloadType {
    match value {
        Value::Null => PayloadType::Null,
        Value::Bool(_) => PayloadType::Boolean,
        Value::Number(_) => PayloadType::Number,
        Value::String(_) => PayloadType::String,
        Value::Array(_) => PayloadType::Array,
        Value::Object(_) => PayloadType::Object,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap()
    }

    fn error(mut change: impl FnMut(&mut Value)) -> DomainErrorKind {
        let mut value = fixture();
        change(&mut value);
        let bundle: DefinitionBundle = serde_json::from_value(value).unwrap();
        match compile(&bundle) {
            Ok(_) => panic!("expected compiler rejection"),
            Err(error) => error.kind,
        }
    }

    #[test]
    fn rejects_missing_identity() {
        assert_eq!(
            error(|v| v["id"] = json!("")),
            DomainErrorKind::InvalidShape
        );
    }
    #[test]
    fn rejects_duplicate_scope() {
        assert_eq!(
            error(|v| {
                let item = v["scopes"][0].clone();
                v["scopes"].as_array_mut().unwrap().push(item);
            }),
            DomainErrorKind::DuplicateScope
        );
    }
    #[test]
    fn rejects_unknown_scope_dependency() {
        assert_eq!(
            error(|v| v["scopes"][0]["depends_on"] = json!(["missing"])),
            DomainErrorKind::UnknownScope
        );
    }
    #[test]
    fn rejects_cyclic_scope_dependencies() {
        assert_eq!(
            error(|v| v["scopes"][0]["depends_on"] = json!(["review"])),
            DomainErrorKind::CyclicScope
        );
    }
    #[test]
    fn rejects_duplicate_fact() {
        assert_eq!(
            error(|v| v["facts"] = json!(["approved", "approved"])),
            DomainErrorKind::DuplicateFact
        );
    }
    #[test]
    fn rejects_duplicate_state() {
        assert_eq!(
            error(|v| v["scopes"][0]["states"] = json!(["ready", "ready"])),
            DomainErrorKind::DuplicateState
        );
    }
    #[test]
    fn rejects_duplicate_action() {
        assert_eq!(
            error(|v| v["scopes"][0]["actions"] = json!(["notify", "notify"])),
            DomainErrorKind::DuplicateAction
        );
    }
    #[test]
    fn rejects_duplicate_dependency() {
        assert_eq!(
            error(|v| v["scopes"][0]["depends_on"] = json!(["review", "review"])),
            DomainErrorKind::DuplicateDependency
        );
    }
    #[test]
    fn rejects_duplicate_collection() {
        assert_eq!(
            error(|v| {
                let item = v["collections"][0].clone();
                v["collections"].as_array_mut().unwrap().push(item);
            }),
            DomainErrorKind::DuplicateCollection
        );
    }
    #[test]
    fn rejects_unknown_collection_policy() {
        assert_eq!(
            error(|v| v["policies"][0]["collection"] = json!("missing")),
            DomainErrorKind::UnknownCollection
        );
    }
    #[test]
    fn rejects_duplicate_policy() {
        assert_eq!(
            error(|v| {
                let item = v["policies"][0].clone();
                v["policies"].as_array_mut().unwrap().push(item);
            }),
            DomainErrorKind::DuplicatePolicy
        );
    }
    #[test]
    fn rejects_duplicate_binding() {
        assert_eq!(
            error(|v| {
                let item = v["bindings"][0].clone();
                v["bindings"].as_array_mut().unwrap().push(item);
            }),
            DomainErrorKind::DuplicateBinding
        );
    }
    #[test]
    fn rejects_unknown_binding() {
        assert_eq!(
            error(|v| v["decision"]["expression"]["binding"] = json!("missing")),
            DomainErrorKind::UnknownBinding
        );
    }
    #[test]
    fn rejects_unknown_fact() {
        assert_eq!(
            error(|v| v["decision"]["expression"] = json!({"kind":"fact","name":"missing"})),
            DomainErrorKind::UnknownFact
        );
    }
    #[test]
    fn rejects_literal_type_mismatch() {
        assert_eq!(
            error(|v| v["decision"]["expression"]["value"] = json!("yes")),
            DomainErrorKind::InvalidLiteral
        );
    }
    #[test]
    fn rejects_unknown_state() {
        assert_eq!(
            error(|v| v["decision"]["then"]["state"] = json!("missing")),
            DomainErrorKind::UnknownState
        );
    }
    #[test]
    fn rejects_unknown_action() {
        assert_eq!(
            error(|v| v["decision"]["then"]["action"] = json!("missing")),
            DomainErrorKind::UnknownAction
        );
    }
    #[test]
    fn rejects_empty_expression_list() {
        assert_eq!(
            error(|v| v["decision"]["expression"] = json!({"kind":"all","items":[]})),
            DomainErrorKind::InvalidExpression
        );
    }
}
