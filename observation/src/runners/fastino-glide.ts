import type { GradeRunner } from "../ports/grade-runner";
import { createSystemOneRunner, type SystemOneTransport } from "./jev-direct";
import { gradingLimits } from "../grading/jobs/budget";

export const FASTINO_SYSTEM_ONE_BASE_URL = "https://api.fastino.ai/v1";

/** Fastino is pinned independently by its own evaluator definition and model id. */
export function createFastinoGlideRunner(api_key: string | undefined, transport?: SystemOneTransport,
  auth_header: "bearer" | "x-api-key" = "bearer"): GradeRunner {
  return createSystemOneRunner({ operation: "fastino_glide", base_url: FASTINO_SYSTEM_ONE_BASE_URL,
    api_key, auth_header, deadline_ms: gradingLimits().provider_deadline_ms, transport });
}
export const fastinoGlideRunner = createFastinoGlideRunner(process.env.FASTINO_API_KEY);
