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
import { sql, type Kysely } from "kysely";
import { openDatabase, type Database } from "../src/storage/database";
import { createProject, hasProject } from "../src/storage/registry-store";
import type { ProjectDraft } from "../src/domain/projects";
import type { ForgeRepository } from "../src/storage/json-column-types";
import type { ProjectId } from "../src/storage/schema-records";

interface SourceProject { readonly id: string; readonly name: string; readonly repo_dir: string; readonly forge_repository: ForgeRepository | null; readonly integration_branch: string | null }
/** The previous database's project table, as far as the import reads it. */
interface SourceDB {
  "information_schema.columns": { readonly column_name: string; readonly table_schema: string; readonly table_name: string };
  "oakridge.project": SourceProject & { readonly base_branch: string | null; readonly created_at: Date };
}
export type ImportOutcome = { readonly kind: "imported" | "present"; readonly id: string; readonly name: string } | { readonly kind: "conflict"; readonly id: string; readonly name: string; readonly detail: string };

export async function readSourceProjects(source: Kysely<SourceDB>): Promise<readonly SourceProject[]> {
  const columns = (await source.selectFrom("information_schema.columns").select("column_name")
    .where("table_schema", "=", "oakridge").where("table_name", "=", "project").execute()).map((row) => row.column_name);
  if (columns.length === 0) throw new Error("source has no oakridge.project table");
  const branch = columns.includes("integration_branch") ? "integration_branch" : columns.includes("base_branch") ? "base_branch" : null;
  return source.selectFrom("oakridge.project").select(["name", "repo_dir", "forge_repository"])
    .select(sql<string>`id::text`.as("id"))
    .select(branch === null ? sql<string | null>`NULL`.as("integration_branch") : sql.ref<string | null>(branch).as("integration_branch"))
    .orderBy("created_at").orderBy("id").execute();
}

export async function importProjects(source: Kysely<SourceDB>, target: Database): Promise<readonly ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const project of await readSourceProjects(source)) {
    if (await hasProject(target, project.id as ProjectId)) {
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
  const source = openDatabase<SourceDB>(source_url);
  const target = openDatabase(target_url);
  try {
    const outcomes = await importProjects(source, target);
    for (const outcome of outcomes) console.log(JSON.stringify(outcome));
    if (outcomes.some((outcome) => outcome.kind === "conflict")) process.exitCode = 1;
  } finally { await source.destroy(); await target.destroy(); }
}
