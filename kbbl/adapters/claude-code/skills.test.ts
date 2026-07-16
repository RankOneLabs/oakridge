import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills, formatSkillInvocation, MIN_CC_VERSION } from "./skills";
import type { Skill } from "../../core/skills/types";

let tmpRoot: string;

function makeHome(): string {
  const home = join(tmpRoot, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function makeWorkdir(): string {
  const wd = join(tmpRoot, "project");
  mkdirSync(wd, { recursive: true });
  return wd;
}

function writeSkillMd(dir: string, name: string, content: string): void {
  const skillDir = join(dir, ".claude", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

function writeCommandMd(dir: string, name: string, content: string): void {
  const cmdDir = join(dir, ".claude", "commands");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, `${name}.md`), content);
}

/**
 * discoverSkills always appends curated CC system skills. Disk-source tests
 * assert on disk discovery only, so they filter those out first.
 */
function diskOnly(skills: Skill[]): Skill[] {
  return skills.filter(
    (s) => !s.id.startsWith("cc:builtin:") && !s.id.startsWith("cc:mcp:"),
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-skills-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── MIN_CC_VERSION ───────────────────────────────────────────────────────────

describe("MIN_CC_VERSION", () => {
  test("is a non-empty semver-like string", () => {
    expect(typeof MIN_CC_VERSION).toBe("string");
    expect(MIN_CC_VERSION.length).toBeGreaterThan(0);
    expect(MIN_CC_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ── frontmatter mapping ──────────────────────────────────────────────────────

describe("discoverSkills — frontmatter mapping", () => {
  test("full frontmatter: name + description override basename + body", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "my-skill",
      `---
name: overridden-name
description: Explicit description
disable-model-invocation: false
user-invocable: true
---
Body text ignored when description present.`,
    );

    const skills = diskOnly(await discoverSkills(wd, home));
    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.name).toBe("overridden-name");
    expect(s.description).toBe("Explicit description");
    expect(s.model_invocable).toBe(true);
    expect(s.user_invocable).toBe(true);
    expect(s.backend).toBe("claude-code");
    expect(s.scope).toBe("project");
    expect(s.id).toBe("cc:project:skills:overridden-name");
  });

  test("no frontmatter name → falls back to directory basename", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "dir-basename", `---\ndescription: A skill\n---\nBody.`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.name).toBe("dir-basename");
  });

  test("no frontmatter description → uses first non-empty body line", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "body-desc",
      `---\nname: body-desc\n---\n\n  First real line\nSecond line`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.description).toBe("First real line");
  });

  test("disable-model-invocation: true → model_invocable=false", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "hidden-skill",
      `---\nname: hidden-skill\ndisable-model-invocation: true\n---\nBody.`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.model_invocable).toBe(false);
    expect(skills[0]!.user_invocable).toBe(true);
  });

  test("user-invocable: false → user_invocable=false", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "agent-only",
      `---\nname: agent-only\nuser-invocable: false\n---\nBody.`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.user_invocable).toBe(false);
    expect(skills[0]!.model_invocable).toBe(true);
  });

  test("defaults: model_invocable=true, user_invocable=true when keys absent", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "plain", `---\nname: plain\ndescription: A plain skill\n---\nBody.`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.model_invocable).toBe(true);
    expect(skills[0]!.user_invocable).toBe(true);
  });

  test("no frontmatter at all → basename + body-first-line + defaults", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "raw-cmd", `Just a description on the first line.\nMore content.`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.name).toBe("raw-cmd");
    expect(skills[0]!.description).toBe("Just a description on the first line.");
    expect(skills[0]!.model_invocable).toBe(true);
  });

  test("allowed-tools is parsed but does not appear on the Skill model", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "restricted",
      `---\nname: restricted\ndescription: Restricted\nallowed-tools:\n  - Read\n  - Write\n---\nBody.`,
    );

    const skills = await discoverSkills(wd, home);
    const s = skills[0]!;
    expect(s).not.toHaveProperty("allowed_tools");
    expect(s).not.toHaveProperty("allowed-tools");
  });
});

