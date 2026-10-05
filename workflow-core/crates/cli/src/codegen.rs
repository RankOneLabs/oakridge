use schemars::schema_for;
use workflow_model::protocol::{Request, Response};

pub fn generate() -> String {
    let schemas = serde_json::json!({
        "request": schema_for!(Request),
        "response": schema_for!(Response),
    });
    format!("// Generated from workflow-model::protocol. Run scripts/generate-core-contracts.sh.\n\
export const CORE_PROTOCOL_SCHEMA = {} as const;\n\
export type CoreTransportKind = 'malformed_frame' | 'unsupported_version' | 'oversized_payload' | 'unknown_operation' | 'terminated_child' | 'unresponsive_child' | 'mismatched_request_id';\n\
export interface CoreDomainError {{ readonly operation: string; readonly entity_id: string; readonly kind: string; readonly detail: string }}\n\
export interface CoreTransportError {{ readonly kind: CoreTransportKind; readonly detail: string }}\n\
export interface CoreRequest {{ readonly version: number; readonly request_id: string; readonly operation: 'compile' | 'validate_payload' | 'evaluate' | 'materialize' | 'explain'; readonly input: unknown }}\n\
export type CoreResponseResult = {{ readonly status: 'ok'; readonly value: unknown }} | {{ readonly status: 'domain_error'; readonly value: CoreDomainError }} | {{ readonly status: 'transport_error'; readonly value: CoreTransportError }};\n\
export interface CoreResponse {{ readonly version: number; readonly request_id: string; readonly truncated: boolean; readonly result: CoreResponseResult }}\n", schemas)
}
