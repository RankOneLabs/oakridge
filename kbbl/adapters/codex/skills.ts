// Codex skill discovery, manifest parsing, and invocation formatting.
//
// Discovery sources (in ascending scope precedence):
//   1. ~/.codex/skills                          — user scope
//   2. <workdir>/.codex/skills                  — project scope
//   3. <workdir>/.agents/skills                 — project scope (overrides above on name collision)
//
// Trust tiers: skills under <root>/.system/ are "system" tier; all other installed
// skills are "curated" tier. Experimental-tier detection (v1 note): Codex does not
// currently write a tier marker into locally-installed skill directories — curated and
// experimental skills share the same installation path. When Codex adds a tier marker
// (manifest field or directory suffix), this module should filter experimental skills
// out by default. Until then all non-.system skills are treated as curated and included.
//
// Invocation form: slash (`/<name> [args]`) is the primary form; mention (`$<name> [args]`)
// is the documented fallback. The probe at createCodexRuntime() init time checks whether
// the running Codex version supports slash-for-skills and records the result via
// setSlashForSkillsSupported(); formatSkillInvocation() selects the form from that record.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Skill, ArgSpec } from "../../core/skills/types";

// Pinned at build time from `codex --version` output: "codex-cli 0.137.0"
export const MIN_CODEX_VERSION = "0.137.0";

// Module-level slash-for-skills toggle, set at adapter init time.
let _slashForSkillsSupported = true;

/** Called once at createCodexRuntime() init, after the version probe. */
export function setSlashForSkillsSupported(supported: boolean): void {
  _slashForSkillsSupported = supported;
}

/**
 * Compare two semver strings. Returns negative/0/positive like Array.sort comparators.
 * Handles "major.minor.patch" only — sufficient for Codex version strings.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Parse the raw output of `codex --version` (e.g. "codex-cli 0.137.0") and
 * return the version string, or null if unparseable.
 */