// ── #43875 disk-read path ────────────────────────────────────────────────────

describe("discoverSkills — #43875 disk-read path (never queries CC advertised list)", () => {
  test("discovers skills from all four sources simultaneously", async () => {
    const wd = makeWorkdir();
    const home = makeHome();

    writeSkillMd(wd, "proj-skill", `---\nname: proj-skill\ndescription: Project skill\n---`);
    writeSkillMd(home, "user-skill", `---\nname: user-skill\ndescription: User skill\n---`);
    writeCommandMd(wd, "proj-cmd", `---\nname: proj-cmd\ndescription: Project command\n---`);
    writeCommandMd(home, "user-cmd", `---\nname: user-cmd\ndescription: User command\n---`);

    const skills = diskOnly(await discoverSkills(wd, home));
    expect(skills).toHaveLength(4);

    const ids = skills.map((s) => s.id);
    expect(ids).toContain("cc:project:skills:proj-skill");
    expect(ids).toContain("cc:user:skills:user-skill");
    expect(ids).toContain("cc:project:commands:proj-cmd");
    expect(ids).toContain("cc:user:commands:user-cmd");
  });

  test("project-sourced skill has scope=project", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "ps", `---\nname: ps\ndescription: d\n---`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.scope).toBe("project");
  });

  test("home-sourced skill has scope=user", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(home, "us", `---\nname: us\ndescription: d\n---`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.scope).toBe("user");
  });

  test("skill directory without SKILL.md is silently skipped", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    // Create a dir in .claude/skills but without SKILL.md
    mkdirSync(join(wd, ".claude", "skills", "orphan"), { recursive: true });
    writeFileSync(join(wd, ".claude", "skills", "orphan", "README.md"), "nothing");

    const skills = diskOnly(await discoverSkills(wd, home));
    expect(skills).toHaveLength(0);
  });

  test("non-.md file in commands dir is skipped", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    const cmdDir = join(wd, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "script.sh"), "#!/bin/bash");

    const skills = diskOnly(await discoverSkills(wd, home));
    expect(skills).toHaveLength(0);
  });

  test("missing .claude dirs return empty list without throwing", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    // No .claude dirs created
    const skills = diskOnly(await discoverSkills(wd, home));
    expect(skills).toHaveLength(0);
  });

  test("legacy commands directory maps to source=commands in id", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeCommandMd(wd, "review", `---\nname: review\ndescription: Run review\n---`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.id).toBe("cc:project:commands:review");
  });
});

// ── built-in commands + installed plugins ────────────────────────────────────

describe("discoverSkills — built-in CC commands", () => {
  test("curated built-ins are always surfaced even with no disk skills", async () => {
    const wd = makeWorkdir();
    const home = makeHome();

    const skills = await discoverSkills(wd, home);
    const builtins = skills.filter((s) => s.id.startsWith("cc:builtin:"));
    expect(builtins.length).toBeGreaterThan(0);
    const names = builtins.map((s) => s.name);
    expect(names).toContain("clear");
    expect(names).toContain("compact");
    expect(names).toContain("code-review");
    const cr = builtins.find((s) => s.name === "code-review");
    expect(cr).toBeDefined();
    if (!cr) return;
    expect(cr.backend).toBe("claude-code");
    expect(cr.scope).toBe("system");
    expect(cr.user_invocable).toBe(true);
  });

  test("a disk skill of the same name overrides (suppresses) the built-in", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "code-review", `---\nname: code-review\ndescription: custom\n---`);

    const skills = await discoverSkills(wd, home);
    const codeReviews = skills.filter((s) => s.name === "code-review");
    expect(codeReviews).toHaveLength(1);
    expect(codeReviews[0]!.id).toBe("cc:project:skills:code-review");
  });

  test("an installed plugin does NOT suppress a same-named built-in", async () => {
    const wd = makeWorkdir();
    const home = makeHome();

    // Plugin ships a command named "review" — must not mask the core built-in.
    const installPath = join(tmpRoot, "plugin-install");
    mkdirSync(join(installPath, "commands"), { recursive: true });
    writeFileSync(
      join(installPath, "commands", "review.md"),
      `---\nname: review\ndescription: plugin review\n---`,
    );
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo@market": [{ scope: "user", installPath }] },
      }),
    );

    const skills = await discoverSkills(wd, home);
    const ids = skills.filter((s) => s.name === "review").map((s) => s.id);
    // Built-in survives alongside the plugin command.
    expect(ids).toContain("cc:builtin:review");
    expect(ids).toContain("cc:plugin:demo_market:user:commands:review");
  });
});

