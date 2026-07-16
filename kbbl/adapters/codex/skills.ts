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
// is the documented fallback. The probe at createCodexRuntime() init time asks the running
// Codex app-server directly whether it serves the native skills API (the `skills/list`
// request) — a behavioral capability check, not a version-string guess (spec §7:
// "Probe the actual behavior of the running version ... verify, do not assume"). If the
// method is absent (JSON-RPC -32601 Method not found) the adapter falls back to the mention
// form. The pinned MIN_CODEX_VERSION is retained only as an informational signal logged
// alongside the probe. The probe result is captured PER RUNTIME: createCodexRuntime() builds
// its formatter via makeSkillInvocationFormatter(supported), so concurrent runtimes (or
// tests) never clobber a shared module global.
//
// Arguments: the native skills/list SkillMetadata carries NO argument spec, so SKILL.md is
// the only source of arg shape. Codex skills use the same conventions as Claude Code
// commands — an `argument-hint` frontmatter field and `$ARGUMENTS` / `$1..$9` placeholders in
// the body — so extractArgs() mirrors the claude-code adapter to keep the two backends at
// parity against the single normalized ArgSpec model.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Skill, ArgSpec } from "../../core/skills/types";
import {
  canonicalGatedReviewToolName,
  gatedReviewSkills,
  parseMcpSkillReference,
} from "../../core/skills/gated-review";

// Pinned at build time from `codex --version` output: "codex-cli 0.137.0"
export const MIN_CODEX_VERSION = "0.137.0";

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

/** JSON-RPC code for an unrecognized method. */
const METHOD_NOT_FOUND = -32601;
type SkillScope = Skill["scope"];

type CodexRequest = (method: string, params: unknown) => Promise<unknown>;

interface CodexSkillInterface {
  displayName?: unknown;
  shortDescription?: unknown;
}

interface CodexSkillMetadata {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  interface?: CodexSkillInterface | null;
  scope?: unknown;
  enabled?: unknown;
}

interface CodexSkillsListEntry {
  skills?: unknown;
}

interface CodexMcpTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
}

interface CodexMcpServerStatus {
  name?: unknown;
  tools?: unknown;
}

