use super::*;
pub fn check_type(ty: &CheckedType, value: &Value) -> bool {
    match ty {
        CheckedType::Record { fields } => value.as_object().is_some_and(|object| {
            fields.iter().all(|(key, ty)| match object.get(key) {
                Some(value) => check_type(ty, value),
                None => matches!(ty, CheckedType::Optional { .. }),
            })
        }),
        CheckedType::Text | CheckedType::RepoPath => value.is_string(),
        CheckedType::Uuid { generated: true } => value.as_str().is_some_and(|text| {
            let bytes = text.as_bytes();
            bytes.len() == 36
                && bytes.iter().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        *byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        }),
        CheckedType::Uuid { generated: false } => false,
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