describe("discoverSkills — gated-review MCP tools", () => {
  test("surfaces curated gated-review tools as system skills", async () => {
    const wd = makeWorkdir();
    const home = makeHome();

    const skills = await discoverSkills(wd, home);
    const names = skills
      .filter((s) => s.id.startsWith("cc:mcp:gated-review:"))
      .map((s) => s.name);

    expect(names).toContain("mcp:gated-review:get_review_round");
    expect(names).toContain("mcp:gated-review:reply_to_thread");
    expect(names).toContain("mcp:gated-review:resolve_thread");
    expect(names).toContain("mcp:gated-review:git.push");
    expect(names).toContain("mcp:gated-review:open_pr");
  });
});

describe("discoverSkills — installed plugins", () => {
  test("discovers commands and skills from an installed plugin's installPath", async () => {
    const wd = makeWorkdir();
    const home = makeHome();

    const installPath = join(tmpRoot, "plugin-install");
    mkdirSync(join(installPath, "commands"), { recursive: true });
    writeFileSync(
      join(installPath, "commands", "plug-cmd.md"),
      `---\nname: plug-cmd\ndescription: A plugin command\n---`,
    );
    const skillDir = join(installPath, "skills", "plug-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: plug-skill\ndescription: A plugin skill\n---`,
    );

    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo@market": [{ scope: "user", installPath }] },
      }),
    );

    const skills = await discoverSkills(wd, home);
    const names = skills.map((s) => s.name);
    expect(names).toContain("plug-cmd");
    expect(names).toContain("plug-skill");
    // Plugin IDs are namespaced so they can't collide with disk-source IDs.
    const plugCmd = skills.find((s) => s.name === "plug-cmd");
    expect(plugCmd).toBeDefined();
    if (!plugCmd) return;
    expect(plugCmd.id).toBe("cc:plugin:demo_market:user:commands:plug-cmd");
  });

  test("a plugin skill does not overwrite a same-named disk skill", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    // Disk command named "review" at project scope.
    writeCommandMd(wd, "review", `---\nname: review\ndescription: disk review\n---`);

    // Plugin also ships a "review" command.
    const installPath = join(tmpRoot, "plugin-install");
    mkdirSync(join(installPath, "commands"), { recursive: true });
    writeFileSync(
      join(installPath, "commands", "review.md"),
      `---\nname: review\ndescription: plugin review\n---`,
    );
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo@market": [{ scope: "user", installPath }] },
      }),
    );

    const skills = await discoverSkills(wd, home);
    const reviews = skills.filter((s) => s.name === "review");
    // Both survive as distinct entries — the disk skill is not overwritten.
    expect(reviews).toHaveLength(2);
    const ids = reviews.map((s) => s.id);
    expect(ids).toContain("cc:project:commands:review");
    expect(ids).toContain("cc:plugin:demo_market:user:commands:review");
  });

  test("missing installed_plugins.json is tolerated", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    // No plugins dir at all — should not throw, just contribute nothing.
    const skills = await discoverSkills(wd, home);
    expect(skills.some((s) => s.id.startsWith("cc:builtin:"))).toBe(true);
  });
});

// ── argument extraction ──────────────────────────────────────────────────────

