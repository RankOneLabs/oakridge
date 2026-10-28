export interface TracedError { readonly operation: string; readonly entity_id: string; readonly detail: string }
export interface CanonicalizationError extends TracedError { readonly operation: "canonical_json" }
export interface EnvelopeError extends TracedError { readonly operation: "decode_envelope" }
