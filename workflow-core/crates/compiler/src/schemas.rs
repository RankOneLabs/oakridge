use crate::{error, schema, unique, SchemaLookup};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;
fn dependencies(shape: &SchemaShape) -> Vec<&SchemaId> {
    match shape {
        SchemaShape::Record { fields, dictionary } => fields
            .iter()
            .map(|f| &f.schema)
            .chain(dictionary.iter())
            .collect(),
        SchemaShape::List { item, .. } | SchemaShape::Optional { item } => vec![item],
        SchemaShape::Union { variants } => variants.iter().map(|v| &v.schema).collect(),
        _ => vec![],
    }
}
/// Validate every schema shape and bound nesting: no path through the schema
/// graph may pass through more than `max_depth` schemas.
///
/// `visit` returns a schema's height (schemas on its longest downward path,
/// itself included) and memoizes it, so a shared schema reached again at a
/// deeper point is still checked at that depth. The result does not depend on
/// declaration order.
pub fn validate_schemas(bundle: &DefinitionBundle) -> CoreResult<()> {
    fn visit(
        bundle: &DefinitionBundle,
        key: &SchemaId,
        active: &mut BTreeSet<SchemaId>,
        heights: &mut BTreeMap<SchemaId, usize>,
        depth: usize,
    ) -> CoreResult<usize> {
        let exceeds = || {
            error(
                DomainErrorKind::ResourceLimit,
                key.to_string(),
                "schema nesting exceeds limit",
            )
        };
        if let Some(height) = heights.get(key) {
            return if depth + height > bundle.limits.max_depth {
                Err(exceeds())
            } else {
                Ok(*height)
            };
        }
        if !active.insert(key.clone()) {
            return Err(error(
                DomainErrorKind::RecursiveSchema,
                key.to_string(),
                "recursive schemas are unsupported",
            ));
        }
        if depth + 1 > bundle.limits.max_depth {
            return Err(exceeds());
        }
        let shape = schema(bundle, key)?;
        match shape {
            SchemaShape::Integer { min, max }
                if min > max
                    || *min < wire_numbers::MIN_SAFE_INTEGER
                    || *max > wire_numbers::MAX_SAFE_INTEGER =>
            {
                return Err(error(
                    DomainErrorKind::InvalidSchema,
                    key.to_string(),
                    "integer bounds must be ordered within the JavaScript-safe wire range",
                ))
            }
            SchemaShape::String {
                min_length,
                max_length,
            } if min_length > max_length => {
                return Err(error(
                    DomainErrorKind::InvalidSchema,
                    key.to_string(),
                    "inverted string bounds",
                ))
            }
            SchemaShape::Enum { variants } => {
                unique(variants.iter().map(String::as_str), &key.0)?;
                if variants.is_empty() {
                    return Err(error(
                        DomainErrorKind::InvalidSchema,
                        key.to_string(),
                        "empty enum",
                    ));
                }
            }
            SchemaShape::Record { fields, .. } => {
                unique(fields.iter().map(|f| f.key.as_str()), &key.0)?;
                for field in fields.iter().filter(|f| !f.required) {
                    if let SchemaShape::Optional { .. } = schema(bundle, &field.schema)? {
                        return Err(error(
                            DomainErrorKind::InvalidSchema,
                            format!("{key}.{}", field.key),
                            "optional field cannot declare an already-optional schema: the compiler's synthesized field-presence wrapper would itself be Optional<Optional<T>>; null decodes to None at every level, so Some(None) is unrepresentable",
                        ));
                    }
                }
            }
            SchemaShape::Union { variants } => {
                unique(variants.iter().map(|v| v.key.as_str()), &key.0)?;
                if variants.is_empty() {
                    return Err(error(
                        DomainErrorKind::InvalidSchema,
                        key.to_string(),
                        "empty union",
                    ));
                }
            }
            SchemaShape::List { max_items, .. } if *max_items > bundle.limits.max_list_items => {
                return Err(error(
                    DomainErrorKind::ResourceLimit,
                    key.to_string(),
                    "list exceeds bundle resource limit",
                ))
            }
            _ => {}
        }
        let mut height = 1;
        for dep in dependencies(shape) {
            height = height.max(1 + visit(bundle, dep, active, heights, depth + 1)?);
        }
        if let SchemaShape::Optional { item } = shape {
            if let SchemaShape::Optional { .. } = schema(bundle, item)? {
                return Err(error(
                    DomainErrorKind::InvalidSchema,
                    key.to_string(),
                    "optional schema cannot wrap another optional: null decodes to None at every level, so Some(None) is unrepresentable",
                ));
            }
        }
        active.remove(key);
        heights.insert(key.clone(), height);
        Ok(height)
    }
    let mut heights = BTreeMap::new();
    for item in &bundle.schemas {
        visit(bundle, &item.key, &mut BTreeSet::new(), &mut heights, 0)?;
    }
    Ok(())
}
/// Decode one source/ingress value, resolving record fields to schema-owned numeric IDs.
pub fn check_value(
    bundle: &impl SchemaLookup,
    key: &SchemaId,
    value: &Value,
) -> CoreResult<CheckedValue> {
    fn decode(
        bundle: &impl SchemaLookup,
        key: &SchemaId,
        value: &Value,
        depth: usize,
    ) -> CoreResult<CheckedValue> {
        if depth > bundle.limits().max_depth {
            return Err(error(
                DomainErrorKind::ResourceLimit,
                key.to_string(),
                "value nesting exceeds limit",
            ));
        }
        let invalid = || {
            error(
                DomainErrorKind::InvalidPayload,
                key.to_string(),
                "value does not satisfy schema",
            )
            .contracts(key.to_string(), value.to_string())
        };
        let data = match schema(bundle, key)? {
            SchemaShape::Boolean => CheckedData::Boolean {
                value: value.as_bool().ok_or_else(invalid)?,
            },
            SchemaShape::Integer { min, max } => {
                let v = value.as_i64().ok_or_else(invalid)?;
                if v < *min
                    || v > *max
                    || !(wire_numbers::MIN_SAFE_INTEGER..=wire_numbers::MAX_SAFE_INTEGER)
                        .contains(&v)
                {
                    return Err(invalid());
                }
                CheckedData::Integer { value: v }
            }
            SchemaShape::String {
                min_length,
                max_length,
            } => {
                let v = value.as_str().ok_or_else(invalid)?;
                if v.chars().count() < *min_length || v.chars().count() > *max_length {
                    return Err(invalid());
                }
                CheckedData::String { value: v.into() }
            }
            SchemaShape::Enum { variants } => {
                let v = value.as_str().ok_or_else(invalid)?;
                if !variants.iter().any(|s| s == v) {
                    return Err(invalid());
                }
                CheckedData::Enum { variant: v.into() }
            }
            SchemaShape::Record { fields, dictionary } => {
                let values = value.as_object().ok_or_else(invalid)?;
                let mut checked = Vec::new();
                for (field_id, field) in fields.iter().enumerate() {
                    let v = match values.get(&field.key) {
                        Some(v) => Some(decode(bundle, &field.schema, v, depth + 1)?),
                        None if !field.required => None,
                        None => {
                            return Err(error(
                                DomainErrorKind::MissingBinding,
                                format!("{key}.{}", field.key),
                                "required field missing",
                            ))
                        }
                    };
                    checked.push(CheckedField { field_id, value: v });
                }
                let mut extra = Vec::new();
                for (name, v) in values {
                    if fields.iter().any(|f| f.key == *name) {
                        continue;
                    }
                    let Some(dict) = dictionary else {
                        return Err(invalid());
                    };
                    extra.push(DictionaryEntry {
                        key: name.clone(),
                        value: decode(bundle, dict, v, depth + 1)?,
                    });
                }
                CheckedData::Record {
                    fields: checked,
                    dictionary: extra,
                }
            }
            SchemaShape::List { item, max_items } => {
                let items = value.as_array().ok_or_else(invalid)?;
                if items.len() > *max_items {
                    return Err(error(
                        DomainErrorKind::ResourceLimit,
                        key.to_string(),
                        "list length exceeds schema limit",
                    ));
                }
                CheckedData::List {
                    items: items
                        .iter()
                        .map(|v| decode(bundle, item, v, depth + 1))
                        .collect::<CoreResult<_>>()?,
                }
            }
            SchemaShape::Optional { item } => CheckedData::Optional {
                value: if value.is_null() {
                    None
                } else {
                    Some(Box::new(decode(bundle, item, value, depth + 1)?))
                },
            },
            SchemaShape::Union { variants } => {
                let obj = value.as_object().ok_or_else(invalid)?;
                if obj.len() != 2 {
                    return Err(invalid());
                }
                let variant = obj
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                let def = variants
                    .iter()
                    .find(|v| v.key == variant)
                    .ok_or_else(invalid)?;
                CheckedData::Variant {
                    variant: variant.into(),
                    value: Box::new(decode(
                        bundle,
                        &def.schema,
                        obj.get("value").ok_or_else(invalid)?,
                        depth + 1,
                    )?),
                }
            }
            SchemaShape::Reference { brand } => {
                let obj = value.as_object().ok_or_else(invalid)?;
                if obj.len() != 2 {
                    return Err(invalid());
                }
                let id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(invalid)?;
                let actual: ReferenceBrand =
                    serde_json::from_value(obj.get("brand").cloned().ok_or_else(invalid)?)
                        .map_err(|_| invalid())?;
                if actual != *brand {
                    return Err(error(
                        DomainErrorKind::WrongBrand,
                        key.to_string(),
                        "reference brand differs",
                    ));
                }
                CheckedData::Reference {
                    brand: brand.clone(),
                    id: id.into(),
                }
            }
        };
        Ok(CheckedValue {
            schema: key.clone(),
            data,
        })
    }
    decode(bundle, key, value, 0)
}
/// Recheck generated wire values at the evaluator boundary, including closed fields and schema IDs.
pub fn validate_checked_value(
    bundle: &impl SchemaLookup,
    key: &SchemaId,
    value: &CheckedValue,
) -> CoreResult<()> {
    if &value.schema != key {
        return Err(error(
            DomainErrorKind::InvalidSnapshot,
            key.to_string(),
            "value has wrong schema ID",
        ));
    }
    let json = to_json(bundle, value)?;
    let canonical = check_value(bundle, key, &json).map_err(|mut e| {
        e.kind = DomainErrorKind::InvalidSnapshot;
        e.operation = "evaluate".into();
        e
    })?;
    if canonical != *value {
        return Err(error(
            DomainErrorKind::InvalidSnapshot,
            key.to_string(),
            "noncanonical or forged checked value",
        ));
    }
    Ok(())
}
fn to_json(bundle: &impl SchemaLookup, value: &CheckedValue) -> CoreResult<Value> {
    Ok(match &value.data {
        CheckedData::Boolean { value } => Value::Bool(*value),
        CheckedData::Integer { value } => Value::from(*value),
        CheckedData::String { value } => Value::from(value.clone()),
        CheckedData::Enum { variant } => Value::from(variant.clone()),
        CheckedData::List { items } => Value::Array(
            items
                .iter()
                .map(|v| to_json(bundle, v))
                .collect::<CoreResult<_>>()?,
        ),
        CheckedData::Optional { value } => match value {
            None => Value::Null,
            Some(v) => to_json(bundle, v)?,
        },
        CheckedData::Variant { variant, value } => {
            serde_json::json!({"kind":variant,"value":to_json(bundle,value)?})
        }
        CheckedData::Reference { brand, id } => serde_json::json!({"brand":brand,"id":id}),
        CheckedData::Record { fields, dictionary } => {
            let SchemaShape::Record { fields: defs, .. } = schema(bundle, &value.schema)? else {
                return Err(error(
                    DomainErrorKind::InvalidSnapshot,
                    value.schema.to_string(),
                    "record with nonrecord schema",
                ));
            };
            let mut map = serde_json::Map::new();
            for field in fields {
                let def = defs.get(field.field_id).ok_or_else(|| {
                    error(
                        DomainErrorKind::InvalidSnapshot,
                        value.schema.to_string(),
                        "invalid field ID",
                    )
                })?;
                if let Some(v) = &field.value {
                    if map.insert(def.key.clone(), to_json(bundle, v)?).is_some() {
                        return Err(error(
                            DomainErrorKind::InvalidSnapshot,
                            value.schema.to_string(),
                            "duplicate checked field",
                        ));
                    }
                }
            }
            for entry in dictionary {
                if map
                    .insert(entry.key.clone(), to_json(bundle, &entry.value)?)
                    .is_some()
                {
                    return Err(error(
                        DomainErrorKind::InvalidSnapshot,
                        value.schema.to_string(),
                        "duplicate dictionary field",
                    ));
                }
            }
            Value::Object(map)
        }
    })
}
