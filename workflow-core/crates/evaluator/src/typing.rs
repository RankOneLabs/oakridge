use super::*;
pub fn check_type(ty: &CheckedType, value: &Value) -> bool {
    match ty {
        CheckedType::Record { fields } => value.as_object().is_some_and(|object| {
            fields
                .iter()
                .all(|(key, ty)| object.get(key).is_some_and(|v| check_type(ty, v)))
        }),
        CheckedType::Text | CheckedType::RepoPath => value.is_string(),
        CheckedType::Ident => value.as_str().is_some_and(is_ident),
        CheckedType::Enum { variants } => value
            .as_str()
            .is_some_and(|text| variants.iter().any(|variant| variant == text)),
        CheckedType::Boolean => value.is_boolean(),
        CheckedType::Integer => value.is_i64(),
        CheckedType::Optional { value: inner } => value.is_null() || check_type(inner, value),
        CheckedType::List { item } => value
            .as_array()
            .is_some_and(|items| items.iter().all(|value| check_type(item, value))),
        CheckedType::Named { .. } | CheckedType::OutcomeOf { .. } => false,
    }
}
