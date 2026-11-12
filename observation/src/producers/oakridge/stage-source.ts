import { z } from "zod";
import type { RunStageSource, WorkflowUnit } from "../../grading/task-stages";

/** A read of DBOS readiness, never a second workflow authority or a captured metadata write. */
const unitSchema = z.object({ unit_id: z.string(), stage: z.string().nullable(), depends_on: z.array(z.string()),
  status: z.object({ kind: z.enum(["not_started", "active", "done", "cancelled"]) }), artifacts: z.array(z.object({ artifact_key: z.string() })) });
export interface StageSourceOptions { readonly base_url: string; readonly token?: string; readonly fetch?: (url: string, init: RequestInit) => Promise<Response> }
export function createStageSource(options: StageSourceOptions): RunStageSource {
  return { async read(run_id) {
    const failure = (detail: string) => ({ ok: false as const, error: { operation: "read_run_stages" as const, entity_id: run_id, detail } });
    try {
      const response = await (options.fetch ?? fetch)(`${options.base_url.replace(/\/$/, "")}/api/runs/${encodeURIComponent(run_id)}/units`,
        { headers: options.token ? { authorization: `Bearer ${options.token}` } : {}, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return failure(`DBOS readiness returned HTTP ${response.status}`);
      const parsed = z.array(unitSchema).safeParse(await response.json());
      return parsed.success ? { ok: true, value: parsed.data as readonly WorkflowUnit[] } : failure("DBOS readiness has an invalid unit shape");
    } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  } };
}
