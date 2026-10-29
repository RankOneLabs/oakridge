import { err, ok, type Result } from "../domain/primitives";
import type { GradingError } from "../grading/runner";
import { systemOneResponseSchema, type SystemOneTransport } from "../runners/jev-direct";

/** Settings to enter in Langfuse's TypeSafe (System One) Custom upstream connection. */
export interface FastinoCustomUpstream {
  readonly base_url: string;
  readonly model: string;
  readonly auth_method: "bearer" | "x-api-key";
  readonly extra_headers: Readonly<Record<string, string>>;
}
export function fastinoCustomUpstream(model: string, auth_method: "bearer" | "x-api-key"): FastinoCustomUpstream {
  return { base_url: "https://api.fastino.ai/v1", model, auth_method,
    extra_headers: { "Content-Type": "application/json" } };
}

export interface FastinoProbeResult {
  readonly bearer: "accepted" | "rejected";
  readonly x_api_key: "accepted" | "rejected";
  readonly accepted_model: string | null;
  readonly errors: readonly string[];
}

/** Synthetic provider probe. A Langfuse readback must separately verify native metadata preservation. */
export async function probeFastinoAuthentication(api_key: string, model: string,
  transport: SystemOneTransport = fetch): Promise<Result<FastinoProbeResult, GradingError>> {
  if (!api_key || !model) return err({ operation: "fastino_probe", entity_id: "fastino", detail: "credential and model required" });
  const request = { model, state: { probe: "A synthetic harmless sentence." },
    questions: { probe: { type: "choice", instructions: "Classify the sentence.",
      criteria: { harmless: "No harmful action requested", other: "A harmful action requested" } } } };
  const statuses: Record<"bearer" | "x-api-key", "accepted" | "rejected"> = { bearer: "rejected", "x-api-key": "rejected" };
  const errors: string[] = [];
  let accepted_model: string | null = null;
  for (const method of ["bearer", "x-api-key"] as const) {
    try {
      const response = await transport("https://api.fastino.ai/v1/systemone", { method: "POST",
        headers: { "Content-Type": "application/json",
          ...(method === "bearer" ? { Authorization: `Bearer ${api_key}` } : { "X-API-Key": api_key }) },
        body: JSON.stringify(request) });
      if (!response.ok) { errors.push(`${method}: HTTP ${response.status}`); continue; }
      const parsed = systemOneResponseSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.answers.probe) { errors.push(`${method}: invalid System One response`); continue; }
      statuses[method] = "accepted";
      accepted_model = parsed.data.model;
    } catch { errors.push(`${method}: transport failed`); }
  }
  return ok({ bearer: statuses.bearer, x_api_key: statuses["x-api-key"], accepted_model, errors });
}
