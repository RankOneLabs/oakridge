/** Why an operator request failed, and the HTTP status each reason maps to. */
export class MalformedRequestError { readonly kind = "malformed_request"; constructor(readonly detail: string) {} }
export class InvalidPayloadError { readonly kind = "invalid_payload"; constructor(readonly detail: string) {} }
export class MissingEntityError { readonly kind = "missing_entity"; constructor(readonly detail: string) {} }
export class ConflictError { readonly kind = "conflict"; constructor(readonly detail: string) {} }
export class InternalFaultError { readonly kind = "internal_fault"; readonly trace_id = crypto.randomUUID(); constructor(readonly detail: string) {} }
export type RequestError = MalformedRequestError | InvalidPayloadError | MissingEntityError | ConflictError | InternalFaultError;

export const REQUEST_ERROR_STATUS = {
  malformed_request: 400, invalid_payload: 422, missing_entity: 404, conflict: 409, internal_fault: 500,
} as const satisfies Readonly<Record<RequestError["kind"], 400 | 404 | 409 | 422 | 500>>;

/** An internal fault is logged by trace id and never echoes its detail to the caller. */
export function errorResponse(error: RequestError): Response {
  const body = error instanceof InternalFaultError ? { error: "internal fault", code: error.kind, trace_id: error.trace_id }
    : { error: error.detail, code: error.kind };
  if (error instanceof InternalFaultError) console.error(`internal fault ${error.trace_id}: ${error.detail}`);
  return Response.json(body, { status: REQUEST_ERROR_STATUS[error.kind] });
}
export const fault = (cause: unknown): Response => errorResponse(new InternalFaultError(String(cause)));

export async function requestBody(request: Request): Promise<unknown | MalformedRequestError> {
  try { return await request.json(); } catch { return new MalformedRequestError("invalid JSON"); }
}
