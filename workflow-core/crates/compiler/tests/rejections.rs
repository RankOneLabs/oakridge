use serde_json::{json, Value};
use workflow_compiler::{compile, decode_bundle};
use workflow_model::*;
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/bundles/minimal.json")).unwrap()
}
fn reject(mut value: Value, edit: impl FnOnce(&mut Value), expected: DomainErrorKind) {
    edit(&mut value);
    let source: DefinitionBundle = serde_json::from_value(value).unwrap();
    assert_eq!(
        compile(&source, &source.operations).unwrap_err().kind,
        expected
    );
}
#[test]
fn generic_fixture_compiles() {
    let b = decode_bundle(include_bytes!("../../../fixtures/bundles/minimal.json")).unwrap();
    assert!(compile(&b, &b.operations).is_ok());
}
#[test]
fn sec_4_5_source_contract_rows_have_named_fields_and_missing_field_diagnostics() {
    let minimal = fixture();
    let children: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/children-1.json")).unwrap();
    let mut reject = minimal.clone();
    reject["scopes"][0]["tree"]["otherwise"] = json!({
        "kind": "reject", "id": "denied", "error": "invalid_command", "detail": {}
    });
    let rows: [(&str, &Value, &str, &[&str], &str); 10] = [
        (
            "Bundle",
            &minimal,
            "",
            &[
                "language_version",
                "key",
                "version",
                "root",
                "schemas",
                "scopes",
                "prompts",
                "operations",
                "limits",
            ],
            "root",
        ),
        (
            "Scope",
            &minimal,
            "/scopes/0",
            &[
                "input_schema",
                "state_schema",
                "initial",
                "commands",
                "facts",
                "errors",
                "exports",
                "resources",
                "presentation",
                "outcome_schema",
                "outputs",
                "workers",
                "children",
                "pools",
                "cancellation",
                "tree",
            ],
            "state_schema",
        ),
        (
            "Command",
            &minimal,
            "/scopes/0/commands/0",
            &[
                "key",
                "payload_schema",
                "available_in",
                "targets",
                "label",
                "consequence",
                "field_presentation",
            ],
            "payload_schema",
        ),
        (
            "Action",
            &minimal,
            "/scopes/0/workers/0/actions/0",
            &[
                "key",
                "operation",
                "contract_version",
                "input_schema",
                "input",
                "prompt",
                "outputs",
                "settings",
                "tools",
                "deadline_ms",
                "max_attempts",
            ],
            "operation",
        ),
        (
            "Output",
            &minimal,
            "/scopes/0/outputs/0",
            &["key", "schema", "collection_key", "policy", "producers"],
            "policy",
        ),
        (
            "Child",
            &children,
            "/scopes/0/children/0",
            &[
                "key",
                "scope",
                "input",
                "depends_on",
                "imports",
                "collection",
            ],
            "scope",
        ),
        (
            "Match",
            &minimal,
            "/scopes/0/tree",
            &["kind", "id", "value", "cases", "otherwise"],
            "cases",
        ),
        (
            "Apply",
            &minimal,
            "/scopes/0/tree/cases/0/node",
            &["kind", "id", "mutations", "actions", "outcome"],
            "mutations",
        ),
        (
            "Wait",
            &minimal,
            "/scopes/0/tree/otherwise",
            &["kind", "id", "continuations", "reason", "attention"],
            "attention",
        ),
        (
            "Reject",
            &reject,
            "/scopes/0/tree/otherwise",
            &["kind", "id", "error", "detail"],
            "error",
        ),
    ];
    for (row, source, path, fields, required) in rows {
        let value = source.pointer(path).unwrap();
        for field in fields {
            assert!(value.get(field).is_some(), "Sec 4.5 {row}.{field}");
        }
        for field in fields {
            let mut missing = source.clone();
            missing
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(*field);
            let decoded = decode_bundle(&serde_json::to_vec(&missing).unwrap());
            let is_optional = matches!(
                (row, *field),
                ("Action", "prompt")
                    | ("Output", "collection_key")
                    | ("Child", "collection")
                    | ("Match", "otherwise")
                    | ("Apply", "outcome")
            );
            if is_optional {
                assert!(decoded.is_ok(), "Sec 4.5 {row}.{field} permits absence");
                continue;
            }
            let diagnostic = decoded.unwrap_err();
            assert_eq!(
                diagnostic.kind,
                DomainErrorKind::MalformedBundle,
                "Sec 4.5 {row}.{field}"
            );
            assert!(
                diagnostic.detail.contains(field),
                "Sec 4.5 {row}.{field}: {diagnostic:?}"
            );
        }
        assert!(fields.contains(&required), "Sec 4.5 {row}.{required}");
    }
    let bundle = decode_bundle(&serde_json::to_vec(&minimal).unwrap()).unwrap();
    assert!(compile(&bundle, &bundle.operations).is_ok());
}

