use schemars::schema_for;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use workflow_model::protocol::{
    Request, Response, DECODER_MAX_JSON_DEPTH, DECODER_MAX_SCHEMA_HOPS, MAX_DEPTH_CEILING,
    MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};

/// The decoder source with its depth guards filled in from the protocol constants.
fn schema_decoder() -> String {
    include_str!("schema-decoder.ts.txt")
        .replace("{{MAX_JSON_DEPTH}}", &DECODER_MAX_JSON_DEPTH.to_string())
        .replace("{{MAX_SCHEMA_HOPS}}", &DECODER_MAX_SCHEMA_HOPS.to_string())
}

fn schema_to_ts(schema: &Value) -> String {
    if schema == &Value::Bool(true) {
        return "unknown".into();
    }
    if schema == &Value::Bool(false) {
        return "never".into();
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return reference.trim_start_matches("#/$defs/").to_owned();
    }
    if let Some(value) = schema.get("const") {
        return value.to_string();
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join(" | ");
    }
    for variant in ["oneOf", "anyOf"] {
        if let Some(items) = schema.get(variant).and_then(Value::as_array) {
            return items
                .iter()
                .map(schema_to_ts)
                .collect::<Vec<_>>()
                .join(" | ");
        }
    }
    if let Some(items) = schema.get("allOf").and_then(Value::as_array) {
        return items
            .iter()
            .map(schema_to_ts)
            .collect::<Vec<_>>()
            .join(" & ");
    }
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        return types
            .iter()
            .map(|kind| {
                let mut member = schema.clone();
                member["type"] = kind.clone();
                schema_to_ts(&member)
            })
            .collect::<Vec<_>>()
            .join(" | ");
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => "string".into(),
        Some("integer" | "number") => "number".into(),
        Some("boolean") => "boolean".into(),
        Some("null") => "null".into(),
        Some("array") => format!("({})[]", schema_to_ts(&schema["items"])),
        Some("object") => {
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let mut fields = Vec::new();
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (name, value) in properties {
                    let optional = if required.contains(&name.as_str()) {
                        ""
                    } else {
                        "?"
                    };
                    fields.push(format!(
                        "readonly {}{}: {}",
                        serde_json::to_string(name).unwrap_or_default(),
                        optional,
                        schema_to_ts(value)
                    ));
                }
            }
            if let Some(additional) = schema.get("additionalProperties") {
                if additional != &Value::Bool(false) {
                    fields.push(format!(
                        "readonly [key: string]: {}",
                        schema_to_ts(additional)
                    ));
                }
            }
            format!("{{ {} }}", fields.join("; "))
        }
        _ => "unknown".into(),
    }
}

fn request_type(schema: &Value) -> String {
    let Some(variants) = schema.get("oneOf").and_then(Value::as_array) else {
        return schema_to_ts(schema);
    };
    let mut members = Vec::new();
    for variant in variants {
        let mut properties = Map::new();
        if let Some(base) = schema.get("properties").and_then(Value::as_object) {
            properties.extend(base.clone());
        }
        if let Some(specific) = variant.get("properties").and_then(Value::as_object) {
            properties.extend(specific.clone());
        }
        let mut required = schema
            .get("required")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        required.extend(
            variant
                .get("required")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        members.push(schema_to_ts(
            &serde_json::json!({"type":"object", "properties": properties, "required": required}),
        ));
    }
    members.join(" | ")
}

pub fn generate() -> String {
    let schemas = serde_json::json!({
        "request": schema_for!(Request),
        "response": schema_for!(Response),
    });
    let mut definitions = BTreeMap::new();
    for root in ["request", "response"] {
        if let Some(items) = schemas[root]["$defs"].as_object() {
            for (name, schema) in items {
                definitions.insert(name, schema);
            }
        }
    }
    let mut output = format!("// Generated from workflow-model::protocol. Run scripts/generate-core-contracts.sh.\nexport const CORE_PROTOCOL_SCHEMA = {} as const;\n", schemas);
    output.push_str(&format!("export const CORE_PROTOCOL_VERSION = {PROTOCOL_VERSION};\nexport const CORE_MAX_FRAME_BYTES = {MAX_FRAME_BYTES};\nexport const CORE_MAX_RESPONSE_BYTES = {MAX_RESPONSE_BYTES};\nexport const CORE_MAX_DEPTH = {MAX_DEPTH_CEILING};\n"));
    for (name, schema) in definitions {
        output.push_str(&format!("export type {name} = {};\n", schema_to_ts(schema)));
    }
    output.push_str(&format!(
        "export type CoreRequest = {};\n",
        request_type(&schemas["request"])
    ));
    output.push_str(&format!(
        "export type CoreResponse = {};\n",
        schema_to_ts(&schemas["response"])
    ));
    output.push_str("export type CoreDomainError = DomainError;\nexport type CoreTransportError = TransportError;\nexport type CoreTransportKind = TransportErrorKind;\nexport type CoreResponseResult = ResponseResult;\n");
    output.push_str(&schema_decoder());
    output.push_str(include_str!("response-decoder.ts.txt"));
    output
}

/// Source-only descriptors for the authoring UI, generated from the compiler's model.
pub fn generate_source() -> String {
    let schema = serde_json::to_value(schema_for!(workflow_model::DefinitionBundle))
        .expect("source schema is JSON");
    let mut output = format!(
        "// Generated from workflow-model::DefinitionBundle. Run scripts/generate-core-contracts.sh.\nexport const SOURCE_SCHEMA = {schema} as const;\n"
    );
    if let Some(definitions) = schema["$defs"].as_object() {
        for (name, definition) in definitions {
            output.push_str(&format!(
                "export type {name} = {};\n",
                schema_to_ts(definition)
            ));
        }
    }
    output.push_str(&format!(
        "export type WorkflowDefinitionDescriptor = {};\n",
        schema_to_ts(&schema)
    ));
    output.push_str(&schema_decoder());
    output.push_str("export function decodeDefinitionBundle(value: unknown): WorkflowDefinitionDescriptor | null {\n  return hasSafeWireNumbers(value) && matchesProtocolSchema(value, SOURCE_SCHEMA, SOURCE_SCHEMA.$defs, 0)\n    ? value as WorkflowDefinitionDescriptor : null;\n}\n");
    output
}
