use super::*;

/// Preserve declared aliases for operator schema names while replacing the
/// outcome_of placeholders that the projection cannot render.
fn project_type(declared: &Type, resolved: &Type) -> Type {
    match (declared, resolved) {
        (Type::OutcomeOf { .. }, _) => resolved.clone(),
        (Type::List { item: declared }, Type::List { item: resolved }) => Type::List {
            item: Box::new(project_type(declared, resolved)),
        },
        (Type::Optional { value: declared }, Type::Optional { value: resolved }) => {
            Type::Optional {
                value: Box::new(project_type(declared, resolved)),
            }
        }
        (Type::Record { fields: declared }, Type::Record { fields: resolved }) => Type::Record {
            fields: declared
                .iter()
                .map(|(key, ty)| {
                    let resolved = resolved
                        .get(key)
                        .expect("resolved record retains its fields");
                    (key.clone(), project_type(ty, resolved))
                })
                .collect(),
        },
        _ => declared.clone(),
    }
}

pub(super) fn workflow(declared: &Workflow, resolved: &Workflow) -> Workflow {
    let mut projected = declared.clone();
    projected.input = project_type(&declared.input, &resolved.input);
    for (key, ty) in &mut projected.schemas {
        *ty = project_type(&declared.schemas[key], &resolved.schemas[key]);
    }
    for (key, stage) in &mut projected.stages {
        let original = &declared.stages[key];
        let checked = &resolved.stages[key];
        stage.input = project_type(&original.input, &checked.input);
        for (name, artifact) in &mut stage.artifacts {
            artifact.schema = project_type(
                &original.artifacts[name].schema,
                &checked.artifacts[name].schema,
            );
        }
        for (name, review) in &mut stage.reviews {
            for (decision, value) in &mut review.decisions {
                if let (Some(declared), Some(resolved)) = (
                    &original.reviews[name].decisions[decision].payload,
                    &checked.reviews[name].decisions[decision].payload,
                ) {
                    value.payload = Some(project_type(declared, resolved));
                }
            }
        }
    }
    projected
}
