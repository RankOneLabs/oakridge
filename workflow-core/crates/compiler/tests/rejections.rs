use serde_json::Value;
use workflow_model::*;

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
    let operations = vec![CodeOperation {
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
    }];
    for case in manifest["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected = case["reason"].as_str().unwrap();
        if let Some(raw) = case.get("raw") {
            let error = decode_workflow(raw.as_str().unwrap().as_bytes()).unwrap_err();
            assert_eq!(error.kind, DomainErrorKind::DuplicateSymbol, "{name}");
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
