import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOptions, planImports, selectProjects, selectSourceQuery, toDraft, type SourceProject } from "../scripts/import-projects";
import type { ProjectDraft } from "../src/http/projects";

const script = resolve(import.meta.dir, "../scripts/import-projects.ts");
const scout: SourceProject = { name: "scout", repo_dir: "/repos/scout",
  forge_repository: { name: "scout", owner: "RankOneLabs", provider: "github" }, base_branch: "main" };
const jig: SourceProject = { name: "jig", repo_dir: "/repos/jig",
  forge_repository: { name: "jig", owner: "RankOneLabs", provider: "github" }, base_branch: "" };
const noOverrides = new Map<string, string>();

describe("options", () => {
  test("an import needs a target backend", () => {
    expect(parseOptions(["--only=scout"])).toMatchObject({ ok: false });
  });
  test("an override path may itself contain '='", () => {
    const parsed = parseOptions(["--to=http://127.0.0.1:8800/", "--repo-dir=scout=/tmp/a=b"]);
    expect(parsed).toMatchObject({ ok: true, value: { kind: "import", to: "http://127.0.0.1:8800" } });
    if (parsed.ok && parsed.value.kind === "import") expect(parsed.value.repo_dirs.get("scout")).toBe("/tmp/a=b");
  });
  test("an unknown flag is refused rather than ignored", () => {
    expect(parseOptions(["--to=http://x", "--dataDir=/x"])).toMatchObject({ ok: false });
  });
});

describe("source schema", () => {
  test("a v2 database is read from authority.project, its integration branch as base_branch", () => {
    const query = selectSourceQuery({ has_authority: true, has_legacy: true });
    expect(query).toMatchObject({ ok: true, value: expect.stringContaining("integration_branch AS base_branch FROM authority.project") });
  });
  test("a pre-v2 database is read from oakridge.project", () => {
    expect(selectSourceQuery({ has_authority: false, has_legacy: true })).toMatchObject({ ok: true, value: expect.stringContaining("FROM oakridge.project") });
  });
  test("a database with neither table is refused", () => {
    expect(selectSourceQuery({ has_authority: false, has_legacy: false })).toMatchObject({ ok: false });
  });
});

describe("selection", () => {
  test("--only keeps the named projects", () => {
    expect(selectProjects([scout, jig], ["jig"])).toEqual({ ok: true, value: [jig] });
  });
  test("--only refuses a name the source lacks", () => {
    expect(selectProjects([scout], ["scout", "nope"])).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
  });
});

describe("drafts", () => {
  test("base_branch carries over as integration_branch", () => {
    expect(toDraft(scout, noOverrides)).toMatchObject({ ok: true, value: { integration_branch: "main" } });
  });
  test("an empty base_branch becomes no integration branch", () => {
    expect(toDraft(jig, noOverrides)).toMatchObject({ ok: true, value: { integration_branch: null } });
  });
  test("a repo_dir override replaces the source checkout", () => {
    expect(toDraft(scout, new Map([["scout", "/shadow/scout"]]))).toMatchObject({ ok: true, value: { repo_dir: "/shadow/scout" } });
  });
  test("a row the backend would reject is refused before anything is written", () => {
    expect(toDraft({ ...scout, repo_dir: "relative/scout" }, noOverrides)).toMatchObject({ ok: false, error: expect.stringContaining("scout") });
  });
});

test("a project the target already names is skipped", () => {
  const drafts = [scout, jig].map((row) => (toDraft(row, noOverrides) as { value: ProjectDraft }).value);
  expect(planImports(drafts, new Set(["scout"])).map((planned) => planned.kind)).toEqual(["skip", "create"]);
});

describe("against a backend", () => {
  let directory: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("creates only the missing projects, and a rerun creates nothing", async () => {
    directory = mkdtempSync(join(tmpdir(), "import-projects-"));
    const source = join(directory, "projects.json");
    await Bun.write(source, JSON.stringify([scout, jig]));
    const saved: { name: string }[] = [{ name: "jig" }];
    const posted: unknown[] = [];
    server = Bun.serve({ port: 0, fetch: async (request) => {
      if (new URL(request.url).pathname !== "/api/projects") return new Response("missing", { status: 404 });
      if (request.method === "GET") return Response.json({ items: saved });
      const draft = await request.json() as { name: string };
      posted.push(draft);
      saved.push(draft);
      return Response.json({ id: crypto.randomUUID(), ...draft }, { status: 201 });
    } });
    // Spawned asynchronously: a synchronous child would block the stub's event loop.
    const run = () => Bun.spawn(["bun", script, `--from=${source}`, `--to=http://127.0.0.1:${server!.port}`],
      { env: { PATH: process.env.PATH }, stdout: "ignore" }).exited;

    expect(await run()).toBe(0);
    expect(posted).toEqual([{ name: "scout", repo_dir: "/repos/scout", integration_branch: "main",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" } }]);
    expect(await run()).toBe(0);
    expect(posted).toHaveLength(1);
  });
});