describe("discoverSkills — argument extraction", () => {
  test("argument-hint splits into positional ArgSpecs", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "hint-skill",
      `---\nname: hint-skill\ndescription: d\nargument-hint: <target> <branch>\n---\nBody.`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.args).toEqual([
      { key: "1", required: false, hint: "<target>" },
      { key: "2", required: false, hint: "<branch>" },
    ]);
  });

  test("$ARGUMENTS in body → single ArgSpec with key=1", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "args-skill",
      `---\nname: args-skill\ndescription: d\n---\nDo something with $ARGUMENTS.`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.args).toEqual([{ key: "1", required: false, hint: "$ARGUMENTS" }]);
  });

  test("$1..$3 in body → 3 positional ArgSpecs", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "pos-skill",
      `---\nname: pos-skill\ndescription: d\n---\nRun $1 on $2 for $3 iterations.`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.args).toEqual([
      { key: "1", required: false, hint: "$1" },
      { key: "2", required: false, hint: "$2" },
      { key: "3", required: false, hint: "$3" },
    ]);
  });

  test("no $ARGUMENTS or $N in body → empty args", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(wd, "no-args", `---\nname: no-args\ndescription: d\n---\nNo placeholders here.`);

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.args).toEqual([]);
  });

  test("all ArgSpecs have required=false regardless of hint", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "req-check",
      `---\nname: req-check\ndescription: d\nargument-hint: <required!>\n---`,
    );

    const skills = await discoverSkills(wd, home);
    expect(skills[0]!.args.every((a) => a.required === false)).toBe(true);
  });

  test("argument-hint takes precedence over $ARGUMENTS in body", async () => {
    const wd = makeWorkdir();
    const home = makeHome();
    writeSkillMd(
      wd,
      "hint-wins",
      `---\nname: hint-wins\ndescription: d\nargument-hint: <one> <two>\n---\nUses $ARGUMENTS.`,
    );

    const skills = await discoverSkills(wd, home);
    // argument-hint wins; should produce 2 args, not 1 from $ARGUMENTS
    expect(skills[0]!.args).toHaveLength(2);
    expect(skills[0]!.args[0]!.hint).toBe("<one>");
  });
});

// ── slash serialization ──────────────────────────────────────────────────────

describe("formatSkillInvocation — slash serialization", () => {
  const baseSkill: Skill = {
    id: "cc:project:skills:foo",
    name: "foo",
    description: "d",
    backend: "claude-code",
    scope: "project",
    args: [],
    user_invocable: true,
    model_invocable: true,
  };

  test("no args → /<name>", () => {
    expect(formatSkillInvocation(baseSkill, {})).toBe("/foo");
  });

  test("positional args in ascending key order", () => {
    expect(formatSkillInvocation(baseSkill, { "2": "b", "1": "a" })).toBe("/foo a b");
  });

  test("named args appended after positional", () => {
    const result = formatSkillInvocation(baseSkill, { "1": "pos", flag: "named" });
    expect(result).toBe("/foo pos named");
  });

  test("empty string arg values are omitted", () => {
    expect(formatSkillInvocation(baseSkill, { "1": "", "2": "val" })).toBe("/foo val");
  });

  test("no positional keys, only named → /name named_val", () => {
    expect(formatSkillInvocation(baseSkill, { flag: "x" })).toBe("/foo x");
  });

  test("skill name is used from skill.name, not skill.id", () => {
    const s: Skill = { ...baseSkill, name: "custom-name" };
    expect(formatSkillInvocation(s, {})).toBe("/custom-name");
  });

  test("MCP tool skills cannot fall back to a text steering prompt", () => {
    const s: Skill = {
      ...baseSkill,
      id: "cc:mcp:gated-review:get_review_round",
      name: "mcp:gated-review:get_review_round",
    };
    expect(() => formatSkillInvocation(s, {})).toThrow(/typed MCP route/);
  });

  test("is pure — same inputs produce same output", () => {
    const args = { "1": "a", "2": "b" };
    expect(formatSkillInvocation(baseSkill, args)).toBe(
      formatSkillInvocation(baseSkill, args),
    );
  });
});
