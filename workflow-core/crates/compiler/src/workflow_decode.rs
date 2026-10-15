use super::*;

pub fn decode_workflow_value_detailed(
    value: serde_json::Value,
) -> Result<Workflow, Vec<CompileError>> {
    let mut errors = Vec::new();
    if let Some(stages) = value.get("stages").and_then(serde_json::Value::as_object) {
        for (stage_key, stage) in stages {
            if let Some(workers) = stage.get("workers").and_then(serde_json::Value::as_object) {
                for (key, worker) in workers {
                    let kind = worker
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let forbidden: &[&str] = match kind {
                        "code" => &["prompts", "runtime", "workspace", "session", "reviews"],
                        "agent" => &["operation", "every"],
                        _ => &[],
                    };
                    for field in forbidden {
                        if let Some(found) = worker.get(*field) {
                            let path = format!("stages.{stage_key}.workers.{key}.{field}");
                            let span = match found {
                                serde_json::Value::String(text) => source_span(text),
                                other => source_span(&other.to_string()),
                            };
                            errors.push(CompileError::new(
                                CheckKind::Operation,
                                path,
                                span,
                                format!("worker {key} cannot set {field}"),
                            ));
                        }
                    }
                }
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    serde_path_to_error::deserialize(value.clone()).map_err(|error| {
        let path = error.path().to_string();
        vec![CompileError::new(
            CheckKind::Schema,
            &path,
            json_value_span(&value, &path),
            format!("{path}: {}", error.inner()),
        )]
    })
}

pub fn decode_workflow(bytes: &[u8]) -> Result<Workflow, DomainError> {
    let value = crate::decode_unique_json(bytes)?;
    decode_workflow_value_detailed(value).map_err(|errors| errors[0].as_domain_error())
}