fn command_presentation_fixture() -> Value {
    let mut value = fixture();
    value["schemas"].as_array_mut().unwrap().push(json!({
        "key": "feedback", "shape": {"kind": "record", "fields": [
            {"key": "reason", "schema": "text", "required": true},
            {"key": "note", "schema": "text", "required": false}
        ], "dictionary": null}
    }));
    value["scopes"][0]["commands"][0]["payload_schema"] = json!("feedback");
    value["scopes"][0]["commands"][0]["field_presentation"] = json!([
        {"key": "reason", "presentation": {"label": "Reason for revision", "viewer": "generic"}},
        {"key": "note", "presentation": {"label": "Additional note", "viewer": null}}
    ]);
    value
}

#[test]
fn sec_4_5_command_field_presentation_survives_compilation_and_serialization() {
    let value = command_presentation_fixture();
    let source = decode_bundle(&serde_json::to_vec(&value).unwrap()).unwrap();
    let checked = compile(&source, &source.operations).unwrap();
    let serialized = serde_json::to_value(&checked.derived).unwrap();
    assert_eq!(
        serialized["scopes"][0]["commands"][0]["field_presentation"],
        value["scopes"][0]["commands"][0]["field_presentation"]
    );
}

#[test]
fn sec_4_5_command_field_presentation_requires_declared_payload_fields() {
    let mut value = command_presentation_fixture();
    value["scopes"][0]["commands"][0]["field_presentation"][0]["key"] = json!("unknown");
    let source = decode_bundle(&serde_json::to_vec(&value).unwrap()).unwrap();
    let diagnostic = compile(&source, &source.operations).unwrap_err();
    assert_eq!(diagnostic.kind, DomainErrorKind::MissingSymbol);
    assert_eq!(diagnostic.entity_id.as_ref(), "begin.unknown");
}

#[test]
fn sec_4_5_command_field_presentation_rejects_duplicate_fields() {
    reject(
        command_presentation_fixture(),
        |value| {
            value["scopes"][0]["commands"][0]["field_presentation"][1]["key"] = json!("reason");
        },
        DomainErrorKind::DuplicateSymbol,
    );
}

#[test]
fn sec_4_5_command_field_presentation_requires_nonblank_labels() {
    for label in ["", "   "] {
        reject(
            command_presentation_fixture(),
            |value| {
                value["scopes"][0]["commands"][0]["field_presentation"][0]["presentation"]
                    ["label"] = json!(label);
            },
            DomainErrorKind::UnsupportedPresentation,
        );
    }
}

#[test]
fn sec_4_5_command_field_presentation_rejects_unsupported_viewers() {
    reject(
        command_presentation_fixture(),
        |value| {
            value["scopes"][0]["commands"][0]["field_presentation"][0]["presentation"]["viewer"] =
                json!("custom");
        },
        DomainErrorKind::UnsupportedPresentation,
    );
}

#[test]
fn sec_4_5_command_field_presentation_requires_a_record_payload() {
    reject(
        command_presentation_fixture(),
        |value| {
            value["scopes"][0]["commands"][0]["payload_schema"] = json!("text");
        },
        DomainErrorKind::UnsupportedPresentation,
    );
}

