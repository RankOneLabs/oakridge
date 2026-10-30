import type { GradeRunner } from "../ports/grade-runner";
import { createSystemOneRunner, type JevDirectConfig } from "./jev-direct";
import { gradingLimits } from "../grading/jobs/budget";

export const FASTINO_SYSTEM_ONE_BASE_URL = "https://api.fastino.ai/v1";

/** Fastino is pinned independently by its own evaluator definition and model id. */
export function createFastinoGlideRunner(config: JevDirectConfig & { readonly auth_header?: "bearer" | "x-api-key" }): GradeRunner {
  return createSystemOneRunner({ operation: "fastino_glide", ...config,
    deadline_ms: config.deadline_ms ?? gradingLimits().provider_deadline_ms });
}
