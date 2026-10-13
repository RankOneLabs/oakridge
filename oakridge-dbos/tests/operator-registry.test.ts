import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sql } from "kysely";
import { importProjects } from "../scripts/import-projects";
import { installDefinitionApi } from "../src/http/app";
import { openDatabase } from "../src/storage/database";
import { launch, openAuthority, pinSample, sampleWorkflow, type Authority } from "./authority-fixture";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const readModelFields = [
  ["OperatorRunDetail", ["run_id", "definition_bundle_id", "definition_digest", "version", "created_at", "archived_at", "cursor", "scopes"]],
  ["OperatorRunSummary", ["run_id", "definition_bundle_id", "definition_digest", "version", "created_at", "archived_at"]],
  ["OperatorRunSessionAttempt", ["location", "worker_key", "generation", "status", "result"]],
  ["OperatorSessionLocation", ["run_id", "scope_id", "execution_id"]],
  ["OperatorArtifactDetail", ["run_id", "scope_id", "output_key", "collection_key", "slot_version", "revision_id", "predecessor_id", "body", "status", "presentation"]],
  ["OperatorDecision", ["decision", "cursor"]],
  ["OperatorReviewInbox", ["cursor", "items", "next_cursor"]],
] as const;

function inlineReadModel(node: ts.ObjectLiteralExpression): string | null {
  const fields = new Set(node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? [property.name.text] : [];
  }));
  return readModelFields.find(([, required]) => required.every((field) => fields.has(field)))?.[0] ?? null;
}

// R4 rebuilt these seven read models in the v1 shape, renamed per rescue spec §2.3.
test("all seven operator read models are reachable in generated PWA contracts", () => {
  const contracts = readFileSync(resolve(import.meta.dir, "../../kbbl/core/pwa/oakridge/operator-contracts.ts"), "utf8");
  for (const name of ["RunSummary", "RunDetail", "RunSessionAttempt", "SessionLocation", "ArtifactDetail", "Decision", "ReviewInbox"])
    expect(contracts).toMatch(new RegExp(`export (?:interface|type) Operator${name}\\b`));
});

