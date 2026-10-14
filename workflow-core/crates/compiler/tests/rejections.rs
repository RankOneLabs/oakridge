use serde_json::Value;
use workflow_model::*;

/// `repository.prepare` as the samples' registry declares it.
fn prepare_operation() -> Vec<CodeOperation> {
    vec![CodeOperation {
        key: SymbolKey::from("repository.prepare"),
        version: 1,
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
    }
}

/// Sample B (fan-out) with `edit` applied to its source: the compile error's detail.
fn fan_out_compile_error(edit: impl FnOnce(&mut Value)) -> String {
    use std::collections::BTreeMap;
    use workflow_compiler::{compile_workflow, decode_workflow};
    let mut value: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
    edit(&mut value);
    let prompts = BTreeMap::from([("fan-out/item.md".to_owned(), "{{text}}".to_owned())]);
    let source = decode_workflow(&serde_json::to_vec(&value).unwrap()).unwrap();
    compile_workflow(&source, &prepare_operation(), &prompts)
        .map(|_| ())
        .unwrap_err()
        .detail
        .to_string()
}

fn tail_unit(after: Value) -> Value {
    serde_json::json!({ "stage": "item", "after": after,
        "input": { "text": "\"tail\"", "workspace": "input.workspace" } })
}

#[test]
fn a_unit_cannot_wait_on_a_collection() {
    let detail = fan_out_compile_error(|value| {
        value["run"]["units"]["work"]["group"]["units"]["tail"] =
            tail_unit(serde_json::json!(["item"]));
    });
    assert_eq!(
        detail,
        "unit tail waits on collection item, which is no one unit"
    );
}

#[test]
fn a_collection_cannot_share_its_group() {
    let detail = fan_out_compile_error(|value| {
        value["run"]["units"]["work"]["group"]["units"]["tail"] = tail_unit(Value::Null);
    });
    assert_eq!(
        detail,
        "collection item shares its group, so a member key could collide with a sibling"
    );
}

#[test]
fn a_group_outcome_reads_a_collection_only_through_map() {
    // `item.` reads a list function's element, so the collection is renamed.
    for read in ["task.outcome.result", "task.outcome", "len(task.outcome)"] {
        let detail = fan_out_compile_error(|value| {
            let group = &mut value["run"]["units"]["work"]["group"];
            let task = group["units"]["item"].take();
            group["units"] = serde_json::json!({ "task": task });
            group["outcome"] =
                serde_json::json!({ "results": "map(task, task.outcome.result)", "first": read });
        });
        assert_eq!(
            detail, "collection task outcome is read only through map",
            "{read}"
        );
    }
}
