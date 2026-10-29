import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import type { LangfuseError } from "../ports/evaluation-backend";

const settingsSchema = z.object({
  base_url: z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  }),
  project_id: z.string().min(1),
  public_key: z.string().min(1),
  secret_key: z.string().min(1),
  annotation_queue_id: z.string().min(1).optional(),
  decision_evaluator_id: z.string().min(1).optional(),
  decision_model: z.string().min(1).optional(),
  phase_a_jev_score_name: z.string().min(1).optional(),
  max_attempts: z.coerce.number().int().min(1).max(5).default(3),
  backoff_ms: z.coerce.number().int().min(0).max(5_000).default(200),
});

export interface LangfuseCredential { readonly public_key: string; readonly secret_key: string }
export interface LangfuseConfig {
  readonly base_url: string;
  readonly project_id: string;
  readonly credential: LangfuseCredential;
  readonly annotation_queue_id: string | null;
  readonly decision_evaluator_id: string | null;
  readonly decision_model?: string | null;
  readonly phase_a_jev_score_name?: string | null;
  readonly retry: { readonly max_attempts: number; readonly backoff_ms: number };
}
export type LangfuseConfiguration =
  | { readonly status: "disabled" }
  | { readonly status: "enabled"; readonly config: LangfuseConfig };

/** Configuration errors name fields, never the supplied value or a credential. */
export function langfuseConfigFromEnv(env: NodeJS.ProcessEnv): Result<LangfuseConfiguration, LangfuseError> {
  const raw = {
    base_url: env.OBSERVATION_LANGFUSE_BASE_URL,
    project_id: env.OBSERVATION_LANGFUSE_PROJECT_ID,
    public_key: env.OBSERVATION_LANGFUSE_PUBLIC_KEY,
    secret_key: env.OBSERVATION_LANGFUSE_SECRET_KEY,
    annotation_queue_id: env.OBSERVATION_LANGFUSE_ANNOTATION_QUEUE_ID,
    decision_evaluator_id: env.OBSERVATION_LANGFUSE_DECISION_EVALUATOR_ID,
    decision_model: env.OBSERVATION_LANGFUSE_DECISION_MODEL,
    phase_a_jev_score_name: env.OBSERVATION_LANGFUSE_PHASE_A_JEV_SCORE_NAME,
    max_attempts: env.OBSERVATION_LANGFUSE_MAX_ATTEMPTS,
    backoff_ms: env.OBSERVATION_LANGFUSE_BACKOFF_MS,
  };
  if (!raw.base_url && !raw.project_id && !raw.public_key && !raw.secret_key && !raw.annotation_queue_id
    && !raw.decision_evaluator_id && !raw.decision_model && !raw.phase_a_jev_score_name)
    return ok({ status: "disabled" });
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return err({ operation: "langfuse_config", entity_id: "environment",
    detail: `Invalid Langfuse configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}` });
  return ok({ status: "enabled", config: {
    base_url: parsed.data.base_url.replace(/\/$/, ""), project_id: parsed.data.project_id,
    credential: { public_key: parsed.data.public_key, secret_key: parsed.data.secret_key },
    annotation_queue_id: parsed.data.annotation_queue_id ?? null,
    decision_evaluator_id: parsed.data.decision_evaluator_id ?? null,
    decision_model: parsed.data.decision_model ?? null,
    phase_a_jev_score_name: parsed.data.phase_a_jev_score_name ?? null,
    retry: { max_attempts: parsed.data.max_attempts, backoff_ms: parsed.data.backoff_ms },
  } });
}
