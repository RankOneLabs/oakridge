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
                "exports",
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
                "provider",
                "contract_version",
                "input_schema",
                "input",
                "prompt",
                "outputs",
                "settings",
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
        let mut missing = source.clone();
        missing
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(required);
        let diagnostic = decode_bundle(&serde_json::to_vec(&missing).unwrap()).unwrap_err();
        assert_eq!(
            diagnostic.kind,
            DomainErrorKind::UnknownConstruct,
            "Sec 4.5 {row}.{required}"
        );
        assert!(
            diagnostic.detail.contains(required),
            "Sec 4.5 {row}.{required}: {diagnostic:?}"
        );
    }
    let bundle = decode_bundle(&serde_json::to_vec(&minimal).unwrap()).unwrap();
    assert!(compile(&bundle, &bundle.operations).is_ok());
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
fn sec_4_5_wait_attention_rejects_unknown_fields() {
    let mut value = fixture();
    value["scopes"][0]["tree"]["otherwise"]["attention"]["extra"] = json!(true);
    assert_eq!(
        decode_bundle(&serde_json::to_vec(&value).unwrap())
            .unwrap_err()
            .kind,
        DomainErrorKind::UnknownConstruct
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
        DomainErrorKind::UnknownConstruct
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
        |v| v["scopes"][0]["workers"][0]["actions"][0]["provider"] = json!("unavailable"),
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
        DomainErrorKind::UnknownConstruct
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
