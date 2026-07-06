import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

import type { Skill, ArgSpec } from "../../core/skills/types";

/**
 * Minimum CC version where the slash+frontmatter behavior this adapter
 * depends on is known-good. Captured from `claude --version` at build time.
 * A non-fatal warning is logged at startup when the running binary is older;
 * no hard failure, since the adapter already degrades gracefully.
 */
export const MIN_CC_VERSION = "2.1.183";

// ── frontmatter parsing ──────────────────────────────────────────────────────

interface FrontmatterResult {
  fm: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---")) {
    return { fm: {}, body: content };
  }
  // The closing fence must be `---` alone on its own line (followed by \n,
  // \r\n, or end-of-string). CRLF files need \r?\n on both sides; advancing
  // by the actual match length rather than a hardcoded +4 handles either EOL.
  const closeMatch = /\r?\n---(\r?\n|$)/.exec(content.slice(3));
  if (!closeMatch) {
    return { fm: {}, body: content };
  }
  const closeIdx = 3 + closeMatch.index;
  const fmText = content.slice(3, closeIdx).trim();
  const body = content.slice(closeIdx + closeMatch[0].length).trim();
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fmText);
    if (parsed && typeof parsed === "object") {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed YAML — fall back to empty frontmatter
  }
  return { fm, body };
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

// ── argument extraction ──────────────────────────────────────────────────────

function extractArgs(fm: Record<string, unknown>, body: string): ArgSpec[] {
  const hint = fm["argument-hint"];
  if (typeof hint === "string" && hint.trim()) {
    return hint
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

// ── normalization ────────────────────────────────────────────────────────────

function normalizeSkill(
  fm: Record<string, unknown>,
  body: string,
  fileBasename: string,
  scope: "project" | "user",
  source: "skills" | "commands",
): Skill {
  const name =
    typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : fileBasename;
  const description =
    typeof fm.description === "string" && fm.description.trim()
      ? fm.description.trim()
      : firstNonEmptyLine(body);
  const model_invocable = fm["disable-model-invocation"] !== true;
  const user_invocable = fm["user-invocable"] !== false;
  return {
    id: `cc:${scope}:${source}:${name}`,
    name,
    description,
    backend: "claude-code",
    scope,
    args: extractArgs(fm, body),
    user_invocable,
    model_invocable,
  };
}

// ── fs helpers ───────────────────────────────────────────────────────────────

async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// ── per-source discovery ─────────────────────────────────────────────────────

async function discoverFromSkillsDir(
  dir: string,
  scope: "project" | "user",
): Promise<Skill[]> {
  const entries = await listEntries(dir);
  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillMdPath = join(dir, entry, "SKILL.md");
    const content = await readFileText(skillMdPath);
    if (content === null) continue;
    const { fm, body } = parseFrontmatter(content);
    skills.push(normalizeSkill(fm, body, entry, scope, "skills"));
  }
  return skills;
}

async function discoverFromCommandsDir(
  dir: string,
  scope: "project" | "user",
): Promise<Skill[]> {
  const entries = await listEntries(dir);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    const content = await readFileText(filePath);
    if (content === null) continue;
    const fileBase = basename(entry, ".md");
    const { fm, body } = parseFrontmatter(content);
    skills.push(normalizeSkill(fm, body, fileBase, scope, "commands"));
  }
  return skills;
}

// ── installed plugins ────────────────────────────────────────────────────────

/**
 * Discover commands and skills contributed by installed CC plugins. The set of
 * installed plugins is read from ~/.claude/plugins/installed_plugins.json; each
 * record points at an installPath containing optional `commands/` and `skills/`
 * dirs in the same layout as the user/project sources.
 *
 * Marketplace catalog entries are intentionally NOT scanned — only plugins the
 * user has actually installed contribute rail buttons.
 */
async function discoverFromInstalledPlugins(home: string): Promise<Skill[]> {
  const jsonPath = join(home, ".claude", "plugins", "installed_plugins.json");
  const raw = await readFileText(jsonPath);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const plugins =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).plugins
      : null;
  if (!plugins || typeof plugins !== "object") return [];

  const skills: Skill[] = [];
  for (const [pluginKey, records] of Object.entries(
    plugins as Record<string, unknown>,
  )) {
    if (!Array.isArray(records)) continue;
    // Namespace IDs by plugin so a plugin command/skill can never collide with
    // (and overwrite, during id de-dup) a same-named local disk skill.
    const namespace = pluginKey.replace(/[^a-zA-Z0-9._-]/g, "_");
    for (const rec of records) {
      const installPath =
        rec && typeof rec === "object"
          ? (rec as Record<string, unknown>).installPath
          : null;
      if (typeof installPath !== "string") continue;
      const scope: "user" | "project" =
        (rec as Record<string, unknown>).scope === "project" ? "project" : "user";
      const [cmds, sks] = await Promise.all([
        discoverFromCommandsDir(join(installPath, "commands"), scope),
        discoverFromSkillsDir(join(installPath, "skills"), scope),
      ]);
      skills.push(
        ...cmds.map((s) => ({
          ...s,
          id: `cc:plugin:${namespace}:${s.scope}:commands:${s.name}`,
        })),
        ...sks.map((s) => ({
          ...s,
          id: `cc:plugin:${namespace}:${s.scope}:skills:${s.name}`,
        })),
      );
    }
  }
  return skills;
}

// ── built-in commands ────────────────────────────────────────────────────────

