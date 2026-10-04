import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratchDatabase } from "./durable-database";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";
import { applyMigrations } from "../../src/storage/migrate";
import { BunGitCommandRunner } from "../../src/runtime/git-command-runner";
import { loadDevFlowV15 } from "../../src/seed/dev-flow-v15";
import type { StageInstanceId } from "../../src/domain/primitives";

export const prepareV15StageFixture = async () => {
  const scratch = await createScratchDatabase(`oakridge_b4_${randomUUID().replaceAll("-", "")}`);
  if (!scratch.ok) throw new Error(scratch.error.detail);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  const root = await mkdtemp(join(tmpdir(), "oakridge-b4-"));
  const repository = join(root, "repo");
  const origin = join(root, "origin.git");
  const git = new BunGitCommandRunner();
  const runGit = async (directory: string, args: readonly string[]) => {
    const result = await git.run(directory, args);
    if (result.exit_code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    await runGit(root, ["init", "-b", "main", repository]);
    await runGit(repository, ["-c", "user.name=B4", "-c", "user.email=b4@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"]);
    await runGit(root, ["clone", "--bare", repository, origin]);
    await runGit(repository, ["remote", "add", "origin", origin]);
    await applyMigrations(sql);
    const definition = await loadDevFlowV15();
    if (!definition.ok) throw new Error(definition.error.detail);
    const definition_id = randomUUID();
    const run_id = randomUUID();
    const stage_id = randomUUID() as StageInstanceId;
    const context = { repositories: [{ key: "oakridge", path: repository, integration_branch: "main", forge_repository: null }],
      base_branch: "epic/b4", brief_notes: "Implement B4", builder: { runtime: "codex", model: null, effort: null }, planner: { runtime: "codex", model: null, effort: null } };
    await sql.query("INSERT INTO oakridge.workflow_definition (id,name,version,definition) VALUES ($1,'b4',1,$2::jsonb)", [definition_id, JSON.stringify(definition.value)]);
    await sql.query("INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status) VALUES ($1,$2,$3::jsonb,'{}','active')", [run_id, definition_id, JSON.stringify(context)]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'repository_preparation','provision_repository_refs',$3::jsonb,'active')`,
      [stage_id, run_id, JSON.stringify({ ...definition.value.stages.repository_preparation, dependency_stage_instance_ids: [] })]);
    return { sql, database_url: scratch.value.url, root, git, repository, origin, runGit, stage_id, run_id, definition: definition.value, context,
      close: async () => { await sql.close(); await scratch.value.drop(); await rm(root, { recursive: true, force: true }); } };
  } catch (cause) { await sql.close(); await scratch.value.drop(); await rm(root, { recursive: true, force: true }); throw cause; }
};
