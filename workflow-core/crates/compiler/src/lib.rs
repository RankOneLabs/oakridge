//! Typed transforms: source validation → schema resolution → checked scopes → finite analysis.
mod analysis;
mod declarations;
mod expressions;
mod presentation;
mod references;
mod schemas;
mod scopes;
mod trees;
pub use schemas::{check_value, validate_checked_value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use workflow_model::*;

pub trait SchemaLookup {
    fn schemas(&self) -> &[Schema];
    fn limits(&self) -> &ResourceLimits;
}
pub trait DefinitionView: SchemaLookup {
    fn scopes(&self) -> &[ScopeDefinition];
}
impl SchemaLookup for DefinitionBundle {
    fn schemas(&self) -> &[Schema] {
        &self.schemas
    }
    fn limits(&self) -> &ResourceLimits {
        &self.limits
    }
}
impl DefinitionView for DefinitionBundle {
    fn scopes(&self) -> &[ScopeDefinition] {
        &self.scopes
    }
}
impl SchemaLookup for CheckedDefinition {
    fn schemas(&self) -> &[Schema] {
        &self.schemas
    }
    fn limits(&self) -> &ResourceLimits {
        &self.limits
    }
}
impl DefinitionView for CheckedDefinition {
    fn scopes(&self) -> &[ScopeDefinition] {
        &self.scopes
    }
}

pub(crate) fn error(
    kind: DomainErrorKind,
    entity: impl Into<String>,
    detail: impl Into<String>,
) -> DomainError {
    DomainError::new(kind, entity, detail)
}
pub(crate) fn unique<'a>(names: impl IntoIterator<Item = &'a str>, entity: &str) -> CoreResult<()> {
    let mut seen = BTreeSet::new();
    for name in names {
        if name.is_empty() {
            return Err(error(
                DomainErrorKind::MissingSymbol,
                entity,
                "empty symbol",
            ));
        }
        if !seen.insert(name) {
            return Err(error(DomainErrorKind::DuplicateSymbol, entity, name));
        }
    }
    Ok(())
}
pub(crate) fn schema<'a>(
    bundle: &'a impl SchemaLookup,
    key: &SchemaId,
) -> CoreResult<&'a SchemaShape> {
    bundle
        .schemas()
        .iter()
        .find(|s| s.key == *key)
        .map(|s| &s.shape)
        .ok_or_else(|| {
            error(
                DomainErrorKind::MissingSymbol,
                key.to_string(),
                "schema is not declared",
            )
        })
}
pub(crate) fn scope<'a>(
    bundle: &'a impl DefinitionView,
    key: &ScopeKey,
) -> CoreResult<&'a ScopeDefinition> {
    bundle
        .scopes()
        .iter()
        .find(|s| s.key == *key)
        .ok_or_else(|| {
            error(
                DomainErrorKind::MissingSymbol,
                key.to_string(),
                "scope is not declared",
            )
        })
}
pub(crate) fn variants(bundle: &DefinitionBundle, key: &SchemaId) -> CoreResult<Vec<String>> {
    match schema(bundle, key)? {
        SchemaShape::Union { variants } => Ok(variants.iter().map(|v| v.key.clone()).collect()),
        SchemaShape::Enum { variants } => Ok(variants.clone()),
        SchemaShape::Optional { .. } => Ok(vec!["some".into(), "none".into()]),
        SchemaShape::Boolean => Ok(vec!["true".into(), "false".into()]),
        _ => Err(error(
            DomainErrorKind::InvalidSchema,
            key.to_string(),
            "a finite variant schema is required",
        )),
    }
}
/// Canonical JSON uses sorted object keys (serde_json's default map), declaration order is semantic.
pub fn canonical_digest(bundle: &DefinitionBundle) -> CoreResult<BundleDigest> {
    let bytes = serde_json::to_vec(bundle).map_err(|e| {
        error(
            DomainErrorKind::InvalidSchema,
            bundle.key.to_string(),
            e.to_string(),
        )
    })?;
    Ok(BundleDigest(format!("{:x}", Sha256::digest(bytes))))
}
pub fn compile(
    source: &DefinitionBundle,
    available: &[OperationManifest],
) -> CoreResult<CheckedProgram> {
    if source.language_version != 1 || source.version == 0 {
        return Err(error(
            DomainErrorKind::UnsupportedVersion,
            source.key.to_string(),
            "language version 1 and positive bundle version required",
        ));
    }
    if source.limits.max_depth > workflow_model::protocol::MAX_DEPTH_CEILING {
        return Err(error(
            DomainErrorKind::ResourceLimit,
            source.key.to_string(),
            format!(
                "max_depth {} exceeds the ceiling {}: a bundle or value nested that deep may not fit the {}-level wire",
                source.limits.max_depth,
                workflow_model::protocol::MAX_DEPTH_CEILING,
                workflow_model::protocol::WIRE_MAX_JSON_DEPTH,
            ),
        ));
    }
    if source.limits.max_depth == 0
        || source.limits.max_list_items == 0
        || source.limits.evaluation_budget == 0
    {
        return Err(error(
            DomainErrorKind::ResourceLimit,
            source.key.to_string(),
            "invalid finite resource limits",
        ));
    }
    unique([source.key.0.as_str()], "bundle")?;
    unique(source.scopes.iter().map(|s| s.key.0.as_str()), "scopes")?;
    unique(source.schemas.iter().map(|s| s.key.0.as_str()), "schemas")?;
    unique(source.prompts.iter().map(|s| s.key.0.as_str()), "prompts")?;
    unique(
        source.operations.iter().map(|s| s.key.0.as_str()),
        "operations",
    )?;
    scope(source, &source.root)?;
    schemas::validate_schemas(source)?;
    declarations::validate_bundle(source, available)?;
    let digest = canonical_digest(source)?;
    let mut bundle = source.clone();
    for definition in &source.schemas {
        if let SchemaShape::Record { fields, .. } = &definition.shape {
            for (index, field) in fields
                .iter()
                .enumerate()
                .filter(|(_, field)| !field.required)
            {
                let key = references::optional_field_schema(&definition.key, index);
                if bundle.schemas.iter().any(|schema| schema.key == key) {
                    return Err(error(
                        DomainErrorKind::DuplicateSymbol,
                        key.to_string(),
                        "reserved optional field schema key",
                    ));
                }
                bundle.schemas.push(Schema {
                    key,
                    shape: SchemaShape::Optional {
                        item: field.schema.clone(),
                    },
                });
            }
        }
    }
    // A scope's trigger type is compiler-owned, derived solely from that scope's declared events.
    for owner in &source.scopes {
        let key = expressions::trigger_schema(owner);
        if source.schemas.iter().any(|s| s.key == key) {
            return Err(error(
                DomainErrorKind::DuplicateSymbol,
                key.to_string(),
                "reserved compiler schema key",
            ));
        }
        bundle.schemas.push(Schema {
            key,
            shape: SchemaShape::Union {
                variants: owner
                    .commands
                    .iter()
                    .map(|c| SchemaVariant {
                        key: c.key.0.clone(),
                        schema: c.payload_schema.clone(),
                    })
                    .chain(owner.facts.iter().map(|f| SchemaVariant {
                        key: f.key.0.clone(),
                        schema: f.payload_schema.clone(),
                    }))
                    .collect(),
            },
        });
    }
    let mut scopes = Vec::new();
    let mut analyses = Vec::new();
    for owner in &bundle.scopes {
        let checked = scopes::compile_scope(&bundle, owner)?;
        analyses.push(analysis::analyze(&bundle, owner, &checked.tree)?);
        scopes.push(checked);
    }
    Ok(CheckedProgram {
        language_version: 1,
        evaluator_version: 1,
        digest,
        derived: CheckedDefinition {
            schemas: bundle.schemas,
            scopes: bundle.scopes,
            limits: bundle.limits,
        },
        scopes,
        analysis: analyses,
    })
}

