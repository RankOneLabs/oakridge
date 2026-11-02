use super::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
fn decode_at<T: DeserializeOwned>(value: Value, path: &str) -> Result<T, CompileError> {
    serde_json::from_value(value).map_err(|error| {
        CompileError::new(
            CheckKind::Schema,
            path,
            SourceSpan::default(),
            error.to_string(),
        )
    })
}
fn merge_fields(base: &mut Value, overrides: Value) {
    if let (Some(base), Some(overrides)) = (base.as_object_mut(), overrides.as_object()) {
        for (key, value) in overrides {
            if value.is_null() {
                continue;
            }
            if let Some(existing) = base.get_mut(key) {
                if existing.is_object() && value.is_object() {
                    merge_fields(existing, value.clone());
                    continue;
                }
            }
            base.insert(key.clone(), value.clone());
        }
    }
}
pub fn expand_workflow_templates_value(value: &mut Value) -> Result<(), CompileError> {
    let root = value.as_object_mut().ok_or_else(|| {
        CompileError::new(
            CheckKind::Schema,
            "workflow",
            SourceSpan::default(),
            "workflow must be an object",
        )
    })?;
    let decisions: BTreeMap<String, BTreeMap<String, Value>> = decode_at(
        root.remove("decisions")
            .unwrap_or_else(|| Value::Object(Default::default())),
        "decisions",
    )?;
    for (set_key, set) in &decisions {
        for (key, decision) in set {
            let _: ReviewDecision =
                decode_at(decision.clone(), &format!("decisions.{set_key}.{key}"))?;
        }
    }
    let workers: BTreeMap<String, Value> = decode_at(
        root.remove("workers")
            .unwrap_or_else(|| Value::Object(Default::default())),
        "workers",
    )?;
    for (key, worker) in &workers {
        let _: Worker = decode_at(worker.clone(), &format!("workers.{key}"))?;
    }
    let review_templates: BTreeMap<String, Value> = decode_at(
        root.remove("reviews")
            .unwrap_or_else(|| Value::Object(Default::default())),
        "reviews",
    )?;
    for (key, review) in &review_templates {
        let _: Review = decode_at(review.clone(), &format!("reviews.{key}"))?;
    }
    let Some(stages) = root.get_mut("stages").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    for (stage_key, stage) in stages {
        let Some(stage) = stage.as_object_mut() else {
            continue;
        };
        if let Some(stage_workers) = stage.get_mut("workers").and_then(Value::as_object_mut) {
            for (key, worker) in stage_workers {
                if worker.get("template").is_none() {
                    continue;
                }
                let path = format!("stages.{stage_key}.workers.{key}");
                let binding: WorkerUse = decode_at(worker.clone(), &path)?;
                let template = workers.get(&binding.template).ok_or_else(|| {
                    CompileError::new(
                        CheckKind::Name,
                        &path,
                        SourceSpan::default(),
                        format!("worker template {} absent", binding.template),
                    )
                })?;
                let mut expanded = template.clone();
                if binding.overrides.is_some() {
                    let overrides = worker["overrides"].clone();
                    merge_fields(&mut expanded, overrides.clone());
                    // A tagged grant is one variant, not a bag of fields:
                    // replacing restricted with unscoped must discard role.
                    if let Some(grant) = overrides
                        .get("gated_review")
                        .filter(|grant| !grant.is_null())
                    {
                        expanded["gated_review"] = grant.clone();
                    }
                }
                let _: Worker = decode_at(expanded.clone(), &path)?;
                *worker = expanded;
            }
        }
        if let Some(reviews) = stage.get_mut("reviews").and_then(Value::as_object_mut) {
            for (review_key, review) in reviews {
                if review.get("template").is_some() {
                    let path = format!("stages.{stage_key}.reviews.{review_key}");
                    let binding: ReviewUse = decode_at(review.clone(), &path)?;
                    let template = review_templates.get(&binding.template).ok_or_else(|| {
                        CompileError::new(
                            CheckKind::Name,
                            &path,
                            SourceSpan::default(),
                            format!("review template {} absent", binding.template),
                        )
                    })?;
                    let mut expanded = template.clone();
                    if binding.overrides.is_some() {
                        merge_fields(&mut expanded, review["overrides"].clone());
                    }
                    let _: Review = decode_at(expanded.clone(), &path)?;
                    *review = expanded;
                }
                let Some(review) = review.as_object_mut() else {
                    continue;
                };
                let Some(value) = review.get_mut("decisions") else {
                    continue;
                };
                if value.get("set").is_none() {
                    continue;
                }
                let path = format!("stages.{stage_key}.reviews.{review_key}.decisions");
                let binding: DecisionSetUse = decode_at(value.clone(), &path)?;
                let set = decisions.get(&binding.set).ok_or_else(|| {
                    CompileError::new(
                        CheckKind::Name,
                        &path,
                        SourceSpan::default(),
                        format!("decision set {} absent", binding.set),
                    )
                })?;
                let mut expanded = serde_json::Map::new();
                for (key, decision) in set {
                    let destination = binding.rename.get(key).unwrap_or(key);
                    if expanded.contains_key(destination) {
                        return Err(CompileError::new(
                            CheckKind::Name,
                            &path,
                            SourceSpan::default(),
                            format!("duplicate decision {destination}"),
                        ));
                    }
                    let mut body = decision.clone();
                    if binding.overrides.contains_key(key) {
                        merge_fields(&mut body, value["overrides"][key].clone());
                    }
                    let _: ReviewDecision =
                        decode_at(body.clone(), &format!("{path}.{destination}"))?;
                    expanded.insert(destination.clone(), body);
                }
                for key in binding.rename.keys().chain(binding.overrides.keys()) {
                    if !set.contains_key(key) {
                        return Err(CompileError::new(
                            CheckKind::Name,
                            &path,
                            SourceSpan::default(),
                            format!("decision {key} absent from set {}", binding.set),
                        ));
                    }
                }
                *value = Value::Object(expanded);
            }
        }
    }
    Ok(())
}

pub fn decode_workflow_value_detailed(
    mut value: serde_json::Value,
) -> Result<Workflow, Vec<CompileError>> {
    expand_workflow_templates_value(&mut value).map_err(|error| vec![error])?;
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
