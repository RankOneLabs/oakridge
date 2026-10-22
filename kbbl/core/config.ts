import { readFileSync } from "node:fs";

import { z } from "zod";

// === Schema ===
//
// Per-block schemas are .strict() so a typo at the leaf level (e.g.
// `t_quite_seconds`) fails at startup instead of silently looking like
// "the override isn't doing anything." Top-level schema is .strict() for
// the same reason. Defaults live on each leaf field, so an absent block
// or absent field both resolve to the documented default.

// Per-session git worktree isolation is mandatory: every kbbl-spawned
// session runs in its own checkout + branch so concurrent sessions can't
// race on a shared cwd or contaminate the operator's toplevel branch.
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

// ACP agent process configuration (migration spec §20). Each entry under
// acp.agents is a launch profile: which binary to run and how to shape its
// environment. env_policy exists for billing hardening — e.g. the Claude
// profile excludes ANTHROPIC_API_KEY so a stray key in kbbl's environment
// can never flip agent sessions to per-token API billing.
const AcpEnvPolicySchema = z
  .object({
    inherit: z.boolean().default(true),
    include: z.array(z.string().min(1)).nullable().optional(),
    // A name ending in `*` excludes every variable with that prefix.
    exclude: z.array(z.string().min(1)).default([]),
    set: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const AcpAgentSchema = z
  .object({
    enabled: z.boolean().default(true),
    label: z.string().min(1).nullable().optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env_policy: AcpEnvPolicySchema.prefault({}),
    // DBOS-managed sessions require session/load (guardrail 18); a profile
    // may opt out only for browser-only agents.
    require_load_session: z.boolean().default(true),
    // Value for the agent's `mode` config option applied to every new
    // session (e.g. "auto" for Claude Code). Null leaves the agent's own
    // settings default in place.
    session_mode: z.string().min(1).nullable().default(null),
  })
  .strict();

const AcpSchema = z
  .object({
    default_agent: z.string().min(1).default("claude-code"),
    agents: z.record(z.string().min(1), AcpAgentSchema).default({}),
    graceful_kill_ms: z.number().int().positive().default(3000),
    hard_kill_ms: z.number().int().positive().default(5000),
    idle_child_ttl_ms: z.number().int().positive().default(900000),
    live_event_buffer: z.number().int().positive().default(2000),
  })
  .strict();

export const KbblConfigSchema = z
  .object({
    // .prefault({}) is the input-side default in Zod 4: when the key is
    // absent, the parser substitutes {} and the inner schema's per-field
    // defaults flow through. .default({}) wouldn't work here because in
    // Zod 4 .default takes the OUTPUT type, and {} is not a valid output
    // for these blocks (output has all defaulted keys present).
    sessions: SessionsSchema.prefault({}),
    skills: SkillsSchema.prefault({}),
    acp: AcpSchema.prefault({}),
  })
  .strict();

export type KbblConfig = z.infer<typeof KbblConfigSchema>;

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
      return KbblConfigSchema.parse({});
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
  return result.data;
}
