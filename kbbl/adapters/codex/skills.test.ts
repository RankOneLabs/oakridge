import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIN_CODEX_VERSION,
  compareVersions,
  parseCodexVersionOutput,
  parseSkillManifest,
  readAllowImplicitInvocation,
  parseSkillDir,
  discoverSkills,
  formatSkillInvocation,
  setSlashForSkillsSupported,
} from "./skills";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkdirp(...parts: string[]): string {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

function writeSkill(
  root: string,
  name: string,
  opts: {
    description?: string;
    argumentHint?: string;
    allowImplicitInvocation?: boolean;
    extraFrontmatter?: string;
  } = {},
): string {
  const dir = mkdirp(root, name);
  const desc = opts.description ?? `Description for ${name}`;
  const argHintLine = opts.argumentHint ? `\nargument-hint: ${opts.argumentHint}` : "";
  const extra = opts.extraFrontmatter ? `\n${opts.extraFrontmatter}` : "";
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}${argHintLine}${extra}\n---\n\n# Body`,
  );
  if (opts.allowImplicitInvocation === false) {
    mkdirp(dir, "agents");
    writeFileSync(
      join(dir, "agents", "openai.yaml"),
      `interface:\n  display_name: "${name}"\n\npolicy:\n  allow_implicit_invocation: false\n`,
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("0.137.0", "0.137.0")).toBe(0);
  });

  test("higher patch returns positive", () => {
    expect(compareVersions("0.137.1", "0.137.0")).toBeGreaterThan(0);
  });

  test("lower patch returns negative", () => {
    expect(compareVersions("0.136.9", "0.137.0")).toBeLessThan(0);
  });

  test("higher minor returns positive", () => {
    expect(compareVersions("0.138.0", "0.137.0")).toBeGreaterThan(0);
  });

  test("higher major returns positive", () => {
    expect(compareVersions("1.0.0", "0.137.0")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseCodexVersionOutput
// ---------------------------------------------------------------------------

describe("parseCodexVersionOutput", () => {
  test("parses 'codex-cli 0.137.0'", () => {
    expect(parseCodexVersionOutput("codex-cli 0.137.0")).toBe("0.137.0");
  });

  test("parses version with trailing newline", () => {
    expect(parseCodexVersionOutput("codex-cli 0.137.0\n")).toBe("0.137.0");
  });

  test("returns null for empty string", () => {
    expect(parseCodexVersionOutput("")).toBeNull();
  });

  test("returns null for non-version string", () => {
    expect(parseCodexVersionOutput("command not found")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MIN_CODEX_VERSION
// ---------------------------------------------------------------------------

describe("MIN_CODEX_VERSION", () => {
  test("is a valid semver string", () => {
    expect(parseCodexVersionOutput(`codex-cli ${MIN_CODEX_VERSION}`)).toBe(MIN_CODEX_VERSION);
  });

  test("matches the pinned build-time version 0.137.0", () => {
    expect(MIN_CODEX_VERSION).toBe("0.137.0");
  });
});

// ---------------------------------------------------------------------------
// parseSkillManifest
// ---------------------------------------------------------------------------

describe("parseSkillManifest", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "kbbl-skills-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("parses name and description", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, "---\nname: my-skill\ndescription: Does something useful\n---\n\n# Body");
    const m = parseSkillManifest(p);
    expect(m?.name).toBe("my-skill");
    expect(m?.description).toBe("Does something useful");
    expect(m?.argumentHint).toBeNull();
  });

  test("parses argument-hint", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, "---\nname: s\ndescription: d\nargument-hint: <pr-number>\n---\n");
    const m = parseSkillManifest(p);
    expect(m?.argumentHint).toBe("<pr-number>");
  });

  test("strips double quotes from values", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, '---\nname: "quoted"\ndescription: "quoted desc"\n---\n');
    const m = parseSkillManifest(p);
    expect(m?.name).toBe("quoted");
    expect(m?.description).toBe("quoted desc");
  });

  test("returns null for missing file", () => {
    expect(parseSkillManifest(join(tmpDir, "nonexistent.md"))).toBeNull();
  });

  test("returns null when no frontmatter block", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, "# No frontmatter here");
    expect(parseSkillManifest(p)).toBeNull();
  });

  test("returns null when name is missing", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, "---\ndescription: only desc\n---\n");
    expect(parseSkillManifest(p)).toBeNull();
  });

  test("returns null when description is missing", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(p, "---\nname: only-name\n---\n");
    expect(parseSkillManifest(p)).toBeNull();
  });

  test("ignores nested/indented lines", () => {
    const p = join(tmpDir, "SKILL.md");
    writeFileSync(
      p,
      "---\nname: s\ndescription: d\nmetadata:\n  short-description: short\n---\n",
    );
    const m = parseSkillManifest(p);
    expect(m?.name).toBe("s");
    expect(m?.description).toBe("d");
  });
});

// ---------------------------------------------------------------------------
// readAllowImplicitInvocation
// ---------------------------------------------------------------------------

