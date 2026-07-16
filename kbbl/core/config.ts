import { readFileSync } from "node:fs";

import { z } from "zod";

// === Schema ===
//
// Per-block schemas are .strict() so a typo at the leaf level (e.g.
// `t_quite_seconds`) fails at startup instead of silently looking like
// "the override isn't doing anything." Top-level schema is .strict() for
// the same reason. Defaults live on each leaf field, so an absent block
// or absent field both resolve to the documented default.

const CompactSchema = z
  .object({
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

// Per-session git worktree isolation is mandatory: every kbbl-spawned
// session runs in its own checkout + branch so concurrent sessions can't
// race on a shared cwd or contaminate the operator's toplevel branch.
// SessionManager rejects spawn when the workdir isn't a git repo.
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
    worktree_dir_name: z
      .string()
      .min(1, "worktree_dir_name cannot be empty")
      .refine(
        (s) =>
          s !== "." &&
          !s.includes("..") &&
          !s.includes("/") &&
          !s.includes("\\"),
        "worktree_dir_name must be a simple name (no '.', '/', '\\', or '..')",
      )
      .default("worktrees"),
    // Tools auto-approved from the start of every freshly created session, so
    // the operator isn't prompted for each one. Seeded onto the session's
    // allowlist at create() (persisted as tool_allowlisted events). Default is
    // read-only tools plus Bash; Edit/Write deliberately still prompt. Set to
    // [] to require approval for everything.
    default_allowlist: z
      .array(z.string().min(1))
      .default(["Read", "Glob", "Grep", "Bash"]),
  })
  .strict();

const CodexRuntimeSchema = z
  .object({
    enabled: z.boolean().default(false),
    bin: z.string().default("codex"),
    // null/absent means "derive from dataDir" (server.ts fills it in).
    // Non-null values must be one of the forms parseListenUrl accepts.
    listen: z
      .string()
      .refine(
        (s) =>
          s === "stdio://" ||
          s.startsWith("unix://") ||
          s.startsWith("ws://") ||
          s.startsWith("wss://"),
        'runtime.codex.listen must be "stdio://", "unix://<path>", "ws://<addr>", or "wss://<addr>"',
      )
      .nullable()
      .optional(),
  })
  .strict();

const RuntimeSchema = z
  .object({
    default: z.enum(["claude-code", "codex"]).default("claude-code"),
    codex: CodexRuntimeSchema.prefault({}),
  })
  .strict();

const DEFAULT_CONFIRM_SKILLS = [
  "mcp:gated-review:git.push",
  "mcp:gated-review:git.pull",
  "mcp:gated-review:open_pr",
];

const SkillsSchema = z
  .object({
    // Global skill-name denylist applied by filterSkillsForSession before the
    // list leaves core. Names (not ids) so the operator can hide a skill class
    // across all runtimes without knowing backend-specific id prefixes.
    hidden: z.array(z.string()).default([]),
    // When true, aggregate() returns FIXTURE_SKILLS instead of calling the
    // runtime. Lets cohort-3 frontend develop against real routes with no adapter.
    fixtures: z.boolean().default(false),
    // Skill-name allowlist for the tablet confirm gate (spec 3.4). Skills whose
    // name matches are annotated confirm=true by the registry. Mutating
    // gated-review MCP tools are gated by default because they affect remote PR
    // or git state from a compact rail button.
    confirm: z.array(z.string()).default(DEFAULT_CONFIRM_SKILLS),
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
    sessions: SessionsSchema.prefault({}),
    runtime: RuntimeSchema.prefault({}),
    skills: SkillsSchema.prefault({}),
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
