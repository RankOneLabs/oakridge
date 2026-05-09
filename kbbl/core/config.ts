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

// Secret-bearing tokens are intentionally NOT in the schema. The kbbl→safir
// API bearer (`SAFIR_API_TOKEN`) and the shared webhook secret
// (`SAFIR_WEBHOOK_TOKEN`, same value on both processes) are read from
// process.env at the point of use in Phase 2/3, so a checked-in
// config.json can never carry a real credential. Strict-mode rejection
// also means an old config with `api_token`/`webhook_token` keys will
// fail loud at startup, prompting the operator to move them to env.
const SafirSchema = z
  .object({
    base_url: z.url().default("http://localhost:7145"),
    queue_drain_interval_seconds: z.number().positive().default(30),
  })
  .strict();

// Per-session git worktree isolation. Default-off in Phase 1 so existing
// operators see no behavioral change; flipped to true in Phase 3 once
// soak data is in. See comms/kbbl-session-worktrees-handoff.md.
//
// worktree_dir_name is a single dir-name component, NOT a path: it's
// joined onto dataDir to form `<dataDir>/<worktree_dir_name>`. Empty
// would resolve to dataDir itself (worktrees end up sitting alongside
// sessions/ — operator confusion + collisions on sid==filename) and
// any separator or `..` could escape the data dir entirely. Reject all
// of those at parse time so a misconfigured config.json fails loud at
// startup rather than producing surprising filesystem layout.
const SessionsSchema = z
  .object({
    worktree_per_session: z.boolean().default(false),
    worktree_dir_name: z
      .string()
      .min(1, "worktree_dir_name cannot be empty")
      .refine(
        (s) =>
          !s.includes("..") && !s.includes("/") && !s.includes("\\"),
        "worktree_dir_name must be a simple name (no '/', '\\', or '..')",
      )
      .default("worktrees"),
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
    sessions: SessionsSchema.prefault({}),
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
  // Read and parse stages live in separate try/catch blocks so each error
  // category gets its own `kbbl config: <path>:` prefix without inner
  // catches having to be careful about not re-wrapping. ENOENT on read
  // is the documented "no file" path; every other fs error (EACCES,
  // EISDIR, EIO) gets wrapped to keep startup error logs greppable.
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      const cfg = KbblConfigSchema.parse({});
      checkInvariants(cfg, path);
      return cfg;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`kbbl config: ${path}: failed to read file: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`kbbl config: ${path}: invalid JSON: ${msg}`);
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
