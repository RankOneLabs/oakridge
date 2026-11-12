import type { Context } from "hono";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;
/** Every refusal's body: a stable code and a message for a person. */
export interface ErrorBody { readonly error: { readonly code: string; readonly message: string } }
export function errorResponse(c: Context, status: ErrorStatus, code: string, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return c.json(body, status);
}
