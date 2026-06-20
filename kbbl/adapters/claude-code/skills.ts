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

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Discover skills from disk for the given session working directory. Sources,
 * in order: project .claude/skills, home .claude/skills, project .claude/commands,
 * home .claude/commands. Never consults CC's advertised slash-command list (cc
 * issue #43875 hides disable-model-invocation skills from that list).
 */
export async function discoverSkills(
  workingDirectory: string,
  home: string = homedir(),
): Promise<Skill[]> {
  const [projectSkills, userSkills, projectCmds, userCmds] = await Promise.all([
    discoverFromSkillsDir(join(workingDirectory, ".claude", "skills"), "project"),
    discoverFromSkillsDir(join(home, ".claude", "skills"), "user"),
    discoverFromCommandsDir(join(workingDirectory, ".claude", "commands"), "project"),
    discoverFromCommandsDir(join(home, ".claude", "commands"), "user"),
  ]);
  return [...projectSkills, ...userSkills, ...projectCmds, ...userCmds];
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
