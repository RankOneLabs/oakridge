//! The workflow compiler: decode strict JSON, then type-check the section
//! 2.1-2.3 model into a CheckedWorkflow.
mod expressions;
mod scopes;
pub use scopes::{compile_workflow, compile_workflow_with_limits, decode_workflow};
use workflow_model::*;

pub(crate) fn error(
    kind: DomainErrorKind,
    entity: impl Into<String>,
    detail: impl Into<String>,
) -> DomainError {
    DomainError::new(kind, entity, detail)
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
