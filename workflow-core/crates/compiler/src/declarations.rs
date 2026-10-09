use crate::{error, schema, scope, unique, variants};
use std::collections::BTreeSet;
use workflow_model::*;
fn validate_lifecycle_payload(
    bundle: &DefinitionBundle,
    key: &SymbolKey,
    payload_schema: &SchemaId,
    projection: &LifecyclePayloadProjection,
) -> CoreResult<()> {
    let shape = schema(bundle, payload_schema)?;
    let compatible = match projection {
        LifecyclePayloadProjection::EmptyRecord => {
            matches!(shape, SchemaShape::Record { fields, dictionary: None } if fields.is_empty())
        }
        LifecyclePayloadProjection::Literal { value } => {
            crate::check_value(bundle, payload_schema, value).is_ok()
        }
        LifecyclePayloadProjection::Reason => {
            matches!(shape, SchemaShape::String { min_length: 0, .. })
        }
    };
    if compatible {
        Ok(())
    } else {
        Err(error(
            DomainErrorKind::IncompatiblePort,
            key.to_string(),
            "configured lifecycle projection cannot satisfy trigger payload schema",
        ))
    }
}
pub fn validate_bundle(
    bundle: &DefinitionBundle,
    available: &[OperationManifest],
) -> CoreResult<()> {
    for prompt in &bundle.prompts {
        let path = std::path::Path::new(&prompt.path);
        if prompt.content_digest.len() != 64
            || !prompt
                .content_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(error(
                DomainErrorKind::UnresolvedContent,
                prompt.key.to_string(),
                "prompt must have a SHA-256 content digest and a repository-contained path",
            ));
        }
        schema(bundle, &prompt.input_schema)?;
    }
    for requirement in &bundle.operations {
        schema(bundle, &requirement.input_schema)?;
        let actual = available
            .iter()
            .find(|m| m.key == requirement.key && m.version == requirement.version)
            .ok_or_else(|| {
                error(
                    DomainErrorKind::UnavailableOperation,
                    requirement.key.to_string(),
                    "pinned operation version unavailable",
                )
            })?;
        if actual.provider_kind != requirement.provider_kind
            || actual.input_contract != requirement.input_contract
            || requirement
                .settings
                .iter()
                .any(|v| !actual.settings.contains(v))
            || requirement.tools.iter().any(|v| !actual.tools.contains(v))
        {
            return Err(error(
                DomainErrorKind::UnavailableOperation,
                requirement.key.to_string(),
                "manifest does not honor the pinned contract",
            ));
        }
    }
    for owner in &bundle.scopes {
        schema(bundle, &owner.input_schema)?;
        schema(bundle, &owner.state_schema)?;
        schema(bundle, &owner.outcome_schema)?;
        variants(bundle, &owner.state_schema)?;
        variants(bundle, &owner.outcome_schema)?;
        unique(
            owner
                .commands
                .iter()
                .map(|x| x.key.0.as_str())
                .chain(owner.facts.iter().map(|x| x.key.0.as_str())),
            &owner.key.0,
        )?;
        unique(owner.workers.iter().map(|x| x.key.0.as_str()), &owner.key.0)?;
        unique(
            owner.children.iter().map(|x| x.key.0.as_str()),
            &owner.key.0,
        )?;
        unique(owner.outputs.iter().map(|x| x.key.0.as_str()), &owner.key.0)?;
        unique(owner.exports.iter().map(|x| x.key.0.as_str()), &owner.key.0)?;
        unique(
            owner.resources.iter().map(|x| x.key.0.as_str()),
            &owner.key.0,
        )?;
        unique(owner.pools.iter().map(|x| x.key.0.as_str()), &owner.key.0)?;
        let cancellation = owner
            .commands
            .iter()
            .map(|item| (&item.key, &item.payload_schema))
            .chain(
                owner
                    .facts
                    .iter()
                    .map(|item| (&item.key, &item.payload_schema)),
            )
            .find(|(key, _)| **key == owner.cancellation.trigger)
            .ok_or_else(|| {
                error(
                    DomainErrorKind::UndeclaredTrigger,
                    owner.key.to_string(),
                    "cancellation trigger is undeclared",
                )
            })?;
        validate_lifecycle_payload(
            bundle,
            cancellation.0,
            cancellation.1,
            &owner.cancellation.payload,
        )?;
        crate::presentation::validate_presentation(&owner.presentation, &owner.key.0)?;
        for pool in &owner.pools {
            if pool.limit == 0 {
                return Err(error(
                    DomainErrorKind::InvalidSchema,
                    pool.key.to_string(),
                    "capacity must be positive",
                ));
            }
        }
        if let Some(key) = &owner.entry_command {
            let command = owner
                .commands
                .iter()
                .find(|c| c.key == *key)
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::UndeclaredTrigger,
                        key.to_string(),
                        "entry command missing",
                    )
                })?;
            validate_lifecycle_payload(bundle, key, &command.payload_schema, &owner.entry_payload)?;
        }
        for command in &owner.commands {
            crate::presentation::validate_command_fields(bundle, command)?;
            unique(
                command.available_in.iter().map(String::as_str),
                &command.key.0,
            )?;
            if command.label.is_empty()
                || command.consequence.is_empty()
                || command.available_in.is_empty()
                || command.available_in.iter().any(|v| {
                    !variants(bundle, &owner.state_schema)
                        .unwrap_or_default()
                        .contains(v)
                })
            {
                return Err(error(
                    DomainErrorKind::UndeclaredTrigger,
                    command.key.to_string(),
                    "invalid command availability or presentation",
                ));
            }
        }
        unique(owner.errors.iter().map(|x| x.key.0.as_str()), &owner.key.0)?;
        for fact in owner.facts.iter().chain(&owner.errors) {
            schema(bundle, &fact.payload_schema)?;
        }
        for export in owner.exports.iter().chain(&owner.resources) {
            schema(bundle, &export.schema)?;
        }
        for output in &owner.outputs {
            let key = output.publication_trigger.as_ref().ok_or_else(|| {
                error(
                    DomainErrorKind::UnsupportedPublication,
                    output.key.to_string(),
                    "publishable output requires a publication_trigger",
                )
            })?;
            let fact = owner
                .facts
                .iter()
                .find(|fact| fact.key == *key)
                .ok_or_else(|| {
                    error(
                        DomainErrorKind::UndeclaredTrigger,
                        key.to_string(),
                        "publication fact missing",
                    )
                })?;
            if !matches!(schema(bundle, &fact.payload_schema)?, SchemaShape::Record { fields, dictionary: None } if fields.is_empty())
            {
                return Err(error(
                    DomainErrorKind::IncompatiblePort,
                    key.to_string(),
                    "publication fact requires an empty record payload",
                ));
            }
            if let Some(operator_trigger) = &output.operator_edit_trigger {
                if !owner
                    .commands
                    .iter()
                    .any(|command| command.key == *operator_trigger)
                {
                    return Err(error(
                        DomainErrorKind::UndeclaredTrigger,
                        operator_trigger.to_string(),
                        "operator edit trigger must name a declared command",
                    ));
                }
            }
            schema(bundle, &output.schema)?;
            unique(output.producers.iter().map(|w| w.0.as_str()), &output.key.0)?;
            if output.producers.is_empty()
                || output
                    .producers
                    .iter()
                    .any(|w| !owner.workers.iter().any(|x| x.key == *w))
                || output.collection_key.as_ref().is_some_and(|k| k.is_empty())
            {
                return Err(error(
                    DomainErrorKind::UnsupportedPublication,
                    output.key.to_string(),
                    "output requires declared authorized producers and legal cardinality",
                ));
            }
            if let Some(key) = &output.collection_key {
                let SchemaShape::Record { fields, .. } = schema(bundle, &output.schema)? else {
                    return Err(error(
                        DomainErrorKind::UnsupportedPublication,
                        output.key.to_string(),
                        "collection key requires a record schema",
                    ));
                };
                let field = fields
                    .iter()
                    .find(|f| f.key == *key && f.required)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::UnsupportedPublication,
                            output.key.to_string(),
                            "collection key must be a required field",
                        )
                    })?;
                if !matches!(schema(bundle, &field.schema)?, SchemaShape::String { .. }) {
                    return Err(error(
                        DomainErrorKind::UnsupportedPublication,
                        output.key.to_string(),
                        "collection key must be a string",
                    ));
                }
            }
        }
        for worker in &owner.workers {
            schema(bundle, &worker.result_schema)?;
            unique(
                worker.actions.iter().map(|x| x.key.0.as_str()),
                &worker.key.0,
            )?;
            for action in &worker.actions {
                schema(bundle, &action.input_schema)?;
                let manifest = bundle
                    .operations
                    .iter()
                    .find(|m| m.key == action.operation && m.version == action.contract_version)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::UnavailableOperation,
                            action.key.to_string(),
                            "operation pin is not declared",
                        )
                    })?;
                if action.input_schema != manifest.input_schema {
                    return Err(error(
                        DomainErrorKind::IncompatiblePort,
                        action.key.to_string(),
                        "action and operation input schemas differ",
                    ));
                }
                if action
                    .settings
                    .iter()
                    .any(|s| !manifest.settings.contains(&s.key))
                    || action.deadline_ms == 0
                    || action.max_attempts == 0
                {
                    return Err(error(
                        DomainErrorKind::UnsupportedProvider,
                        action.key.to_string(),
                        "provider settings/recovery bounds unsupported",
                    ));
                }
                unique(
                    action.settings.iter().map(|s| s.key.as_str()),
                    &action.key.0,
                )?;
                unique(action.tools.iter().map(String::as_str), &action.key.0)?;
                if action.tools.iter().any(|t| !manifest.tools.contains(t)) {
                    return Err(error(
                        DomainErrorKind::UnsupportedAuthorization,
                        action.key.to_string(),
                        "tool authorization cannot be honored",
                    ));
                }
                unique(action.outputs.iter().map(|s| s.0.as_str()), &action.key.0)?;
                for output in &action.outputs {
                    if !owner
                        .outputs
                        .iter()
                        .any(|o| o.key == *output && o.producers.contains(&worker.key))
                    {
                        return Err(error(
                            DomainErrorKind::UnsupportedPublication,
                            action.key.to_string(),
                            "action is not authorized for its output",
                        ));
                    }
                }
                if let Some(prompt) = &action.prompt {
                    let p = bundle
                        .prompts
                        .iter()
                        .find(|p| p.key == *prompt)
                        .ok_or_else(|| {
                            error(
                                DomainErrorKind::UnresolvedContent,
                                prompt.to_string(),
                                "prompt missing",
                            )
                        })?;
                    if p.input_schema != action.input_schema {
                        return Err(error(
                            DomainErrorKind::IncompatiblePort,
                            action.key.to_string(),
                            "prompt input schema differs",
                        ));
                    }
                }
            }
        }
        for child in &owner.children {
            let target = scope(bundle, &child.scope)?;
            if let Some(key) = &child.prerequisite_export {
                if child.collection.is_none() || !child.imports.contains(key) {
                    return Err(error(
                        DomainErrorKind::PrivateRead,
                        key.to_string(),
                        "prerequisite export requires a collection and declared import",
                    ));
                }
                let export = target
                    .exports
                    .iter()
                    .find(|export| export.key == *key)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::PrivateRead,
                            key.to_string(),
                            "prerequisite export missing",
                        )
                    })?;
                if !matches!(schema(bundle, &export.schema)?, SchemaShape::Boolean) {
                    return Err(error(
                        DomainErrorKind::IncompatiblePort,
                        key.to_string(),
                        "prerequisite export must be boolean",
                    ));
                }
            }
            if let Some(key) = &child.on_terminal {
                let fact = owner.facts.iter().find(|f| f.key == *key).ok_or_else(|| {
                    error(
                        DomainErrorKind::UndeclaredTrigger,
                        key.to_string(),
                        "child terminal fact missing",
                    )
                })?;
                validate_lifecycle_payload(
                    bundle,
                    key,
                    &fact.payload_schema,
                    &child.on_terminal_payload,
                )?;
            }
            unique(child.imports.iter().map(|x| x.0.as_str()), &child.key.0)?;
            if child
                .imports
                .iter()
                .any(|k| !target.exports.iter().any(|e| e.key == *k))
            {
                return Err(error(
                    DomainErrorKind::PrivateRead,
                    child.key.to_string(),
                    "import is not a declared child export",
                ));
            }
            unique(child.depends_on.iter().map(|x| x.0.as_str()), &child.key.0)?;
            if child
                .depends_on
                .iter()
                .any(|k| !owner.children.iter().any(|c| c.key == *k))
            {
                return Err(error(
                    DomainErrorKind::MissingSymbol,
                    child.key.to_string(),
                    "unknown child prerequisite",
                ));
            }
            if let Some(collection) = &child.collection {
                if collection.min_items == 0 {
                    return Err(error(
                        DomainErrorKind::InvalidTemplate,
                        child.key.to_string(),
                        "a collection must require at least one member",
                    ));
                }
                if collection.min_items > collection.max_items
                    || collection.max_items > bundle.limits.max_list_items
                {
                    return Err(error(
                        DomainErrorKind::InvalidTemplate,
                        child.key.to_string(),
                        "invalid collection cardinality",
                    ));
                }
            }
        }
        let mut completed = BTreeSet::new();
        while completed.len() < owner.children.len() {
            let ready: Vec<_> = owner
                .children
                .iter()
                .filter(|c| {
                    !completed.contains(&c.key)
                        && c.depends_on.iter().all(|d| completed.contains(d))
                })
                .collect();
            if ready.is_empty() {
                return Err(error(
                    DomainErrorKind::CyclicPrerequisite,
                    owner.key.to_string(),
                    "child prerequisite cycle",
                ));
            }
            for c in ready {
                completed.insert(c.key.clone());
            }
        }
    }
    // Recursive containment cannot be finitely materialized in language version 1.
    fn visit(
        bundle: &DefinitionBundle,
        key: &ScopeKey,
        active: &mut BTreeSet<ScopeKey>,
        done: &mut BTreeSet<ScopeKey>,
    ) -> CoreResult<()> {
        if done.contains(key) {
            return Ok(());
        }
        if !active.insert(key.clone()) {
            return Err(error(
                DomainErrorKind::CyclicPrerequisite,
                key.to_string(),
                "recursive child containment",
            ));
        }
        if active.len() > bundle.limits.max_depth {
            return Err(error(
                DomainErrorKind::ResourceLimit,
                key.to_string(),
                "scope containment exceeds nesting limit",
            ));
        }
        for child in &scope(bundle, key)?.children {
            visit(bundle, &child.scope, active, done)?;
        }
        active.remove(key);
        done.insert(key.clone());
        Ok(())
    }
    let mut done = BTreeSet::new();
    visit(bundle, &bundle.root, &mut BTreeSet::new(), &mut done)?;
    if done.len() != bundle.scopes.len() {
        return Err(error(
            DomainErrorKind::UnreachableDeclaration,
            bundle.key.to_string(),
            "scope is not reachable from root containment",
        ));
    }
    Ok(())
}