test("PWA read-model fixtures are constructed only in the shared factory", () => {
  const root = resolve(import.meta.dir, "../../kbbl/core/pwa");
  const models = new Set<string>(readModelFields.map(([name]) => name));
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : /\.(?:test|spec)\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []);
  for (const file of files(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && ts.isVariableDeclaration(node.parent) && !node.parent.type) {
        const model = inlineReadModel(node);
        if (model) throw new Error(`${file}: construct ${model} with __fixtures__/read-models.ts`);
      }
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

test("read-model fixture lint recognizes inline untyped literals", () => {
  for (const [name, fields] of readModelFields) {
    const source = ts.createSourceFile("inline.ts", `const value = { ${fields.map((field) => `${field}: null`).join(", ")} };`, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    if (!statement || !ts.isVariableStatement(statement)) throw new Error("test fixture declaration missing");
    const literal = statement.declarationList.declarations[0]?.initializer;
    if (!literal || !ts.isObjectLiteralExpression(literal)) throw new Error("test fixture literal missing");
    expect(inlineReadModel(literal)).toBe(name);
  }
});

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const project = { name: "oakridge", repo_dir: "/home/steve/codes/rol/oakridge", forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" }, integration_branch: "main" };

async function withApi(body: (input: { readonly authority: Authority; readonly app: Hono }) => Promise<void>): Promise<void> {
  const authority = await openAuthority();
  const app = new Hono();
  installDefinitionApi(app, { db: authority.db, core: authority.core, wake: () => undefined });
  try { await body({ authority, app }); } finally { await authority.close(); }
}

test("projects are created, listed and edited, with names kept unique", async () => withApi(async ({ app }) => {
  const created = await app.request("/api/projects", json("POST", project));
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await app.request("/api/projects", json("POST", project))).status).toBe(409);
  expect((await app.request("/api/projects", json("POST", { ...project, name: "relative", repo_dir: "codes/x" }))).status).toBe(422);
  const edited = await app.request(`/api/projects/${id}`, json("PUT", { ...project, integration_branch: null }));
  expect(await edited.json()).toMatchObject({ id, name: "oakridge", integration_branch: null });
  expect((await app.request("/api/projects/missing", json("PUT", project))).status).toBe(404);
  const listed = await (await app.request("/api/projects")).json() as { items: { id: string; forge_repository: unknown }[] };
  expect(listed.items).toEqual([expect.objectContaining({ id, forge_repository: project.forge_repository })]);
}));

test("a workflow with a code worker compiles and pins", async () => withApi(async ({ app }) => {
  expect((await app.request("/api/definitions", json("POST", sampleWorkflow("fan-out")))).status).toBe(201);
}));

test("a prompt map with a non-string path is a 422, not a fault", async () => withApi(async ({ app }) => {
  const workflow = sampleWorkflow("review-loop");
  const [stage_key, stage] = Object.entries(workflow.stages)[0]!;
  const [worker_key, worker] = Object.entries(stage.workers).find(([, candidate]) => candidate.kind === "agent")!;
  const [review_key, review] = Object.entries(stage.reviews ?? {})[0]!;
  const withStage = (patch: object) => ({ ...workflow, stages: { ...workflow.stages, [stage_key]: { ...stage, ...patch } } });
  const bad_agent = withStage({ workers: { ...stage.workers, [worker_key]: { ...worker, prompts: { initial: 42 } } } });
  const bad_review = withStage({ reviews: { ...stage.reviews, [review_key]: { ...review, prompt: ["x"] } } });
  const statuses = await Promise.all([bad_agent, bad_review].map(async (body) => (await app.request("/api/definitions/compile", json("POST", body))).status));
  expect(statuses).toEqual([422, 422]);
}));

test("an archived run and definition leave the active listings and return when unarchived", async () => withApi(async ({ authority, app }) => {
  const { bundle_id } = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  const runs = async (archived: boolean) => ((await (await app.request(`/api/runs?archived=${archived}`)).json()) as { items: { run_id: string }[] }).items.map((item) => item.run_id);
  const definitions = async (archived: boolean) => ((await (await app.request(`/api/definitions?archived=${archived}`)).json()) as { items: { bundle_id: string }[] }).items.map((item) => item.bundle_id);
  expect(await runs(false)).toEqual([run_id]);
  expect((await app.request(`/api/runs/${run_id}/archive`, { method: "POST" })).status).toBe(200);
  expect({ active: await runs(false), archived: await runs(true) }).toEqual({ active: [], archived: [run_id] });
  expect((await app.request(`/api/definitions/${bundle_id}/archive`, { method: "POST" })).status).toBe(200);
  expect({ active: await definitions(false), archived: await definitions(true) }).toEqual({ active: [], archived: [bundle_id] });
  await app.request(`/api/runs/${run_id}/unarchive`, { method: "POST" });
  await app.request(`/api/definitions/${bundle_id}/unarchive`, { method: "POST" });
  expect({ runs: await runs(false), definitions: await definitions(false) }).toEqual({ runs: [run_id], definitions: [bundle_id] });
  expect((await app.request("/api/runs/missing/archive", { method: "POST" })).status).toBe(404);
}));

test("the cutover import copies previous projects by id and is safe to repeat", async () => withApi(async ({ authority }) => {
  // A previous Oakridge database names the merge branch base_branch.
  await sql`CREATE SCHEMA oakridge; CREATE TABLE oakridge.project (id uuid PRIMARY KEY, name text NOT NULL, repo_dir text NOT NULL,
    forge_repository jsonb, base_branch text, created_at timestamptz NOT NULL)`.execute(authority.db);
  await sql`INSERT INTO oakridge.project VALUES
    ('14632ba6-c2f1-4035-bd23-6021d6af17d2','scout','/home/steve/codes/rol/scout','{"name":"scout","owner":"RankOneLabs","provider":"github"}','main','2026-08-29'),
    ('7cc7ae17-bd4c-438f-892a-bee89eea32d6','safir','/home/steve/codes/personal/safir',NULL,NULL,'2026-08-30')`.execute(authority.db);
  const source = openDatabase<Parameters<typeof importProjects>[0] extends import("kysely").Kysely<infer S> ? S : never>(authority.url);
  try {
    expect((await importProjects(source, authority.db)).map((outcome) => outcome.kind)).toEqual(["imported", "imported"]);
    expect((await importProjects(source, authority.db)).map((outcome) => outcome.kind)).toEqual(["present", "present"]);
  } finally { await source.destroy(); }
  expect(await authority.db.selectFrom("authority.project").select(["id", "name", "integration_branch", "forge_repository"]).orderBy("name").execute()).toEqual([
    { id: "7cc7ae17-bd4c-438f-892a-bee89eea32d6", name: "safir", integration_branch: null, forge_repository: null },
    { id: "14632ba6-c2f1-4035-bd23-6021d6af17d2", name: "scout", integration_branch: "main", forge_repository: { name: "scout", owner: "RankOneLabs", provider: "github" } },
  ]);
}));