export function parseCodexVersionOutput(raw: string): string | null {
  const match = raw.trim().match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/** Raw fields extracted from a SKILL.md YAML frontmatter block. */
interface SkillManifest {
  name: string;
  description: string;
  argumentHint: string | null;
}

/**
 * Parse a SKILL.md file, extracting YAML frontmatter fields.
 *
 * Expected format (YAML block delimited by --- lines):
 *   name: <string>
 *   description: <string>
 *   argument-hint: <string>  (optional)
 *
 * Returns null if the file is missing, malformed, or has no name/description.
 */
export function parseSkillManifest(skillMdPath: string): SkillManifest | null {
  let contents: string;
  try {
    contents = readFileSync(skillMdPath, "utf8");
  } catch {
    return null;
  }

  // Extract the YAML frontmatter block between the first two --- delimiters.
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const frontmatter = match[1];

  let name: string | null = null;
  let description: string | null = null;
  let argumentHint: string | null = null;

  for (const line of frontmatter.split(/\r?\n/)) {
    // Skip blank lines and lines that are indented (nested fields)
    if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // Value is everything after the first colon, stripped of leading/trailing whitespace and quotes.
    const rawVal = line.slice(colonIdx + 1).trim();
    const val = rawVal.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    if (key === "name") name = val || null;
    else if (key === "description") description = val || null;
    else if (key === "argument-hint") argumentHint = val || null;
  }

  if (!name || !description) return null;
  return { name, description, argumentHint };
}

// ---------------------------------------------------------------------------
// Agent config (agents/openai.yaml) parsing
// ---------------------------------------------------------------------------

/**
 * Read `agents/openai.yaml` from a skill directory and return whether
 * implicit invocation is allowed. Returns true (allowed) by default when the
 * file is absent or the field is not present.
 *
 * Per spec: `policy.allow_implicit_invocation: false` → model_invocable=false.
 */
export function readAllowImplicitInvocation(skillDir: string): boolean {
  const agentYamlPath = join(skillDir, "agents", "openai.yaml");
  let contents: string;
  try {
    contents = readFileSync(agentYamlPath, "utf8");
  } catch {
    return true;
  }

  let inPolicySection = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^policy\s*:/.test(line)) {
      inPolicySection = true;
      continue;
    }
    // A new top-level key ends the policy section
    if (inPolicySection && /^[a-z]/.test(line)) {
      inPolicySection = false;
    }
    if (inPolicySection) {
      const m = line.match(/^\s+allow_implicit_invocation\s*:\s*(true|false)/);
      if (m) return m[1] !== "false";
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Single skill directory → Skill model
// ---------------------------------------------------------------------------

/**
 * Parse one skill directory and return a Skill, or null if the directory has
 * no valid SKILL.md.
 *
 * @param skillDir  Absolute path to the skill directory (e.g. ~/.codex/skills/ghreview)
 * @param scope     "user" for home-dir skills, "project" for repo-local skills
 */
export function parseSkillDir(
  skillDir: string,
  scope: "user" | "project",
): Skill | null {
  const manifestPath = join(skillDir, "SKILL.md");
  const manifest = parseSkillManifest(manifestPath);
  if (!manifest) return null;

  const args: ArgSpec[] = [];
  if (manifest.argumentHint) {
    args.push({
      key: "1",
      required: false,
      hint: manifest.argumentHint,
    });
  }

  const modelInvocable = readAllowImplicitInvocation(skillDir);

  return {
    id: `codex:${manifest.name}`,
    name: manifest.name,
    description: manifest.description,
    backend: "codex",
    scope,
    args,
    user_invocable: true,
    model_invocable: modelInvocable,
  };
}

// ---------------------------------------------------------------------------
// Skills root scanning
// ---------------------------------------------------------------------------

/**
 * Scan a skills root directory and return all valid skills, keyed by name.
 * Skips:
 *  - The .system/ subdirectory (handled separately to allow tier labeling later)
 *  - Any entry that lacks a valid SKILL.md
 *
 * @param root   Absolute path to the skills directory (e.g. ~/.codex/skills)
 * @param scope  Scope to assign all skills found in this root
 */
function scanSkillsRoot(
  root: string,
  scope: "user" | "project",
): Map<string, Skill> {
  const result = new Map<string, Skill>();
  if (!existsSync(root)) return result;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return result;
  }

  for (const entry of entries) {
    // Skip .system and hidden directories (other than the skill dirs themselves)
    if (entry === ".system" || entry.startsWith(".")) continue;

    const skillDir = join(root, entry);
    const skill = parseSkillDir(skillDir, scope);
    if (skill) result.set(skill.name, skill);
  }

  return result;
}

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

/**
 * Discover all skills visible to a Codex session rooted at `workingDirectory`.
 *
 * Sources (later sources override earlier ones on name collision):
 *   1. ~/.codex/skills          (user scope)
 *   2. <workdir>/.codex/skills  (project scope)
 *   3. <workdir>/.agents/skills (project scope, highest precedence)
 *
 * System skills (`.system/` subdirs) are excluded: they are Codex-internal
 * and not meaningful on the kbbl one-tap rail.
 */
export function discoverSkills(workingDirectory: string): Skill[] {
  const homeSkillsRoot = join(homedir(), ".codex", "skills");
  const repoCodexRoot = join(workingDirectory, ".codex", "skills");
  const repoAgentsRoot = join(workingDirectory, ".agents", "skills");

  // Start with home skills, then overlay project skills in ascending precedence
  const merged = new Map<string, Skill>();

  for (const [name, skill] of scanSkillsRoot(homeSkillsRoot, "user")) {
    merged.set(name, skill);
  }
  for (const [name, skill] of scanSkillsRoot(repoCodexRoot, "project")) {
    merged.set(name, skill);
  }
  for (const [name, skill] of scanSkillsRoot(repoAgentsRoot, "project")) {
    merged.set(name, skill);
  }

  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// formatSkillInvocation
// ---------------------------------------------------------------------------

/**
 * Build the Codex-native invocation string for a skill.
 *
 * Slash form (primary, used when slash-for-skills probe passed):
 *   /<name>
 *   /<name> <positional1> <positional2>
 *   /<name> --<key> <value>  (named args)
 *
 * Mention form (fallback when probe failed):
 *   $<name>
 *   $<name> <positional1> <positional2>
 *
 * Positional args are keyed "1", "2", ... in ascending order.
 * Named args are any keys that are not numeric strings.
 * Both forms are pure and synchronous; the caller submits the result via send().
 */
export function formatSkillInvocation(
  skill: Skill,
  args: Record<string, string>,
): string {
  const prefix = _slashForSkillsSupported ? `/${skill.name}` : `$${skill.name}`;

  // Separate positional (numeric keys) from named (string keys)
  const positional: Array<[number, string]> = [];
  const named: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(args)) {
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) {
      positional.push([n, value]);
    } else {
      named.push([key, value]);
    }
  }

  positional.sort((a, b) => a[0] - b[0]);

  const parts: string[] = [prefix];

  for (const [, value] of positional) {
    if (value) parts.push(value);
  }

  if (_slashForSkillsSupported) {
    // Named args only make sense in slash form (Codex documented named-placeholder form)
    for (const [key, value] of named) {
      if (value) parts.push(`--${key}`, value);
    }
  } else {
    // In mention form, append named values positionally (best-effort)
    for (const [, value] of named) {
      if (value) parts.push(value);
    }
  }

  return parts.join(" ").trim();
}
