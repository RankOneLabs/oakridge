//! Protocol numbers must survive JSON round trips through JavaScript without rounding.
use schemars::{Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub const MIN_SAFE_INTEGER: i64 = -MAX_SAFE_INTEGER;
const RANGE_ERROR: &str = "integer exceeds JavaScript-safe wire range";

macro_rules! bounded_integer {
    ($module:ident, $type:ty, $min:expr, $max:expr) => {
        pub mod $module {
            use super::*;
            fn valid(value: $type) -> bool {
                ($min as i128..=($max as i128)).contains(&(value as i128))
            }
            pub fn serialize<S: Serializer>(value: &$type, serializer: S) -> Result<S::Ok, S::Error> {
                if !valid(*value) {
                    return Err(serde::ser::Error::custom(RANGE_ERROR));
                }
                value.serialize(serializer)
            }
            pub fn deserialize<'de, D: Deserializer<'de>>(decoder: D) -> Result<$type, D::Error> {
                let value = <$type>::deserialize(decoder)?;
                if !valid(value) {
                    return Err(serde::de::Error::custom(RANGE_ERROR));
                }
                Ok(value)
            }
            pub fn schema(_: &mut SchemaGenerator) -> Schema {
                schemars::json_schema!({
                    "type": "integer", "minimum": $min, "maximum": $max
                })
            }
        }
    };
}
bounded_integer!(signed, i64, MIN_SAFE_INTEGER, MAX_SAFE_INTEGER);
bounded_integer!(unsigned, u64, 0, MAX_SAFE_INTEGER);
bounded_integer!(index, usize, 0, MAX_SAFE_INTEGER);
bounded_integer!(word, u32, 0, u32::MAX);

/// Source literals retain JSON syntax, but cannot smuggle wide numbers into compiled responses.
pub fn validate_json(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Number(number) => {
            let valid = if let Some(value) = number.as_i64() {
                (MIN_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)
            } else if let Some(value) = number.as_u64() {
                value <= MAX_SAFE_INTEGER as u64
            } else {
                number
                    .as_f64()
                    .is_some_and(|value| value.abs() <= MAX_SAFE_INTEGER as f64)
            };
            if valid {
                Ok(())
            } else {
                Err(RANGE_ERROR)
            }
        }
        Value::Array(values) => values.iter().try_for_each(validate_json),
        Value::Object(values) => values.values().try_for_each(validate_json),
        _ => Ok(()),
    }
}
pub mod json {
    use super::*;
    pub fn serialize<S: Serializer>(value: &Value, serializer: S) -> Result<S::Ok, S::Error> {
        validate_json(value).map_err(serde::ser::Error::custom)?;
        value.serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(decoder: D) -> Result<Value, D::Error> {
        let value = Value::deserialize(decoder)?;
        validate_json(&value).map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CheckedData, DefinitionBundle, ReadVersion};

    #[test]
    fn checked_integers_round_trip_only_at_safe_values() {
        for value in [MIN_SAFE_INTEGER, 0, MAX_SAFE_INTEGER] {
            let data = CheckedData::Integer { value };
            let bytes = serde_json::to_vec(&data).unwrap();
            assert_eq!(serde_json::from_slice::<CheckedData>(&bytes).unwrap(), data);
        }
        for value in [
            MIN_SAFE_INTEGER - 1,
            MAX_SAFE_INTEGER + 1,
            i64::MIN,
            i64::MAX,
        ] {
            assert!(serde_json::to_vec(&CheckedData::Integer { value }).is_err());
            assert!(serde_json::from_value::<CheckedData>(
                serde_json::json!({"kind":"integer","value":value})
            )
            .is_err());
        }
    }
    #[test]
    fn version_metadata_uses_the_same_unsigned_bound() {
        let version = ReadVersion {
            identity: "owner".into(),
            version: MAX_SAFE_INTEGER as u64,
        };
        assert_eq!(
            serde_json::from_slice::<ReadVersion>(&serde_json::to_vec(&version).unwrap()).unwrap(),
            version
        );
        assert!(serde_json::to_vec(&ReadVersion {
            version: u64::MAX,
            ..version
        })
        .is_err());
        assert!(serde_json::from_value::<ReadVersion>(
            serde_json::json!({"identity":"owner","version":u64::MAX})
        )
        .is_err());
    }
    #[test]
    fn bundle_limits_deadlines_and_unused_literals_cannot_smuggle_wide_numbers() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap();
        for path in [
            "/limits/evaluation_budget",
            "/scopes/0/workers/0/actions/0/deadline_ms",
            "/scopes/0/initial/value",
        ] {
            let mut source = fixture.clone();
            *source.pointer_mut(path).unwrap() = Value::from(MAX_SAFE_INTEGER + 1);
            assert!(
                serde_json::from_value::<DefinitionBundle>(source).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn every_generated_integer_schema_is_bounded_for_javascript() {
        fn check(value: &Value) {
            match value {
                Value::Object(object) => {
                    if object.get("type").and_then(Value::as_str) == Some("integer") {
                        assert!(object["minimum"].as_i64().unwrap() >= MIN_SAFE_INTEGER);
                        assert!(object["maximum"].as_u64().unwrap() <= MAX_SAFE_INTEGER as u64);
                    }
                    object.values().for_each(check);
                }
                Value::Array(values) => values.iter().for_each(check),
                _ => {}
            }
        }
        check(&serde_json::to_value(schemars::schema_for!(crate::protocol::Request)).unwrap());
        check(&serde_json::to_value(schemars::schema_for!(crate::protocol::Response)).unwrap());
    }
}