/** Validate against host-owned declarations before checking source contracts. */
pub fn compile_with_catalog(
    source: &DefinitionBundle,
    catalog: &ProviderCatalog,
) -> CoreResult<CheckedProgram> {
    for requested in &source.operations {
        let route = catalog
            .providers
            .iter()
            .find(|route| route.kind == requested.provider_kind)
            .ok_or_else(|| {
                error(
                    DomainErrorKind::UnsupportedProvider,
                    requested.key.to_string(),
                    "provider kind is absent from the catalog",
                )
            })?;
        if route.input_contract != requested.input_contract {
            return Err(error(
                DomainErrorKind::IncompatiblePort,
                requested.key.to_string(),
                "provider input contract differs from the catalog",
            ));
        }
        let available = catalog
            .operations
            .iter()
            .find(|operation| operation.key == requested.key)
            .ok_or_else(|| {
                error(
                    DomainErrorKind::UnavailableOperation,
                    requested.key.to_string(),
                    "operation is absent from the catalog",
                )
            })?;
        if !requested.emitted_codes.is_empty() || !requested.required_recovery_codes.is_empty() {
            return Err(error(
                DomainErrorKind::UnsupportedProvider,
                requested.key.to_string(),
                "bundle cannot declare provider-owned recovery requirements",
            ));
        }
        unique(
            requested
                .recovery
                .iter()
                .map(|mapping| mapping.code.as_str()),
            &requested.key.0,
        )?;
        for code in &available.required_recovery_codes {
            if !requested
                .recovery
                .iter()
                .any(|mapping| &mapping.code == code)
            {
                return Err(error(
                    DomainErrorKind::UndeclaredTrigger,
                    requested.key.to_string(),
                    format!("required provider recovery code {code} has no trigger mapping"),
                ));
            }
        }
        for mapping in &requested.recovery {
            if !available.emitted_codes.contains(&mapping.code) {
                return Err(error(
                    DomainErrorKind::UnsupportedProvider,
                    requested.key.to_string(),
                    format!("provider cannot emit recovery code {}", mapping.code),
                ));
            }
            for owner in &source.scopes {
                if !owner
                    .workers
                    .iter()
                    .flat_map(|worker| &worker.actions)
                    .any(|action| {
                        action.operation == requested.key
                            && action.contract_version == requested.version
                    })
                {
                    continue;
                }
                let fact = owner
                    .facts
                    .iter()
                    .find(|fact| fact.key == mapping.fact)
                    .ok_or_else(|| {
                        error(
                            DomainErrorKind::UndeclaredTrigger,
                            owner.key.to_string(),
                            format!("recovery fact {} is absent", mapping.fact),
                        )
                    })?;
                if !matches!(
                    schema(source, &fact.payload_schema)?,
                    SchemaShape::String { min_length: 0, .. }
                ) {
                    return Err(error(
                        DomainErrorKind::IncompatiblePort,
                        mapping.fact.to_string(),
                        "recovery detail requires a string payload accepting empty detail",
                    ));
                }
            }
        }
        if available.version != requested.version {
            return Err(error(
                DomainErrorKind::UnsupportedVersion,
                requested.key.to_string(),
                "operation version differs from the catalog",
            ));
        }
        if requested
            .settings
            .iter()
            .any(|setting| !available.settings.contains(setting))
            || requested
                .tools
                .iter()
                .any(|tool| !available.tools.contains(tool))
        {
            return Err(error(
                DomainErrorKind::UnsupportedAuthorization,
                requested.key.to_string(),
                "provider capability differs from the catalog",
            ));
        }
    }
    compile(source, &catalog.operations)
}
pub fn compile_with_host(
    source: &DefinitionBundle,
    host: &ResourceLimits,
    catalog: &ProviderCatalog,
) -> CoreResult<CheckedProgram> {
    for (name, requested, allowed) in [
        (
            "max_list_items",
            source.limits.max_list_items,
            host.max_list_items,
        ),
        ("max_depth", source.limits.max_depth, host.max_depth),
        (
            "evaluation_budget",
            source.limits.evaluation_budget,
            host.evaluation_budget,
        ),
    ] {
        if requested > allowed {
            return Err(error(
                DomainErrorKind::LimitExceedsHost,
                source.key.to_string(),
                format!("{name}: requested {requested}, allowed {allowed}"),
            ));
        }
    }
    compile_with_catalog(source, catalog)
}

