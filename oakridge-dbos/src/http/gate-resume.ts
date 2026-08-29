import { Hono } from "hono";

import { parseUuidId, type WaitId } from "../domain/primitives";
import type { RunRecordRepository } from "../storage/repositories";

export interface GateResumeDependencies {
  readonly records: Pick<RunRecordRepository, "decide_gate_wait">;
  readonly now?: () => string;
  readonly send_run_wake?: (run_id: string, idempotency_key: string) => Promise<void>;
}

interface GateResumeRequest {
  readonly action: string;
  readonly operator_comment: string;
  readonly feedback: string | null;
}

const parseRequest = (value: unknown): GateResumeRequest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (typeof body.action !== "string" || body.action.trim() === "") return null;
  if (typeof body.operator_comment !== "string" || body.operator_comment.trim() === "") return null;
  if (body.feedback !== undefined && body.feedback !== null && typeof body.feedback !== "string") return null;
  return { action: body.action.trim(), operator_comment: body.operator_comment.trim(),
    feedback: typeof body.feedback === "string" ? body.feedback.trim() || null : null };
};

export const createGateResumeApp = (dependencies: GateResumeDependencies): Hono => {
  const app = new Hono();
  app.post("/gates/:id/resume", async (http) => {
    const waitId = parseUuidId<WaitId>(http.req.param("id"));
    if (!waitId) return http.json({ error: "gate wait was not found" }, 404);
    const request = parseRequest(await http.req.json().catch(() => null));
    if (!request) return http.json({ error: "action and operator_comment are required strings" }, 400);
    const result = await dependencies.records.decide_gate_wait({ wait_id: waitId, action: request.action,
      actor: "operator", detail: request.feedback ?? request.operator_comment,
      decided_at: (dependencies.now ?? (() => new Date().toISOString()))() });
    if (result.kind === "wait_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
    await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
    return http.json({ gate_id: waitId, resumed: true }, 202);
  });
  return app;
};