/**
 * Curated set of stable, user-invocable Claude Code built-in slash commands.
 *
 * Built-ins ship inside the CC binary — they are NOT on disk and CC exposes no
 * programmatic list of them (the interactive slash-command menu is unavailable
 * over kbbl's PTY transport, and is deliberately avoided regardless per cc issue
 * #43875). This list is therefore curated by hand: keep it to commands that are
 * stable across CC versions and safe as a one-tap rail action. Edit freely as
 * the built-in surface changes; an entry whose command no longer exists merely
 * produces a "no such command" error in-session when tapped — it does not break
 * discovery.
 */
const CC_BUILTIN_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  args?: ArgSpec[];
}> = [
  { name: "clear", description: "Clear the visible Claude Code conversation." },
  { name: "compact", description: "Compact the current Claude Code session context." },
  {
    name: "code-review",
    description: "Review the current diff for correctness bugs and cleanups.",
    args: [{ key: "1", required: false, hint: "effort (low|medium|high|max)" }],
  },
  { name: "simplify", description: "Clean up the changed code (reuse, simplification, efficiency)." },
  { name: "review", description: "Review a pull request." },
  { name: "security-review", description: "Security review of the pending changes on the branch." },
  { name: "init", description: "Initialize a CLAUDE.md with codebase documentation." },
];

const GATED_REVIEW_MCP_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "get_review_round", description: "Read PR review threads and comments." },
  { name: "reply_to_thread", description: "Reply to a PR review thread." },
  { name: "resolve_thread", description: "Resolve a handled PR review thread." },
  { name: "git_push", description: "Push through the gated-review MCP server." },
  { name: "git_pull", description: "Pull through the gated-review MCP server." },
  { name: "git_fetch", description: "Fetch through the gated-review MCP server." },
  {
    name: "open_pr",
    description: "Open a pull request through the gated-review MCP server.",
  },
];

function builtinSkills(): Skill[] {
  return CC_BUILTIN_COMMANDS.map((cmd) => ({
    id: `cc:builtin:${cmd.name}`,
    name: cmd.name,
    description: cmd.description,
    backend: "claude-code" as const,
    scope: "system" as const,
    args: cmd.args ?? [],
    user_invocable: true,
    model_invocable: false,
  }));
}

function gatedReviewMcpSkills(): Skill[] {
  return GATED_REVIEW_MCP_TOOLS.map((tool) => ({
    id: `cc:mcp:gated-review:${tool.name}`,
    name: `mcp:gated-review:${tool.name}`,
    description: tool.description,
    backend: "claude-code" as const,
    scope: "system" as const,
    args: [],
    user_invocable: true,
    model_invocable: true,
  }));
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Discover skills for the given session working directory. Sources, in order:
 * project .claude/skills, home .claude/skills, project .claude/commands, home
 * .claude/commands, installed-plugin commands/skills, then the curated CC
 * built-in commands. Never consults CC's advertised slash-command list (cc
 * issue #43875 hides disable-model-invocation skills from that list).
 *
 * A built-in is dropped only when an on-disk source (user/project skills or
 * commands) already provides a skill of the same name, so a user override always
 * wins. Installed-plugin skills do NOT suppress built-ins — plugins must never
 * silently mask stable core actions like `init`/`review`; their namespaced ids
 * let them coexist with a same-named built-in. Results are de-duplicated by id.
 */
export async function discoverSkills(
  workingDirectory: string,
  home: string = homedir(),
): Promise<Skill[]> {
  const [projectSkills, userSkills, projectCmds, userCmds, pluginSkills] =
    await Promise.all([
      discoverFromSkillsDir(join(workingDirectory, ".claude", "skills"), "project"),
      discoverFromSkillsDir(join(home, ".claude", "skills"), "user"),
      discoverFromCommandsDir(join(workingDirectory, ".claude", "commands"), "project"),
      discoverFromCommandsDir(join(home, ".claude", "commands"), "user"),
      discoverFromInstalledPlugins(home),
    ]);

  const onDisk = [...projectSkills, ...userSkills, ...projectCmds, ...userCmds];
  // Only on-disk skills suppress a curated built-in; plugins never do.
  const onDiskNames = new Set(onDisk.map((skill) => skill.name));
  const builtins = builtinSkills().filter((b) => !onDiskNames.has(b.name));

  const byId = new Map<string, Skill>();
  for (const skill of [
    ...onDisk,
    ...pluginSkills,
    ...builtins,
    // Pseudo-skills for the MCP server kbbl injects into every CC session.
    ...gatedReviewMcpSkills(),
  ]) {
    byId.set(skill.id, skill);
  }
  return [...byId.values()];
}

/**
 * Build the CC-native slash trigger for a skill invocation. Pure, synchronous,
 * and IO-free. Returns `/<name>` followed by positional arg values (ascending
 * numeric key order) then named arg values, space-joined. The caller passes
 * the returned string to send() via the existing channel-push seam.
 */
export function formatSkillInvocation(
  skill: Skill,
  args: Record<string, string>,
): string {
  if (skill.id.startsWith("cc:mcp:")) {
    const [, , serverName, toolName] = skill.id.split(":");
    return `Use the ${serverName} MCP tool ${toolName}.`;
  }

  const numericParts = Object.entries(args)
    .filter(([k]) => /^\d+$/.test(k))
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
    .map(([, v]) => v);
  const namedParts = Object.entries(args)
    .filter(([k]) => !/^\d+$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  const allParts = [...numericParts, ...namedParts].filter((v) => v.length > 0);
  return allParts.length > 0 ? `/${skill.name} ${allParts.join(" ")}` : `/${skill.name}`;
}