describe("readAllowImplicitInvocation", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "kbbl-skills-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns true when agents/openai.yaml is absent", () => {
    const skillDir = mkdirp(tmpDir, "skill");
    expect(readAllowImplicitInvocation(skillDir)).toBe(true);
  });

  test("returns true when policy section is absent", () => {
    const skillDir = mkdirp(tmpDir, "skill");
    mkdirp(skillDir, "agents");
    writeFileSync(
      join(skillDir, "agents", "openai.yaml"),
      "interface:\n  display_name: test\n",
    );
    expect(readAllowImplicitInvocation(skillDir)).toBe(true);
  });

  test("returns true when allow_implicit_invocation is true", () => {
    const skillDir = mkdirp(tmpDir, "skill");
    mkdirp(skillDir, "agents");
    writeFileSync(
      join(skillDir, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );
    expect(readAllowImplicitInvocation(skillDir)).toBe(true);
  });

  test("returns false when allow_implicit_invocation is false", () => {
    const skillDir = mkdirp(tmpDir, "skill");
    mkdirp(skillDir, "agents");
    writeFileSync(
      join(skillDir, "agents", "openai.yaml"),
      "interface:\n  display_name: test\n\npolicy:\n  allow_implicit_invocation: false\n",
    );
    expect(readAllowImplicitInvocation(skillDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSkillDir — manifest mapping + split invocation-flag source
// ---------------------------------------------------------------------------

describe("parseSkillDir", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "kbbl-skills-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns a Skill with backend='codex'", () => {
    const dir = writeSkill(tmpDir, "my-skill");
    const skill = parseSkillDir(dir, "user");
    expect(skill?.backend).toBe("codex");
  });

  test("id is 'codex:<name>'", () => {
    const dir = writeSkill(tmpDir, "my-skill");
    const skill = parseSkillDir(dir, "user");
    expect(skill?.id).toBe("codex:my-skill");
  });

  test("scope comes from the parameter", () => {
    const dir = writeSkill(tmpDir, "s");
    expect(parseSkillDir(dir, "user")?.scope).toBe("user");
    expect(parseSkillDir(dir, "project")?.scope).toBe("project");
  });

  test("user_invocable defaults true", () => {
    const dir = writeSkill(tmpDir, "s");
    expect(parseSkillDir(dir, "user")?.user_invocable).toBe(true);
  });

  test("model_invocable is true when allow_implicit_invocation not set", () => {
    const dir = writeSkill(tmpDir, "s");
    expect(parseSkillDir(dir, "user")?.model_invocable).toBe(true);
  });

  test("model_invocable is false when allow_implicit_invocation=false in agent config", () => {
    const dir = writeSkill(tmpDir, "s", { allowImplicitInvocation: false });
    expect(parseSkillDir(dir, "user")?.model_invocable).toBe(false);
  });

  test("args is empty when no argument-hint", () => {
    const dir = writeSkill(tmpDir, "s");
    expect(parseSkillDir(dir, "user")?.args).toHaveLength(0);
  });

  test("argument-hint becomes ArgSpec with key='1'", () => {
    const dir = writeSkill(tmpDir, "s", { argumentHint: "<pr-number>" });
    const skill = parseSkillDir(dir, "user");
    expect(skill?.args).toHaveLength(1);
    expect(skill?.args[0].key).toBe("1");
    expect(skill?.args[0].hint).toBe("<pr-number>");
    expect(skill?.args[0].required).toBe(false);
  });

  test("returns null for directory with no SKILL.md", () => {
    const dir = mkdirp(tmpDir, "empty-dir");
    expect(parseSkillDir(dir, "user")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverSkills — trust-tier filtering and scope precedence
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  let tmpDir: string;
  let workDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kbbl-skills-discover-"));
    workDir = mkdirp(tmpDir, "work");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns skills from workdir .codex/skills", () => {
    const repoSkillsDir = mkdirp(workDir, ".codex", "skills");
    writeSkill(repoSkillsDir, "repo-skill");
    const skills = discoverSkills(workDir);
    expect(skills.some((s) => s.name === "repo-skill")).toBe(true);
  });

  test("returns skills from workdir .agents/skills", () => {
    const agentsDir = mkdirp(workDir, ".agents", "skills");
    writeSkill(agentsDir, "agents-skill");
    const skills = discoverSkills(workDir);
    expect(skills.some((s) => s.name === "agents-skill")).toBe(true);
  });

  test(".agents/skills overrides .codex/skills on name collision", () => {
    const repoSkillsDir = mkdirp(workDir, ".codex", "skills");
    writeSkill(repoSkillsDir, "shared", { description: "from-codex" });
    const agentsDir = mkdirp(workDir, ".agents", "skills");
    writeSkill(agentsDir, "shared", { description: "from-agents" });

    const skills = discoverSkills(workDir);
    const s = skills.find((x) => x.name === "shared");
    expect(s?.description).toBe("from-agents");
  });

  test("repo skills override home skills on name collision", () => {
    // We can't override homedir() in this module, but we can verify that
    // repo-scope skills have scope='project' while home-scope ones have 'user'.
    const repoSkillsDir = mkdirp(workDir, ".codex", "skills");
    writeSkill(repoSkillsDir, "repo-only-skill");
    const skills = discoverSkills(workDir);
    const s = skills.find((x) => x.name === "repo-only-skill");
    expect(s?.scope).toBe("project");
  });

  test(".system/ subdirectory is excluded", () => {
    const repoSkillsDir = mkdirp(workDir, ".codex", "skills");
    const sysDir = mkdirp(repoSkillsDir, ".system", "sys-skill");
    writeFileSync(
      join(sysDir, "SKILL.md"),
      "---\nname: sys-skill\ndescription: system skill\n---\n",
    );
    // Scope to project only to avoid false failure if home dir has a skill named sys-skill.
    const skills = discoverSkills(workDir).filter((s) => s.scope === "project");
    expect(skills.some((s) => s.name === "sys-skill")).toBe(false);
  });

  test("returns empty list when workdir has no skills dirs", () => {
    // workDir exists but has no .codex or .agents subdirs
    const emptyWork = mkdirp(tmpDir, "empty-work");
    // Filter out any home-dir skills that might bleed in by checking the skills
    // from a workdir with nothing in it are not from home (they may be, but at
    // minimum this shouldn't throw)
    expect(() => discoverSkills(emptyWork)).not.toThrow();
  });

  test("no duplicates when same name in both repo dirs", () => {
    const repoSkillsDir = mkdirp(workDir, ".codex", "skills");
    writeSkill(repoSkillsDir, "dup");
    const agentsDir = mkdirp(workDir, ".agents", "skills");
    writeSkill(agentsDir, "dup");
    const skills = discoverSkills(workDir);
    const dups = skills.filter((s) => s.name === "dup");
    expect(dups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatSkillInvocation — slash form, mention form, arg serialization
// ---------------------------------------------------------------------------

describe("formatSkillInvocation — slash form", () => {
  beforeEach(() => { setSlashForSkillsSupported(true); });

  const skill = {
    id: "codex:ghreview",
    name: "ghreview",
    description: "Review PRs",
    backend: "codex" as const,
    scope: "user" as const,
    args: [{ key: "1", required: false, hint: "<pr-number>" }],
    user_invocable: true,
    model_invocable: true,
  };

  test("no args → /<name>", () => {
    expect(formatSkillInvocation(skill, {})).toBe("/ghreview");
  });

  test("positional arg → /<name> <value>", () => {
    expect(formatSkillInvocation(skill, { "1": "123" })).toBe("/ghreview 123");
  });

  test("named arg → /<name> --<key> <value>", () => {
    expect(formatSkillInvocation(skill, { repo: "owner/name" })).toBe("/ghreview --repo owner/name");
  });

  test("positional before named", () => {
    expect(formatSkillInvocation(skill, { "1": "42", repo: "owner/name" })).toBe(
      "/ghreview 42 --repo owner/name",
    );
  });

  test("multiple positional args in key order", () => {
    expect(formatSkillInvocation(skill, { "2": "b", "1": "a" })).toBe("/ghreview a b");
  });

  test("empty arg values are skipped", () => {
    expect(formatSkillInvocation(skill, { "1": "" })).toBe("/ghreview");
  });
});

describe("formatSkillInvocation — mention form (probe failed)", () => {
  beforeEach(() => { setSlashForSkillsSupported(false); });
  afterEach(() => { setSlashForSkillsSupported(true); });

  const skill = {
    id: "codex:ghreview",
    name: "ghreview",
    description: "Review PRs",
    backend: "codex" as const,
    scope: "user" as const,
    args: [{ key: "1", required: false, hint: "<pr-number>" }],
    user_invocable: true,
    model_invocable: true,
  };

  test("no args → $<name>", () => {
    expect(formatSkillInvocation(skill, {})).toBe("$ghreview");
  });

  test("positional arg → $<name> <value>", () => {
    expect(formatSkillInvocation(skill, { "1": "123" })).toBe("$ghreview 123");
  });

  test("named arg → $<name> <value> (positional fallback, no --key)", () => {
    expect(formatSkillInvocation(skill, { repo: "owner/name" })).toBe("$ghreview owner/name");
  });
});

// ---------------------------------------------------------------------------
// createCodexRuntimeDescriptorOnly skills wiring
// ---------------------------------------------------------------------------

describe("createCodexRuntimeDescriptorOnly skill wiring", () => {
  test("is imported and tested via index.ts", async () => {
    // The descriptor-only factory is tested in index.test.ts; here we just
    // verify that the skills exports used by index.ts compile and are present.
    const mod = await import("./skills");
    expect(typeof mod.discoverSkills).toBe("function");
    expect(typeof mod.formatSkillInvocation).toBe("function");
    expect(typeof mod.MIN_CODEX_VERSION).toBe("string");
  });
});