#[test]
fn sec_4_5_command_field_presentation_rejects_unknown_fields() {
    for path in [
        "/scopes/0/commands/0/field_presentation/0",
        "/scopes/0/commands/0/field_presentation/0/presentation",
    ] {
        let mut value = command_presentation_fixture();
        value.pointer_mut(path).unwrap()["extra"] = json!(true);
        assert_eq!(
            decode_bundle(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .kind,
            DomainErrorKind::MalformedBundle
        );
    }
}

#[test]
fn sec_4_5_wait_attention_requires_a_declared_continuation() {
    reject(
        fixture(),
        |v| {
            v["scopes"][0]["tree"]["otherwise"]["attention"]["trigger"] = json!("unknown");
        },
        DomainErrorKind::UndeclaredTrigger,
    );
}

#[test]
fn sec_4_5_bundle_presentation_is_owned_by_its_declared_scopes() {
    let bundle = decode_bundle(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
    let checked = compile(&bundle, &bundle.operations).unwrap();
    assert_eq!(
        checked.derived.scopes[0].presentation.label,
        bundle.scopes[0].presentation.label
    );
    reject(
        fixture(),
        |value| {
            value["scopes"][0]["presentation"]["viewer"] = json!("unsupported");
        },
        DomainErrorKind::UnsupportedPresentation,
    );
}

#[test]
fn sec_4_5_wait_attention_rejects_declared_symbols_outside_its_continuations() {
    reject(
        fixture(),
        |value| {
            value["scopes"][0]["tree"]["otherwise"]["attention"]["trigger"] = json!("begin");
        },
        DomainErrorKind::UndeclaredTrigger,
    );
}

#[test]
fn sec_4_5_wait_attention_rejects_blank_labels() {
    for label in ["", "   "] {
        reject(
            fixture(),
            |value| {
                value["scopes"][0]["tree"]["otherwise"]["attention"]["label"] = json!(label);
            },
            DomainErrorKind::MissingBinding,
        );
    }
}

#[test]
fn sec_4_5_wait_attention_rejects_unknown_fields() {
    let mut value = fixture();
    value["scopes"][0]["tree"]["otherwise"]["attention"]["extra"] = json!(true);
    assert_eq!(
        decode_bundle(&serde_json::to_vec(&value).unwrap())
            .unwrap_err()
            .kind,
        DomainErrorKind::MalformedBundle
    );
}
#[test]
fn terminal_state_write_cannot_make_later_actions_reachable() {
    reject(
        fixture(),
        |v| {
            let outcome = v["scopes"][0]["tree"]["cases"][1]["node"]["outcome"].clone();
            let actions = v["scopes"][0]["tree"]["cases"][0]["node"]["actions"].clone();
            v["scopes"][0]["tree"]["cases"][0]["node"]["outcome"] = outcome;
            v["scopes"][0]["tree"]["cases"][0]["node"]["actions"] = json!([]);
            v["scopes"][0]["tree"]["cases"][1]["node"]["actions"] = actions;
        },
        DomainErrorKind::UnreachableDeclaration,
    );
}
#[test]
fn native_schema_bounds_cannot_exceed_wire_integer_range() {
    let mut source: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    source.schemas.push(Schema {
        key: SchemaId::from("wide"),
        shape: SchemaShape::Integer {
            min: i64::MIN,
            max: i64::MAX,
        },
    });
    assert_eq!(
        compile(&source, &source.operations).unwrap_err().kind,
        DomainErrorKind::InvalidSchema
    );
}
#[test]
fn checked_integer_payloads_preserve_safe_endpoints_and_reject_wide_values() {
    let mut source: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    let key = SchemaId::from("number");
    source.schemas.push(Schema {
        key: key.clone(),
        shape: SchemaShape::Integer {
            min: wire_numbers::MIN_SAFE_INTEGER,
            max: wire_numbers::MAX_SAFE_INTEGER,
        },
    });
    for value in [
        wire_numbers::MIN_SAFE_INTEGER,
        wire_numbers::MAX_SAFE_INTEGER,
    ] {
        assert_eq!(
            workflow_compiler::check_value(&source, &key, &json!(value))
                .unwrap()
                .data,
            CheckedData::Integer { value }
        );
    }
    for value in [
        wire_numbers::MIN_SAFE_INTEGER - 1,
        wire_numbers::MAX_SAFE_INTEGER + 1,
        i64::MIN,
        i64::MAX,
    ] {
        assert_eq!(
            workflow_compiler::check_value(&source, &key, &json!(value))
                .unwrap_err()
                .kind,
            DomainErrorKind::InvalidPayload
        );
    }
}
#[test]
fn missing_root_symbol() {
    reject(
        fixture(),
        |v| v["root"] = json!("missing"),
        DomainErrorKind::MissingSymbol,
    );
}
#[test]
fn duplicate_named_schema() {
    reject(
        fixture(),
        |v| {
            let s = v["schemas"][0].clone();
            v["schemas"].as_array_mut().unwrap().push(s);
        },
        DomainErrorKind::DuplicateSymbol,
    );
}
#[test]
fn duplicate_json_keys_fail_before_overwrite() {
    assert_eq!(
        decode_bundle(br#"{"language_version":1,"language_version":2}"#)
            .unwrap_err()
            .kind,
        DomainErrorKind::DuplicateSymbol
    );
}
#[test]
fn unknown_fields_have_no_semantics() {
    let mut v = fixture();
    v["invented"] = json!(true);
    assert_eq!(
        decode_bundle(&serde_json::to_vec(&v).unwrap())
            .unwrap_err()
            .kind,
        DomainErrorKind::MalformedBundle
    );
}
#[test]
fn unsupported_language_version() {
    reject(
        fixture(),
        |v| v["language_version"] = json!(2),
        DomainErrorKind::UnsupportedVersion,
    );
}
#[test]
fn missing_prompt_content() {
    reject(
        fixture(),
        |v| v["prompts"][0]["content"] = json!(""),
        DomainErrorKind::UnresolvedContent,
    );
}
#[test]
fn prompt_path_cannot_escape_repository() {
    reject(
        fixture(),
        |v| v["prompts"][0]["path"] = json!("../secret"),
        DomainErrorKind::UnresolvedContent,
    );
}
#[test]
fn invalid_integer_bounds() {
    reject(
        fixture(),
        |v| {
            v["schemas"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"bad","shape":{"kind":"integer","min":5,"max":2}}))
        },
        DomainErrorKind::InvalidSchema,
    );
}
#[test]
fn recursive_value_schema() {
    reject(
        fixture(),
        |v| {
            v["schemas"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"recursive","shape":{"kind":"optional","item":"recursive"}}))
        },
        DomainErrorKind::RecursiveSchema,
    );
}
#[test]
fn wrong_action_input_port() {
    reject(
        fixture(),
        |v| {
            v["scopes"][0]["workers"][0]["actions"][0]["input"] =
                json!({"kind":"literal","schema":"flag","value":true})
        },
        DomainErrorKind::IncompatiblePort,
    );
}
#[test]
fn wrong_reference_brand() {
    reject(
        fixture(),
        |v| {
            v["scopes"][0]["commands"][0]["targets"] = json!([{"kind":"literal","schema":"revision","value":{"brand":"resource","id":"r"}}])
        },
        DomainErrorKind::WrongBrand,
    );
}
#[test]
fn missing_required_record_binding() {
    reject(
        fixture(),
        |v| {
            v["schemas"].as_array_mut().unwrap().push(json!({"key":"needs_field","shape":{"kind":"record","fields":[{"key":"required","schema":"flag","required":true}],"dictionary":null}}));
            v["operations"][0]["input_schema"] = json!("needs_field");
            v["prompts"][0]["input_schema"] = json!("needs_field");
            v["scopes"][0]["workers"][0]["actions"][0]["input_schema"] = json!("needs_field");
            v["scopes"][0]["workers"][0]["actions"][0]["input"] =
                json!({"kind":"record","schema":"needs_field","fields":[]});
        },
        DomainErrorKind::MissingBinding,
    );
}
#[test]
fn nullable_input_must_be_guarded() {
    reject(
        fixture(),
        |v| {
            v["schemas"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"nullable_record","shape":{"kind":"optional","item":"member"}}));
            v["scopes"][0]["input_schema"] = json!("nullable_record");
            v["scopes"][0]["workers"][0]["actions"][0]["input"] =
                json!({"kind":"reference","root":{"kind":"input"},"path":["input"]});
        },
        DomainErrorKind::UnguardedOptional,
    );
}
#[test]
fn private_child_state_cannot_be_read() {
    let v: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/children-1.json")).unwrap();
    reject(
        v,
        |v| {
            v["scopes"][0]["tree"]["cases"][1]["node"]["condition"]["items"][0]["root"]["export"] =
                json!("state")
        },
        DomainErrorKind::PrivateRead,
    );
}
#[test]
fn command_case_must_belong_to_scope() {
    reject(
        fixture(),
        |v| v["scopes"][0]["tree"]["cases"][0]["variant"] = json!("foreign_command"),
        DomainErrorKind::UndeclaredTrigger,
    );
}
#[test]
fn finite_match_requires_explicit_fallback() {
    reject(
        fixture(),
        |v| v["scopes"][0]["tree"]["otherwise"] = Value::Null,
        DomainErrorKind::NonExhaustiveMatch,
    );
}
#[test]
fn leaf_cannot_write_same_owned_field_twice() {
    reject(
        fixture(),
        |v| {
            let m = v["scopes"][0]["tree"]["cases"][0]["node"]["mutations"][0].clone();
            v["scopes"][0]["tree"]["cases"][0]["node"]["mutations"]
                .as_array_mut()
                .unwrap()
                .push(m);
        },
        DomainErrorKind::ConflictingWrite,
    );
}
#[test]
fn state_assignment_requires_declared_schema() {
    reject(
        fixture(),
        |v| {
            v["scopes"][0]["tree"]["cases"][0]["node"]["mutations"][0]["value"] =
                json!({"kind":"literal","schema":"flag","value":true})
        },
        DomainErrorKind::InvalidAssignment,
    );
}
#[test]
fn duplicate_exclusive_action_launch() {
    reject(
        fixture(),
        |v| {
            let a = v["scopes"][0]["tree"]["cases"][0]["node"]["actions"][0].clone();
            v["scopes"][0]["tree"]["cases"][0]["node"]["actions"]
                .as_array_mut()
                .unwrap()
                .push(a);
        },
        DomainErrorKind::DuplicateLaunch,
    );
}
#[test]
fn stop_and_launch_same_worker_are_incompatible() {
    reject(
        fixture(),
        |v| {
            v["scopes"][0]["tree"]["cases"][0]["node"]["mutations"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind":"stop","worker":"author"}))
        },
        DomainErrorKind::DuplicateLaunch,
    );
}
#[test]
fn cyclic_static_child_prerequisites() {
    let v: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/children-1.json")).unwrap();
    reject(
        v,
        |v| v["scopes"][0]["children"][0]["depends_on"] = json!(["item_0"]),
        DomainErrorKind::CyclicPrerequisite,
    );
}
#[test]
fn invalid_dynamic_input_mapping() {
    let v: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/dynamic.json")).unwrap();
    reject(
        v,
        |v| v["scopes"][0]["children"][0]["collection"]["input_field"] = json!("key"),
        DomainErrorKind::InvalidTemplate,
    );
}
#[test]
fn structurally_unreachable_state() {
    reject(
        fixture(),
        |v| {
            v["schemas"][3]["shape"]["variants"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"orphan","schema":"unit"}))
        },
        DomainErrorKind::UnreachableDeclaration,
    );
}
#[test]
fn structurally_unreachable_action() {
    reject(
        fixture(),
        |v| {
            let mut a = v["scopes"][0]["workers"][0]["actions"][0].clone();
            a["key"] = json!("orphan");
            v["scopes"][0]["workers"][0]["actions"]
                .as_array_mut()
                .unwrap()
                .push(a);
        },
        DomainErrorKind::UnreachableDeclaration,
    );
}
#[test]
fn structurally_unreachable_outcome() {
    reject(
        fixture(),
        |v| {
            v["schemas"][4]["shape"]["variants"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"orphan","schema":"unit"}))
        },
        DomainErrorKind::UnreachableDeclaration,
    );
}
#[test]
fn initial_wait_without_continuation_is_invalid() {
    reject(
        fixture(),
        |v| v["scopes"][0]["tree"] = json!({"kind":"wait","id":"dead","continuations":[],"reason":"nothing","attention":{"label":"Awaiting input","trigger":"cancel"}}),
        DomainErrorKind::DeadRegion,
    );
}
#[test]
fn required_command_needs_handling_path() {
    reject(
        fixture(),
        |v| v["scopes"][0]["tree"]["cases"][1]["node"] = json!({"kind":"reject","id":"unhandled","error":"invalid_command","detail":"unrelated generic rejection"}),
        DomainErrorKind::UnhandledCommand,
    );
}
#[test]
fn unsupported_provider_settings() {
    reject(
        fixture(),
        |v| v["scopes"][0]["workers"][0]["actions"][0]["settings"][0]["key"] = json!("unavailable"),
        DomainErrorKind::UnsupportedProvider,
    );
}
#[test]
fn unavailable_pinned_operation_version() {
    let b: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    assert_eq!(
        compile(&b, &[]).unwrap_err().kind,
        DomainErrorKind::UnavailableOperation
    );
}
#[test]
fn unhonorable_tool_authorization() {
    reject(
        fixture(),
        |v| v["scopes"][0]["workers"][0]["actions"][0]["tools"] = json!(["unavailable"]),
        DomainErrorKind::UnsupportedAuthorization,
    );
}
#[test]
fn output_publication_requires_authorized_producer() {
    reject(
        fixture(),
        |v| v["scopes"][0]["outputs"][0]["producers"] = json!(["foreign"]),
        DomainErrorKind::UnsupportedPublication,
    );
}
#[test]
fn unsupported_revision_policy_is_rejected_at_decode() {
    let mut v = fixture();
    v["scopes"][0]["outputs"][0]["policy"] = json!({"kind":"unknown"});
    assert_eq!(
        decode_bundle(&serde_json::to_vec(&v).unwrap())
            .unwrap_err()
            .kind,
        DomainErrorKind::MalformedBundle
    );
}
#[test]
fn unsupported_presentation_cannot_be_persisted() {
    reject(
        fixture(),
        |v| v["scopes"][0]["presentation"]["viewer"] = json!("unknown"),
        DomainErrorKind::UnsupportedPresentation,
    );
}
#[test]
fn zero_capacity_is_rejected() {
    reject(
        fixture(),
        |v| v["scopes"][0]["pools"][0]["limit"] = json!(0),
        DomainErrorKind::InvalidSchema,
    );
}
#[test]
fn oversized_type_list_is_rejected() {
    reject(
        fixture(),
        |v| v["schemas"][9]["shape"]["max_items"] = json!(101),
        DomainErrorKind::ResourceLimit,
    );
}
#[test]
fn expression_depth_is_bounded() {
    reject(
        fixture(),
        |v| {
            let mut e = json!({"kind":"literal","schema":"flag","value":true});
            v["limits"]["max_depth"] = json!(8);
            for _ in 0..10 {
                e = json!({"kind":"not","value":e});
            }
            v["scopes"][0]["tree"]["cases"][0]["node"] = json!({"kind":"if","id":"deep","condition":e,"then":v["scopes"][0]["tree"]["cases"][0]["node"].clone(),"otherwise":{"kind":"wait","id":"no","continuations":["cancel"],"reason":"wait","attention":{"label":"Awaiting input","trigger":"cancel"}}});
        },
        DomainErrorKind::ResourceLimit,
    );
}
#[test]
fn semantically_identical_json_object_order_has_same_digest() {
    let a = fixture();
    let mut object = serde_json::Map::new();
    for (k, v) in a.as_object().unwrap().iter().rev() {
        object.insert(k.clone(), v.clone());
    }
    let a: DefinitionBundle = serde_json::from_value(a).unwrap();
    let b: DefinitionBundle = serde_json::from_value(object.into()).unwrap();
    assert_eq!(
        compile(&a, &a.operations).unwrap().digest,
        compile(&b, &b.operations).unwrap().digest
    );
}
#[test]
fn prompt_content_is_part_of_bundle_pin() {
    let a: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    let mut b = a.clone();
    b.prompts[0].content.push('!');
    assert_ne!(
        compile(&a, &a.operations).unwrap().digest,
        compile(&b, &b.operations).unwrap().digest
    );
}

