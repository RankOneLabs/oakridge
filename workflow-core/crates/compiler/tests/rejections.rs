use serde_json::Value;
use std::collections::BTreeMap;
use workflow_model::*;

#[test]
fn malformed_type_reports_its_config_path() {
    let mut workflow: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
    workflow["schemas"]["pr_status"]["number"] = Value::String("list(integer".into());
    let error =
        workflow_compiler::decode_workflow(&serde_json::to_vec(&workflow).unwrap()).unwrap_err();
    assert!(
        error.detail.contains("schemas.pr_status.number"),
        "{error:?}"
    );
    assert_eq!(&*error.path, "schemas.pr_status.number");
}

/// `repository.prepare` as the samples' registry declares it.
fn prepare_operation() -> Vec<CodeOperation> {
    vec![CodeOperation {
        key: SymbolKey::from("repository.prepare"),
        input_schema: TypeExpression::Record(
            [
                (
                    "repository_path".into(),
                    TypeExpression::Name("repo_path".into()),
                ),
                (
                    "expected_head".into(),
                    TypeExpression::Name("optional(text)".into()),
                ),
            ]
            .into(),
        ),
        output_schema: TypeExpression::Record(
            [
                (
                    "repository_path".into(),
                    TypeExpression::Name("repo_path".into()),
                ),
                (
                    "push_remote_owner".into(),
                    TypeExpression::Name("ident".into()),
                ),
                ("head".into(), TypeExpression::Name("ident".into())),
            ]
            .into(),
        ),
        error_codes: vec![],
    }]
}

#[test]
fn v2_rejection_manifest_names_every_section_three_class() {
    use std::collections::BTreeMap;
    use workflow_compiler::{compile_workflow, decode_workflow};
    let manifest: Value =
        serde_json::from_str(include_str!("../../../fixtures/invalid/manifest.json")).unwrap();
    let prompts: BTreeMap<String, String> = [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}}"),
        ("fan-out/item.md", "{{text}}"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    let operations = prepare_operation();
    for case in manifest["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected = case["reason"].as_str().unwrap();
        if let Some(raw) = case.get("raw") {
            let error = decode_workflow(raw.as_str().unwrap().as_bytes()).unwrap_err();
            assert_eq!(error.kind, DomainErrorKind::DuplicateKey, "{name}");
            assert_eq!(&*error.path, "json", "{name}");
            continue;
        }
        let mut value: Value = serde_json::from_str(match case["base"].as_str().unwrap() {
            "review-loop" => include_str!("../../../fixtures/bundles/review-loop.json"),
            "fan-out" => include_str!("../../../fixtures/bundles/fan-out.json"),
            _ => panic!("unknown fixture"),
        })
        .unwrap();
        if let Some(pointer) = case.get("pointer") {
            let pointer = pointer.as_str().unwrap();
            if let Some(target) = value.pointer_mut(pointer) {
                *target = case["value"].clone();
            } else {
                let (parent, key) = pointer.rsplit_once('/').expect(name);
                value
                    .pointer_mut(parent)
                    .expect(name)
                    .as_object_mut()
                    .expect(name)
                    .insert(key.into(), case["value"].clone());
            }
        }
        let mut prompts = prompts.clone();
        if let Some(override_text) = case.get("prompt_override") {
            prompts.insert(
                "review-loop/editor.md".into(),
                override_text.as_str().unwrap().into(),
            );
        }
        let error = match decode_workflow(&serde_json::to_vec(&value).unwrap()) {
            Ok(source) => compile_workflow(&source, &operations, &prompts).unwrap_err(),
            Err(error) => error,
        };
        assert_eq!(&*error.entity_id, expected, "{name}: {error:?}");
        assert!(
            !error.path.is_empty() && !error.path.starts_with("check "),
            "{name}: {error:?}"
        );
    }
}

