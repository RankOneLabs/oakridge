import type { Context } from "hono";

export type ErrorStatus = 400 | 401 | 403 | 404 | 500;
export function errorResponse(c: Context, status: ErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}
