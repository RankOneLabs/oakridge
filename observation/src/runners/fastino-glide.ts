import type { GradeRunner } from "../ports/grade-runner";
import { createSystemOneRunner, type SystemOneTransport } from "./jev-direct";

export const FASTINO_SYSTEM_ONE_BASE_URL = "https://api.fastino.ai/v1";

/** Fastino is pinned independently by its own evaluator definition and model id. */
export function createFastinoGlideRunner(api_key: string | undefined, transport?: SystemOneTransport,
  auth_header: "bearer" | "x-api-key" = "bearer"): GradeRunner {
  return createSystemOneRunner({ operation: "fastino_glide", base_url: "https://api.fastino.ai",
    api_key, auth_header, transport });
}
export const fastinoGlideRunner = createFastinoGlideRunner(process.env.FASTINO_API_KEY);