/// Sample A with its writer on `session: fresh` and a handoff template whose text is `handoff`.
fn fresh_writer_with_handoff(handoff: &str) -> Result<(), DomainError> {
    use std::collections::BTreeMap;
    use workflow_compiler::{compile_workflow, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/review-loop.json")).unwrap();
    let writer = value
        .pointer_mut("/stages/document/workers/writer")
        .unwrap();
    writer["session"] = "fresh".into();
    writer["prompts"]["handoff"] = "review-loop/handoff.md".into();
    let prompts: BTreeMap<String, String> = [
        ("review-loop/write.md", "{{topic}}"),
        ("review-loop/revise.md", "{{feedback}}"),
        ("review-loop/critique.md", "{{subject}}"),
        ("review-loop/editor.md", "{{draft}}"),
        ("review-loop/handoff.md", handoff),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap())?;
    compile_workflow(&source, &[], &prompts).map(|_| ())
}

#[test]
fn a_fresh_handoff_template_reads_its_engine_fields_and_the_declared_inputs() {
    let template = "{{artifacts}} {{feedback}} {{previous_attempt}} {{topic}}";
    assert!(fresh_writer_with_handoff(template).is_ok());
}

#[test]
fn a_handoff_template_cannot_read_a_mode_only_engine_input() {
    // Threads are for people: no prompt reads them.
    for field in ["previous", "subject", "threads"] {
        let error = fresh_writer_with_handoff(&format!("{{{{{field}}}}}")).unwrap_err();
        assert_eq!(&*error.entity_id, "check 10", "{field}");
        assert!(
            error.path.starts_with("stages.document.workers.writer"),
            "{error:?}"
        );
    }
}

/// Sample B (fan-out) with `edit` applied to its source, compiled.
fn compile_fan_out(edit: impl FnOnce(&mut Value)) -> Result<(), DomainError> {
    use std::collections::BTreeMap;
    use workflow_compiler::{compile_workflow, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    edit(&mut value);
    let prompts = BTreeMap::from([("fan-out/item.md".to_owned(), "{{text}}".to_owned())]);
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    compile_workflow(&source, &prepare_operation(), &prompts).map(|_| ())
}

/// Sample B (fan-out) with `edit` applied to its source: the compile error.
fn fan_out_compile_error(edit: impl FnOnce(&mut Value)) -> DomainError {
    compile_fan_out(edit).unwrap_err()
}

#[test]
fn an_unused_outcome_type_resolves_to_the_stage_outcome() {
    let compiled = compile_fan_out(|value| {
        value["schemas"]["future"] = "outcome_of(item)".into();
    });
    assert!(compiled.is_ok(), "{compiled:?}");
}

#[test]
fn a_schema_cannot_shadow_a_primitive_type() {
    for primitive in ["text", "ident", "repo_path", "integer", "boolean"] {
        let error = fan_out_compile_error(|value| {
            value["schemas"][primitive] = "integer".into();
        });
        assert!(
            error.detail.contains("shadows a primitive type"),
            "{primitive}: {error:?}"
        );
        assert_eq!(&*error.path, format!("schemas.{primitive}"));
    }
}

/// A `work` input that reads `prepare`'s outcome inside a list function.
const NESTED_OUTCOME_READ: &str = "filter(input.items, item.key != prepare.outcome.workspace.head)";

#[test]
fn a_unit_input_reads_an_after_units_outcome_inside_a_list_function() {
    let compiled = compile_fan_out(|value| {
        value["run"]["units"]["work"]["input"]["items"] = NESTED_OUTCOME_READ.into();
    });
    assert!(compiled.is_ok(), "{compiled:?}");
}

#[test]
fn a_unit_input_cannot_read_an_outcome_outside_after_inside_a_list_function() {
    let error = compile_fan_out(|value| {
        let work = &mut value["run"]["units"]["work"];
        work["after"] = serde_json::json!([]);
        work["input"]["workspace"] = "input.repository".into();
        work["input"]["items"] = NESTED_OUTCOME_READ.into();
    })
    .unwrap_err();
    assert_eq!(&*error.path, "run.units.work.input.items");
    assert_eq!(
        (&*error.entity_id, &*error.detail),
        (
            "check 3",
            "unit outcome prepare absent or outside read scope"
        )
    );
}

fn tail_unit(after: Value) -> Value {
    serde_json::json!({ "stage": "item", "after": after,
        "input": { "text": "\"tail\"", "workspace": "input.workspace" } })
}

#[test]
fn a_unit_cannot_wait_on_a_collection() {
    let error = fan_out_compile_error(|value| {
        value["run"]["units"]["work"]["group"]["units"]["tail"] =
            tail_unit(serde_json::json!(["item"]));
    });
    assert_eq!(
        &*error.detail,
        "unit tail waits on collection item, which is no one unit"
    );
    assert_eq!(&*error.path, "run.units.work.group.units.tail");
}

#[test]
fn a_collection_cannot_share_its_group() {
    let error = fan_out_compile_error(|value| {
        value["run"]["units"]["work"]["group"]["units"]["tail"] = tail_unit(Value::Null);
    });
    assert_eq!(
        &*error.detail,
        "collection item shares its group, so a member key could collide with a sibling"
    );
    assert!(
        error.path.starts_with("run.units.work.group.units"),
        "{error:?}"
    );
}

#[test]
fn a_group_outcome_reads_a_collection_only_through_map() {
    // `item.` reads a list function's element, so the collection is renamed.
    for read in ["task.outcome.result", "task.outcome", "len(task.outcome)"] {
        let error = fan_out_compile_error(|value| {
            let group = &mut value["run"]["units"]["work"]["group"];
            let task = group["units"]["item"].take();
            group["units"] = serde_json::json!({ "task": task });
            group["outcome"] =
                serde_json::json!({ "results": "map(task, task.outcome.result)", "first": read });
        });
        assert_eq!(
            &*error.detail, "collection task outcome is read only through map",
            "{read}"
        );
        assert_eq!(&*error.path, "run.units.work.group.outcome.first");
    }
}

#[test]
fn independent_stage_errors_are_collected() {
    use workflow_compiler::{compile_workflow_detailed, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    value["stages"]["prepare"]["done_when"] = Value::Null;
    value["stages"]["item"]["done_when"] = Value::Null;
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(
        &source,
        &prepare_operation(),
        &BTreeMap::from([("fan-out/item.md".into(), "{{text}}".into())]),
    )
    .unwrap_err();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(errors[0].path.0, "stages.item.done_when");
    assert_eq!(errors[1].path.0, "stages.prepare.done_when");
}

#[test]
fn independent_worker_errors_in_one_stage_are_collected() {
    use workflow_compiler::{compile_workflow_detailed, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    value["stages"]["prepare"]["workers"]["git"]["operation"] = "missing".into();
    value["stages"]["prepare"]["workers"]["git"]["every"] = "soon".into();
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(
        &source,
        &prepare_operation(),
        &BTreeMap::from([("fan-out/item.md".into(), "{{text}}".into())]),
    )
    .unwrap_err();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(errors[0].path.0, "stages.prepare.workers.git.operation");
    assert_eq!(errors[1].path.0, "stages.prepare.workers.git.every");
}

#[test]
fn independent_expression_errors_in_one_stage_are_collected() {
    use workflow_compiler::{compile_workflow_detailed, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    value["stages"]["item"]["workers"]["worker"]["inputs"]["text"] = "input.missing".into();
    value["stages"]["item"]["workers"]["worker"]["inputs"]["workspace"] = "input.absent".into();
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    let errors = compile_workflow_detailed(
        &source,
        &prepare_operation(),
        &BTreeMap::from([("fan-out/item.md".into(), "{{text}}".into())]),
    )
    .unwrap_err();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(errors[0].path.0, "stages.item.workers.worker.inputs.text");
    assert_eq!(
        errors[1].path.0,
        "stages.item.workers.worker.inputs.workspace"
    );
}
