import type { GradeRunner } from "../ports/grade-runner";
import { createSystemOneRunner, DEFAULT_PROVIDER_DEADLINE_MS, type JevDirectConfig } from "./jev-direct";

export const FASTINO_SYSTEM_ONE_BASE_URL = "https://api.fastino.ai/v1";

/** Fastino is pinned independently by its own evaluator definition and model id. */
export function createFastinoGlideRunner(config: JevDirectConfig & { readonly auth_header?: "bearer" | "x-api-key" }): GradeRunner {
  return createSystemOneRunner({ operation: "fastino_glide", ...config,
    deadline_ms: config.deadline_ms ?? DEFAULT_PROVIDER_DEADLINE_MS });
}