#[test]
fn invalid_shared_corpus_has_stable_diagnostic_kinds() {
    #[derive(serde::Deserialize)]
    struct InvalidCase {
        file: String,
        expected: DomainErrorKind,
    }
    let cases: Vec<InvalidCase> =
        serde_json::from_str(include_str!("../../../fixtures/invalid/manifest.json")).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/invalid");
    for case in cases {
        let b = decode_bundle(&std::fs::read(root.join(&case.file)).unwrap()).unwrap();
        assert_eq!(
            compile(&b, &b.operations).unwrap_err().kind,
            case.expected,
            "{}",
            case.file
        );
    }
}

#[test]
fn checked_bundle_serialization_is_deterministic() {
    let b = decode_bundle(include_bytes!("../../../fixtures/bundles/children-7.json")).unwrap();
    let expected = serde_json::to_vec(&compile(&b, &b.operations).unwrap()).unwrap();
    for _ in 0..8 {
        assert_eq!(
            serde_json::to_vec(&compile(&b, &b.operations).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn reachable_closed_nonterminal_region_is_rejected() {
    reject(
        fixture(),
        |v| {
            v["schemas"][3]["shape"]["variants"]
                .as_array_mut()
                .unwrap()
                .push(json!({"key":"blocked","schema":"unit"}));
            let mut original = v["scopes"][0]["tree"].clone();
            original["cases"].as_array_mut().unwrap().push(json!({"variant":"tick","node":{
            "kind":"apply","id":"enter_blocked","mutations":[{"kind":"set_state","value":{"kind":"literal","schema":"position","value":{"kind":"blocked","value":{}}}}],"actions":[],"outcome":null
        }}));
            v["scopes"][0]["tree"] = json!({"kind":"if","id":"blocked_check","condition":{"kind":"is_variant","value":{"kind":"reference","root":{"kind":"state"},"path":[]},"variant":"blocked"},"then":{"kind":"wait","id":"closed_region","continuations":["tick"],"reason":"no route","attention":{"label":"Awaiting input","trigger":"tick"}},"otherwise":original});
        },
        DomainErrorKind::DeadRegion,
    );
}

#[test]
fn lifecycle_entry_requires_declared_unit_command() {
    reject(
        fixture(),
        |source| source["scopes"][0]["entry_command"] = json!("undeclared"),
        DomainErrorKind::UndeclaredTrigger,
    );
}
#[test]
fn publishable_output_requires_a_publication_trigger() {
    reject(
        fixture(),
        |source| {
            source["scopes"][0]["outputs"][0]
                .as_object_mut()
                .unwrap()
                .remove("publication_trigger");
        },
        DomainErrorKind::UnsupportedPublication,
    );
}
#[test]
fn publishable_output_rejects_a_null_publication_trigger() {
    reject(
        fixture(),
        |source| source["scopes"][0]["outputs"][0]["publication_trigger"] = Value::Null,
        DomainErrorKind::UnsupportedPublication,
    );
}
#[test]
fn publication_trigger_requires_declared_fact() {
    reject(
        fixture(),
        |source| source["scopes"][0]["outputs"][0]["publication_trigger"] = json!("undeclared"),
        DomainErrorKind::UndeclaredTrigger,
    );
}
#[test]
fn collection_projection_cannot_read_an_undeclared_output() {
    reject(
        fixture(),
        |source| source["scopes"][0]["tree"]["cases"][0]["node"]["mutations"][0]["value"] = json!({"kind":"reference","root":{"kind":"output_collection","key":"private","schema":"unit"},"path":[]}),
        DomainErrorKind::MissingSymbol,
    );
}
#[test]
fn child_cancellation_cannot_address_a_private_child() {
    reject(
        fixture(),
        |source| {
            source["scopes"][0]["tree"]["cases"][0]["node"]["mutations"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind":"cancel_children","key":"private"}))
        },
        DomainErrorKind::MissingSymbol,
    );
}

#[test]
fn e1_unguarded_action_read_is_rejected() {
    let mut source = fixture();
    source["schemas"].as_array_mut().unwrap().extend([
        json!({"key":"guarded_record","shape":{"kind":"record","fields":[{"key":"value","schema":"unit","required":true}],"dictionary":null}}),
        json!({"key":"guarded_optional","shape":{"kind":"optional","item":"guarded_record"}}),
    ]);
    source["scopes"][0]["resources"][0]["schema"] = json!("guarded_optional");
    source["scopes"][0]["workers"][0]["actions"][0]["input"] =
        json!({"kind":"reference","root":{"kind":"resource","key":"source"},"path":["value"]});
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    assert_eq!(
        compile(&bundle, &bundle.operations).unwrap_err().kind,
        DomainErrorKind::UnguardedOptional
    );
}

#[test]
fn e4_zero_budget_is_rejected_before_evaluation() {
    reject(
        fixture(),
        |source| source["limits"]["evaluation_budget"] = json!(0),
        DomainErrorKind::ResourceLimit,
    );
}

#[test]
fn e3_shared_schema_still_counts_at_deeper_depth() {
    let mut source = fixture();
    source["limits"]["max_depth"] = json!(3);
    let schemas = source["schemas"].as_array_mut().unwrap();
    schemas.push(json!({"key":"depth_leaf","shape":{"kind":"optional","item":"unit"}}));
    for (key, item) in [
        ("depth_a", "depth_b"),
        ("depth_b", "depth_c"),
        ("depth_c", "depth_d"),
        ("depth_d", "depth_leaf"),
    ] {
        schemas.push(json!({"key":key,"shape":{"kind":"optional","item":item}}));
    }
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    assert_eq!(
        compile(&bundle, &bundle.operations).unwrap_err().kind,
        DomainErrorKind::ResourceLimit
    );
}

#[derive(Clone, Copy)]
enum Declaration {
    RootFirst,
    DependencyFirst,
}

/// Compile the fixture plus the chain depth_a -> depth_b -> depth_c -> unit
/// (four schemas on one path) under `max_depth`, with the links declared in
/// the given order. Returns the error kind, or None when the bundle compiles.
fn chain_outcome(order: Declaration, max_depth: usize) -> Option<DomainErrorKind> {
    let mut links = vec![
        json!({"key":"depth_a","shape":{"kind":"optional","item":"depth_b"}}),
        json!({"key":"depth_b","shape":{"kind":"optional","item":"depth_c"}}),
        json!({"key":"depth_c","shape":{"kind":"optional","item":"unit"}}),
    ];
    if matches!(order, Declaration::DependencyFirst) {
        links.reverse();
    }
    let mut source = fixture();
    source["limits"]["max_depth"] = json!(max_depth);
    source["schemas"].as_array_mut().unwrap().extend(links);
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    compile(&bundle, &bundle.operations).err().map(|e| e.kind)
}

#[test]
fn e3_schema_depth_does_not_depend_on_declaration_order() {
    // Declared dependency-first, each link is cached before its parent visits it,
    // so the parent must still be checked against the cached subtree height.
    assert_eq!(
        chain_outcome(Declaration::DependencyFirst, 3),
        Some(DomainErrorKind::ResourceLimit)
    );
    assert_eq!(
        chain_outcome(Declaration::RootFirst, 3),
        Some(DomainErrorKind::ResourceLimit)
    );
    assert_eq!(chain_outcome(Declaration::DependencyFirst, 4), None);
    assert_eq!(chain_outcome(Declaration::RootFirst, 4), None);
}

#[test]
fn e5_requested_budget_above_host_is_named() {
    let bundle: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    let host = ResourceLimits {
        max_list_items: 10_000,
        max_depth: 128,
        evaluation_budget: 100,
    };
    let error = workflow_compiler::compile_with_host(&bundle, &host).unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::LimitExceedsHost);
    assert!(error.detail.contains("2000") && error.detail.contains("100"));
}

#[test]
fn e6_malformed_bundle_reports_the_serde_path() {
    let mut source = fixture();
    source["scopes"][0]["workers"][0]["actions"][0]["invented"] = json!(true);
    let bytes = serde_json::to_vec(&source).unwrap();
    let error = decode_bundle(&bytes).unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::MalformedBundle);
    assert!(error
        .path
        .contains("scopes[0].workers[0].actions[0].invented"));
}

#[test]
fn e7_checked_program_has_derived_section_without_source_field() {
    let bundle: DefinitionBundle = serde_json::from_value(fixture()).unwrap();
    let checked = compile(&bundle, &bundle.operations).unwrap();
    let encoded = serde_json::to_value(checked).unwrap();
    assert!(encoded.get("source").is_none());
    assert!(encoded.get("derived").is_some());
    assert!(encoded["derived"].get("prompts").is_none());
    assert!(encoded["derived"].get("operations").is_none());
}

#[test]
fn e8_child_collection_read_rejects_shorter_list_schema() {
    let mut source: Value =
        serde_json::from_str(include_str!("../../../fixtures/bundles/dynamic.json")).unwrap();
    source["schemas"].as_array_mut().unwrap().push(
        json!({"key":"short_outcomes","shape":{"kind":"list","item":"result","max_items":1}}),
    );
    let original = source["scopes"][0]["tree"].clone();
    source["scopes"][0]["tree"] = json!({"kind":"if","id":"check_short_collection",
        "condition":{"kind":"every","source":{"kind":"reference","root":{"kind":"children_outcomes","key":"items","schema":"short_outcomes"},"path":[]},
          "predicate":{"kind":"literal","schema":"flag","value":true}},
        "then":original,
        "otherwise":{"kind":"wait","id":"short_collection_wait","continuations":["begin"],"reason":"waiting","attention":{"label":"Waiting","trigger":"begin"}}
    });
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    let error = compile(&bundle, &bundle.operations).unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::IncompatiblePort);
    assert!(error.detail.contains("1") && error.detail.contains("100"));
}

#[test]
fn e8_output_collection_read_rejects_shorter_list_schema() {
    let mut source = fixture();
    source["scopes"][0]["outputs"][0]["collection_key"] = json!("key");
    source["scopes"][0]["outputs"][0]["schema"] = json!("member");
    source["schemas"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"short_outputs","shape":{"kind":"list","item":"member","max_items":1}}));
    let original = source["scopes"][0]["tree"].clone();
    source["scopes"][0]["tree"] = json!({"kind":"if","id":"check_short_outputs",
        "condition":{"kind":"every","source":{"kind":"reference","root":{"kind":"output_collection","key":"document","schema":"short_outputs"},"path":[]},
          "predicate":{"kind":"literal","schema":"flag","value":true}},
        "then":original,
        "otherwise":{"kind":"wait","id":"short_outputs_wait","continuations":["begin"],"reason":"waiting","attention":{"label":"Waiting","trigger":"begin"}}
    });
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    let error = compile(&bundle, &bundle.operations).unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::IncompatiblePort);
    assert!(error.detail.contains("1") && error.detail.contains("100"));
}

