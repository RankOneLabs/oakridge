import { expect, test } from "bun:test";
import { withDatabase } from "./effect-fixture";
import { developmentBundle, runtimeFixture, brief, repository } from "./development-runtime-fixture";
import { importProjects } from "../scripts/import-projects";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

test("all seven operator read models are reachable in generated PWA contracts", () => {
  const contracts = readFileSync(resolve(import.meta.dir, "../../kbbl/core/pwa/oakridge/operator-contracts.ts"), "utf8");
  for (const name of ["RunSummary", "RunDetail", "RunSessionAttempt", "SessionLocation", "ArtifactDetail", "Decision", "ReviewInbox"])
    expect(contracts).toMatch(new RegExp(`export (?:interface|type) Operator${name}\\b`));
});

test("PWA read-model fixtures are constructed only in the shared factory", () => {
  const root = resolve(import.meta.dir, "../../kbbl/core/pwa");
  const models = new Set(["OperatorRunSummary", "OperatorRunDetail", "OperatorRunSessionAttempt", "OperatorSessionLocation",
    "OperatorArtifactDetail", "OperatorDecision", "OperatorReviewInbox"]);
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : /\.(?:test|spec)\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []);
  for (const file of files(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)
        && node.type && ts.isTypeReferenceNode(node.type) && models.has(node.type.typeName.getText(source)))
        throw new Error(`${file}: construct ${node.type.typeName.getText(source)} with __fixtures__/read-models.ts`);
      if ((ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) && ts.isObjectLiteralExpression(node.expression)
        && ts.isTypeReferenceNode(node.type) && models.has(node.type.typeName.getText(source)))
        throw new Error(`${file}: construct ${node.type.typeName.getText(source)} with __fixtures__/read-models.ts`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const project = { name: "oakridge", repo_dir: "/home/steve/codes/rol/oakridge", forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" }, integration_branch: "main" };

test("projects are created, listed and edited, with names kept unique", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const created = await f.app.request("/api/projects", json("POST", project));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await f.app.request("/api/projects", json("POST", project))).status).toBe(409);
    expect((await f.app.request("/api/projects", json("POST", { ...project, name: "relative", repo_dir: "codes/x" }))).status).toBe(422);
    const edited = await f.app.request(`/api/projects/${id}`, json("PUT", { ...project, integration_branch: null }));
    expect(await edited.json()).toMatchObject({ id, name: "oakridge", integration_branch: null });
    expect((await f.app.request("/api/projects/missing", json("PUT", project))).status).toBe(404);
    const listed = await (await f.app.request("/api/projects")).json() as { items: { id: string; forge_repository: unknown }[] };
    expect(listed.items).toEqual([expect.objectContaining({ id, forge_repository: project.forge_repository })]);
  } finally { f.core.close(); }
}));

test("an archived run and definition leave the active listings and return when unarchived", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const runs = async (archived: boolean) => ((await (await f.app.request(`/api/runs?archived=${archived}`)).json()) as { items: { run_id: string }[] }).items.map((item) => item.run_id);
    const definitions = async (archived: boolean) => ((await (await f.app.request(`/api/definitions?archived=${archived}`)).json()) as { items: { bundle_id: string }[] }).items.map((item) => item.bundle_id);
    const [bundle_id] = await definitions(false);
    expect(await runs(false)).toEqual([f.run_id]);
    expect((await f.app.request(`/api/runs/${f.run_id}/archive`, { method: "POST" })).status).toBe(200);
    expect({ active: await runs(false), archived: await runs(true) }).toEqual({ active: [], archived: [f.run_id] });
    expect((await f.app.request(`/api/definitions/${bundle_id}/archive`, { method: "POST" })).status).toBe(200);
    expect({ active: await definitions(false), archived: await definitions(true) }).toEqual({ active: [], archived: [bundle_id] });
    await f.app.request(`/api/runs/${f.run_id}/unarchive`, { method: "POST" });
    await f.app.request(`/api/definitions/${bundle_id}/unarchive`, { method: "POST" });
    expect({ runs: await runs(false), definitions: await definitions(false) }).toEqual({ runs: [f.run_id], definitions: [bundle_id] });
    expect((await f.app.request("/api/runs/missing/archive", { method: "POST" })).status).toBe(404);
  } finally { f.core.close(); }
}));

test("the cutover import copies previous projects by id and is safe to repeat", async () => withDatabase(async ({ db }) => {
  // A previous Oakridge database names the merge branch base_branch.
  await db.query(`CREATE SCHEMA oakridge; CREATE TABLE oakridge.project (id uuid PRIMARY KEY, name text NOT NULL, repo_dir text NOT NULL,
    forge_repository jsonb, base_branch text, created_at timestamptz NOT NULL)`, []);
  await db.query(`INSERT INTO oakridge.project VALUES
    ('14632ba6-c2f1-4035-bd23-6021d6af17d2','scout','/home/steve/codes/rol/scout','{"name":"scout","owner":"RankOneLabs","provider":"github"}','main','2026-08-29'),
    ('7cc7ae17-bd4c-438f-892a-bee89eea32d6','safir','/home/steve/codes/personal/safir',NULL,NULL,'2026-08-30')`, []);
  expect((await importProjects(db, db)).map((outcome) => outcome.kind)).toEqual(["imported", "imported"]);
  expect((await importProjects(db, db)).map((outcome) => outcome.kind)).toEqual(["present", "present"]);
  expect(await db.query("SELECT id,name,integration_branch,forge_repository FROM authority.project ORDER BY name", [])).toEqual([
    { id: "7cc7ae17-bd4c-438f-892a-bee89eea32d6", name: "safir", integration_branch: null, forge_repository: null },
    { id: "14632ba6-c2f1-4035-bd23-6021d6af17d2", name: "scout", integration_branch: "main", forge_repository: { name: "scout", owner: "RankOneLabs", provider: "github" } },
  ]);
}));
