/**
 * Cutover: copy saved projects from the previous Oakridge database (or a
 * restored dump of it) into authority.project, keeping each project's id.
 *
 *   bun oakridge-dbos/scripts/import-projects.ts <source-database-url> <target-database-url>
 *
 * The source is read-only. Older sources name the merge branch `base_branch`,
 * newer ones `integration_branch`; either is accepted. A project whose id is
 * already present is left alone, so the import can be repeated safely.
 */
import { PgPostgresExecutor, type SqlExecutor } from "../src/storage/sql-executor";
import { createProject } from "../src/storage/projects";
import type { ProjectDraft } from "../src/domain/projects";
import type { ForgeRepository } from "../src/storage/json-column-types";
import type { ProjectId } from "../src/storage/schema-records";

interface SourceProject { readonly id: string; readonly name: string; readonly repo_dir: string; readonly forge_repository: ForgeRepository | null; readonly integration_branch: string | null }
export type ImportOutcome = { readonly kind: "imported" | "present"; readonly id: string; readonly name: string } | { readonly kind: "conflict"; readonly id: string; readonly name: string; readonly detail: string };

export async function readSourceProjects(source: SqlExecutor): Promise<readonly SourceProject[]> {
  const columns = (await source.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='oakridge' AND table_name='project'", [])).map((row) => row.column_name);
  if (columns.length === 0) throw new Error("source has no oakridge.project table");
  const branch = columns.includes("integration_branch") ? "integration_branch" : columns.includes("base_branch") ? "base_branch" : "NULL";
  return source.query<SourceProject>(`SELECT id::text,name,repo_dir,forge_repository,${branch} AS integration_branch FROM oakridge.project ORDER BY created_at,id`, []);
}

export async function importProjects(source: SqlExecutor, target: SqlExecutor): Promise<readonly ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const project of await readSourceProjects(source)) {
    if ((await target.query("SELECT 1 FROM authority.project WHERE id=$1", [project.id])).length) {
      outcomes.push({ kind: "present", id: project.id, name: project.name });
      continue;
    }
    const draft: ProjectDraft = { name: project.name, repo_dir: project.repo_dir, forge_repository: project.forge_repository, integration_branch: project.integration_branch };
    const created = await createProject(target, project.id as ProjectId, draft);
    outcomes.push(created.ok ? { kind: "imported", id: project.id, name: project.name }
      : { kind: "conflict", id: project.id, name: project.name, detail: `a different project is already named ${project.name}` });
  }
  return outcomes;
}

if (import.meta.main) {
  const [source_url, target_url] = process.argv.slice(2);
  if (!source_url || !target_url) {
    console.error("usage: bun oakridge-dbos/scripts/import-projects.ts <source-database-url> <target-database-url>");
    process.exit(2);
  }
  const source = PgPostgresExecutor.connect(source_url);
  const target = PgPostgresExecutor.connect(target_url);
  try {
    const outcomes = await importProjects(source, target);
    for (const outcome of outcomes) console.log(JSON.stringify(outcome));
    if (outcomes.some((outcome) => outcome.kind === "conflict")) process.exitCode = 1;
  } finally { await source.close(); await target.close(); }
}
