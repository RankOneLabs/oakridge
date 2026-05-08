import { readFileSync } from "node:fs";

import { z } from "zod";

// === Schema ===
//
// Per-block schemas are .strict() so a typo at the leaf level (e.g.
// `t_quite_seconds`) fails at startup instead of silently looking like
// "the override isn't doing anything." Top-level schema is .strict() for
// the same reason. Defaults live on each leaf field, so an absent block
// or absent field both resolve to the documented default.
//
// Phase 0 only stores the parsed config on SessionManager. Consumers
// (Phase 1 compactor, Phase 3 safir client, Phase 6 retention sweep)
// pull what they need from there. Per-task overrides land in Phase 4
// via permission_profiles.rules.compact_overrides; until then the
// global config here is the only source.

const CompactSchema = z
  .object({
    t_quiet_seconds: z.number().nonnegative().default(30),
    t_quiet_after_subagent_seconds: z.number().nonnegative().default(15),
    t_warm_seconds: z.number().positive().default(180),
    soft_threshold_tokens: z.number().int().positive().default(30000),
    hard_threshold_tokens: z.number().int().positive().default(70000),
    compact_call_timeout_seconds: z.number().positive().default(90),
    max_consecutive_failures_before_force: z
      .number()
      .int()
      .positive()
      .default(3),
  })
  .strict();

const RetentionSchema = z
  .object({
    session_events_full_days: z.number().int().positive().default(14),
  })
  .strict();

const SafirSchema = z
  .object({
    base_url: z.url().default("http://localhost:7145"),
    api_token: z.string().nullable().default(null),
    webhook_token: z.string().nullable().default(null),
    queue_drain_interval_seconds: z.number().positive().default(30),
  })
  .strict();

export const KbblConfigSchema = z
  .object({
    // .prefault({}) is the input-side default in Zod 4: when the key is
    // absent, the parser substitutes {} and the inner schema's per-field
    // defaults flow through. .default({}) wouldn't work here because in
    // Zod 4 .default takes the OUTPUT type, and {} is not a valid output
    // for these blocks (output has all defaulted keys present).
    compact: CompactSchema.prefault({}),
    retention: RetentionSchema.prefault({}),
    safir: SafirSchema.prefault({}),
  })
  .strict();

export type KbblConfig = z.infer<typeof KbblConfigSchema>;

// === Cross-field invariants ===
//
// Zod can't natively express "soft < hard" without either a refinement on
// the parent (which then loses access to the resolved values cleanly) or
// a post-parse check. Doing it post-parse keeps the schema simple and
// matches how loadConfig wants to surface errors anyway (one consolidated
// message with the file path).
function checkInvariants(cfg: KbblConfig, path: string): void {
  const { soft_threshold_tokens: soft, hard_threshold_tokens: hard } =
    cfg.compact;
  if (soft >= hard) {
    throw new Error(
      `kbbl config: ${path}: compact.soft_threshold_tokens (${soft}) must be < compact.hard_threshold_tokens (${hard})`,
    );
  }
}

// === Loader ===
//
// Missing file → all defaults (so a fresh checkout boots without an
// operator config step). Malformed JSON or schema validation failure →
// throw with the file path and a human-readable issue list, so the
// launcher can fail-fast at startup rather than running with a
// half-applied override.

export function loadConfig(path: string): KbblConfig {
  let parsed: unknown;
  try {
    const contents = readFileSync(path, "utf8");
    try {
      parsed = JSON.parse(contents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`kbbl config: ${path}: invalid JSON: ${msg}`);
    }
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      // No file = use schema defaults across the board. Still flow the
      // empty object through KbblConfigSchema so the same invariant
      // checks run on the resolved defaults.
      const cfg = KbblConfigSchema.parse({});
      checkInvariants(cfg, path);
      return cfg;
    }
    throw err;
  }
  const result = KbblConfigSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => {
        const where = i.path.length === 0 ? "<root>" : i.path.join(".");
        return `  - ${where}: ${i.message}`;
      })
      .join("\n");
    throw new Error(
      `kbbl config: ${path}: schema validation failed:\n${formatted}`,
    );
  }
  checkInvariants(result.data, path);
  return result.data;
}
