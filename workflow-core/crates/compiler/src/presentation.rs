//! Presentation is checked against the same payload schemas used for command validation.
use crate::{error, schema, unique};
use workflow_model::*;

pub(crate) fn validate_presentation(value: &Presentation, entity: &str) -> CoreResult<()> {
    if value.label.trim().is_empty()
        || value
            .viewer
            .as_deref()
            .is_some_and(|viewer| viewer != "generic")
    {
        return Err(error(
            DomainErrorKind::UnsupportedPresentation,
            entity,
            "a nonblank label and only the generic typed viewer have defined semantics",
        ));
    }
    Ok(())
}

pub(crate) fn validate_command_fields(
    bundle: &DefinitionBundle,
    command: &CommandDefinition,
) -> CoreResult<()> {
    let payload = schema(bundle, &command.payload_schema)?;
    unique(
        command
            .field_presentation
            .iter()
            .map(|field| field.key.as_str()),
        &command.key.0,
    )?;
    for field in &command.field_presentation {
        let entity = format!("{}.{}", command.key, field.key);
        let SchemaShape::Record { fields, .. } = payload else {
            return Err(error(
                DomainErrorKind::UnsupportedPresentation,
                entity,
                "field presentation requires a record payload schema",
            ));
        };
        if !fields.iter().any(|declared| declared.key == field.key) {
            return Err(error(
                DomainErrorKind::MissingSymbol,
                entity,
                "presentation field is not declared in the command payload schema",
            ));
        }
        validate_presentation(&field.presentation, &entity)?;
    }
    Ok(())
}