/// Domain JSON decoding detects duplicate keys before serde can discard them.
pub fn decode_bundle(bytes: &[u8]) -> CoreResult<DefinitionBundle> {
    let value = decode_unique_json(bytes)?;
    let encoded = serde_json::to_vec(&value)
        .map_err(|e| error(DomainErrorKind::MalformedBundle, "bundle", e.to_string()))?;
    let mut deserializer = serde_json::Deserializer::from_slice(&encoded);
    serde_path_to_error::deserialize(&mut deserializer).map_err(|e| {
        let mut error = error(DomainErrorKind::MalformedBundle, "bundle", e.to_string());
        error.path = e.path().to_string().into_boxed_str();
        error
    })
}
pub fn decode_unique_json(bytes: &[u8]) -> CoreResult<serde_json::Value> {
    use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    struct Unique(serde_json::Value);
    struct UniqueVisitor;
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            d.deserialize_any(UniqueVisitor)
        }
    }
    impl<'de> Visitor<'de> for UniqueVisitor {
        type Value = Unique;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("strict JSON without duplicate keys")
        }
        fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Unique, E> {
            Ok(Unique(v.into()))
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Unique, E> {
            Ok(Unique(v.into()))
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Unique, E> {
            Ok(Unique(v.into()))
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Unique, E> {
            serde_json::Number::from_f64(v)
                .map(|n| Unique(n.into()))
                .ok_or_else(|| E::custom("nonfinite number"))
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Unique, E> {
            Ok(Unique(v.into()))
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Unique, E> {
            Ok(Unique(serde_json::Value::Null))
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Unique, E> {
            self.visit_none()
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
            let mut values = Vec::new();
            while let Some(v) = a.next_element::<Unique>()? {
                values.push(v.0);
            }
            Ok(Unique(values.into()))
        }
        fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
            let mut map = serde_json::Map::new();
            while let Some(key) = a.next_key::<String>()? {
                if map.contains_key(&key) {
                    return Err(serde::de::Error::custom(format!("duplicate key: {key}")));
                }
                map.insert(key, a.next_value::<Unique>()?.0);
            }
            Ok(Unique(map.into()))
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let result = Unique::deserialize(&mut decoder).map_err(|e| {
        error(
            if e.to_string().contains("duplicate key:") {
                DomainErrorKind::DuplicateSymbol
            } else {
                DomainErrorKind::UnknownConstruct
            },
            "json",
            e.to_string(),
        )
    })?;
    decoder
        .end()
        .map_err(|e| error(DomainErrorKind::UnknownConstruct, "json", e.to_string()))?;
    Ok(result.0)
}

/// Validate aggregate and revision roots against the owner's declared ports.
pub fn validate_observation_root(
    bundle: &impl DefinitionView,
    owner: &ScopeDefinition,
    root: &ReferenceRoot,
) -> CoreResult<()> {
    references::compile_reference(bundle, owner, root, &[], &expressions::Context::default())
        .map(|_| ())
}