const CODEX_BUILTIN_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  args?: ArgSpec[];
}> = [
  { name: "clear", description: "Clear the visible Codex conversation." },
  { name: "compact", description: "Compact the current Codex session context." },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapCodexScope(scope: unknown): SkillScope {
  if (scope === "repo") return "project";
  if (scope === "system" || scope === "admin" || scope === "user") return scope;
  return "user";
}

/**
 * Behavioral probe: ask the running Codex app-server whether it serves the native
 * skills API by issuing a `skills/list` request. This verifies the actual capability
 * of the running build rather than inferring it from a version string (spec §7).
 *
 * Returns true (slash-for-skills supported) when the method responds at all — including
 * an application-level error that is NOT "method not found", since that still proves the
 * method exists. Returns false only when the server reports the method is unknown
 * (JSON-RPC -32601, or the standard "Method not found" message), in which case the caller
 * falls back to the mention form.
 *
 * @param request  A bound request function (typically client.request) returning a Promise.
 */
export async function probeSlashForSkillsSupported(
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<boolean> {
  try {
    await request("skills/list", { cwds: [] });
    return true;
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code === METHOD_NOT_FOUND) return false;
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("method not found") || message.includes("-32601")) {
      return false;
    }
    // The method exists but failed for another reason (e.g. transient); assume supported.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/** Raw fields extracted from a SKILL.md YAML frontmatter block, plus its body. */
interface SkillManifest {
  name: string;
  description: string;
  argumentHint: string | null;
  /** Markdown body following the frontmatter; scanned for $ARGUMENTS / $1..$9. */
  body: string;
}

/**
 * Parse a SKILL.md file, extracting YAML frontmatter fields and the body.
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
  // Everything after the closing --- fence is the body.
  const body = contents.slice(match.index! + match[0].length).trim();

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
  return { name, description, argumentHint, body };
}

// ---------------------------------------------------------------------------
// Argument extraction
// ---------------------------------------------------------------------------

/**
 * Map a Codex skill's argument conventions onto the normalized ArgSpec list.
 *
 * Precedence (mirrors the claude-code adapter so both backends behave identically):
 *   1. `argument-hint` frontmatter — split on whitespace into ordered positional
 *      ArgSpecs keyed "1","2",... with each token as the hint.
 *   2. `$ARGUMENTS` in the body — a single positional ArgSpec keyed "1".
 *   3. `$1..$9` in the body — N positional ArgSpecs up to the highest index seen.
 *   4. otherwise no args.
 *
 * Codex (like Claude Code) has no required-argument marker, so every ArgSpec is
 * required=false to avoid blocking dispatch on args the backend itself treats as optional.
 */
export function extractArgs(
  argumentHint: string | null,
  body: string,
): ArgSpec[] {
  if (argumentHint && argumentHint.trim()) {
    return argumentHint
      .trim()
      .split(/\s+/)
      .map((tok, i) => ({ key: String(i + 1), required: false, hint: tok }));
  }

  if (/\$ARGUMENTS/.test(body)) {
    return [{ key: "1", required: false, hint: "$ARGUMENTS" }];
  }

  const matches = body.match(/\$([1-9])/g);
  if (matches && matches.length > 0) {
    const maxN = matches.reduce(
      (acc, m) => Math.max(acc, parseInt(m.slice(1), 10)),
      0,
    );
    return Array.from({ length: maxN }, (_, i) => ({
      key: String(i + 1),
      required: false,
      hint: `$${i + 1}`,
    }));
  }

  return [];
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
    // A new top-level key ends the policy section (any non-indented, non-blank line)
    if (inPolicySection && /^\S/.test(line)) {
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

  const args = extractArgs(manifest.argumentHint, manifest.body);

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
    // Skip only the Codex-internal .system directory; dot-prefixed skill names are valid.
    if (entry === ".system") continue;

    const skillDir = join(root, entry);
    const skill = parseSkillDir(skillDir, scope);
    if (skill) result.set(skill.name, skill);
  }

  return result;
}

function builtinCommandSkills(): Skill[] {
  return CODEX_BUILTIN_COMMANDS.map((command) => ({
    id: `codex:builtin:${command.name}`,
    name: command.name,
    description: command.description,
    backend: "codex" as const,
    scope: "system" as const,
    args: command.args ?? [],
    user_invocable: true,
    model_invocable: false,
  }));
}

function gatedReviewMcpFallbackSkills(): Skill[] {
  return gatedReviewSkills("codex");
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
  // Built-in slash commands are not on disk; inject them without overriding
  // user/project skills of the same name.
  for (const skill of builtinCommandSkills()) {
    if (!merged.has(skill.name)) merged.set(skill.name, skill);
  }

  return [...merged.values()];
}

function normalizeNativeSkill(raw: unknown): Skill | null {
  const meta = asRecord(raw) as CodexSkillMetadata | null;
  if (meta === null || meta.enabled === false) return null;

  const name = stringValue(meta.name);
  if (name === null) return null;
  const iface = asRecord(meta.interface) as CodexSkillInterface | null;
  const description =
    stringValue(iface?.shortDescription) ??
    stringValue(meta.shortDescription) ??
    stringValue(meta.description) ??
    name;

  return {
    id: `codex:${name}`,
    name,
    description,
    backend: "codex",
    scope: mapCodexScope(meta.scope),
    args: [],
    user_invocable: true,
    model_invocable: true,
  };
}

export function parseNativeSkillsListResponse(response: unknown): Skill[] {
  const root = asRecord(response);
  const data = root?.data;
  if (!Array.isArray(data)) return [];

  const byId = new Map<string, Skill>();
  for (const rawEntry of data) {
    const entry = asRecord(rawEntry) as CodexSkillsListEntry | null;
    if (entry === null || !Array.isArray(entry.skills)) continue;
    for (const rawSkill of entry.skills) {
      const skill = normalizeNativeSkill(rawSkill);
      if (skill !== null) byId.set(skill.id, skill);
    }
  }
  return [...byId.values()];
}

export async function discoverNativeSkills(
  request: CodexRequest,
  workingDirectory: string,
): Promise<Skill[]> {
  const response = await request("skills/list", {
    cwds: [workingDirectory],
    forceReload: false,
  });
  return parseNativeSkillsListResponse(response);
}

function normalizeMcpTool(serverName: string, rawTool: unknown): Skill | null {
  const tool = asRecord(rawTool) as CodexMcpTool | null;
  if (tool === null) return null;
  const rawToolName = stringValue(tool.name);
  if (rawToolName === null) return null;
  const toolName =
    serverName === "gated-review"
      ? canonicalGatedReviewToolName(rawToolName)
      : rawToolName;
  const displayName = stringValue(tool.title) ?? toolName;
  const description =
    stringValue(tool.description) ??
    `Use the ${serverName} MCP tool ${toolName}.`;

  return {
    id: `codex:mcp:${serverName}:${toolName}`,
    name: `mcp:${serverName}:${displayName}`,
    description,
    backend: "codex",
    scope: "system",
    args: [],
    user_invocable: true,
    model_invocable: true,
  };
}

function normalizeMcpServerTools(rawServer: unknown): Skill[] {
  const server = asRecord(rawServer) as CodexMcpServerStatus | null;
  const serverName = stringValue(server?.name);
  const tools = asRecord(server?.tools);
  if (serverName === null || tools === null) return [];

  const skills: Skill[] = [];
  for (const [fallbackName, rawTool] of Object.entries(tools)) {
    const toolRecord = asRecord(rawTool);
    const normalized = normalizeMcpTool(serverName, {
      name: toolRecord?.name ?? fallbackName,
      title: toolRecord?.title,
      description: toolRecord?.description,
    });
    if (normalized !== null) skills.push(normalized);
  }
  return skills;
}

export function parseMcpServerStatusResponse(response: unknown): Skill[] {
  const root = asRecord(response);
  const data = root?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(normalizeMcpServerTools);
}

export async function discoverMcpToolSkills(
  request: CodexRequest,
  threadId: string | null,
): Promise<Skill[]> {
  const response = await request("mcpServerStatus/list", {
    detail: "toolsAndAuthOnly",
    threadId,
  });
  return parseMcpServerStatusResponse(response);
}

export function mergeCodexSkills({
  local,
  native,
  mcpTools,
}: {
  local: Skill[];
  native: Skill[];
  mcpTools: Skill[];
}): Skill[] {
  const localById = new Map(local.map((skill) => [skill.id, skill]));
  const merged = new Map<string, Skill>();

  for (const skill of local) merged.set(skill.id, skill);
  for (const skill of native) {
    const localSkill = localById.get(skill.id);
    merged.set(skill.id, {
      ...skill,
      args: localSkill?.args ?? skill.args,
      model_invocable: localSkill?.model_invocable ?? skill.model_invocable,
    });
  }
  const gatedReviewFallbacks = new Map(
    gatedReviewMcpFallbackSkills().map((skill) => [skill.id, skill]),
  );
  for (const skill of gatedReviewFallbacks.values()) merged.set(skill.id, skill);
  for (const skill of mcpTools) {
    const fallback = gatedReviewFallbacks.get(skill.id);
    merged.set(
      skill.id,
      fallback === undefined
        ? skill
        : { ...skill, name: fallback.name, args: fallback.args },
    );
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
 *
 * The slash-vs-mention capability is captured per runtime (via the closure) rather than
 * a module global, so multiple Codex runtimes cannot overwrite each other's probe result.
 *
 * @param slashForSkillsSupported  result of the init-time skills/list capability probe.
 */
export function makeSkillInvocationFormatter(
  slashForSkillsSupported: boolean,
): (skill: Skill, args: Record<string, string>) => string {
  return (skill: Skill, args: Record<string, string>): string => {
    if (parseMcpSkillReference(skill) !== null) {
      throw new Error("MCP tools must be invoked through the typed MCP route");
    }

    const isBuiltinCommand = skill.id.startsWith("codex:builtin:");
    const prefix =
      slashForSkillsSupported || isBuiltinCommand ? `/${skill.name}` : `$${skill.name}`;

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

    if (slashForSkillsSupported || isBuiltinCommand) {
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
  };
}