#[test]
fn e8_output_revision_list_rejects_shorter_list_schema() {
    let mut source = fixture();
    source["scopes"][0]["outputs"][0]["collection_key"] = json!("key");
    source["scopes"][0]["outputs"][0]["schema"] = json!("member");
    source["schemas"].as_array_mut().unwrap().push(
        json!({"key":"short_revisions","shape":{"kind":"list","item":"revision","max_items":1}}),
    );
    let original = source["scopes"][0]["tree"].clone();
    source["scopes"][0]["tree"] = json!({"kind":"if","id":"check_short_revisions",
        "condition":{"kind":"every","source":{"kind":"reference","root":{"kind":"output_revisions","key":"document","schema":"short_revisions"},"path":[]},
          "predicate":{"kind":"literal","schema":"flag","value":true}},
        "then":original,
        "otherwise":{"kind":"wait","id":"short_revisions_wait","continuations":["begin"],"reason":"waiting","attention":{"label":"Waiting","trigger":"begin"}}
    });
    let bundle: DefinitionBundle = serde_json::from_value(source).unwrap();
    let error = compile(&bundle, &bundle.operations).unwrap_err();
    assert_eq!(error.kind, DomainErrorKind::IncompatiblePort);
    assert!(error.detail.contains("1") && error.detail.contains("100"));
}

#[test]
fn compiler_emits_the_complete_dynamic_scope_read_set() {
    let bundle: DefinitionBundle =
        serde_json::from_str(include_str!("../../../fixtures/bundles/dynamic.json")).unwrap();
    let checked = compile(&bundle, &bundle.operations).unwrap();
    let roots = &checked
        .scopes
        .iter()
        .find(|scope| scope.key.0 == "batch")
        .unwrap()
        .reads;
    assert_eq!(
        roots,
        &vec![
            ReferenceRoot::Trigger,
            ReferenceRoot::Item,
            ReferenceRoot::Input
        ]
    );
    let document = &checked
        .scopes
        .iter()
        .find(|scope| scope.key.0 == "document")
        .unwrap()
        .reads;
    assert_eq!(
        document,
        &vec![ReferenceRoot::Trigger, ReferenceRoot::Input]
    );
}
