import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, migrationNames } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

test("migration discovery accepts only numbered SQL files in deterministic order", () => {
  expect(migrationNames(["notes.md", "0004_projects.sql", "0003_artifact_lifecycle.sql", "0002_workflow_attempt.sql", "0001_domain.sql", "1_bad.sql", "0003-UP.sql"]))
    .toEqual(["0001_domain.sql", "0002_workflow_attempt.sql", "0003_artifact_lifecycle.sql", "0004_projects.sql"]);
});

const MIGRATIONS = new URL("../src/storage/migrations", import.meta.url).pathname;
const BEFORE_BRANCH_ROLES = "0008_epic_base_branch.sql";

/** The migrations that ran before the one under test, in their own directory. */
const migrationsBefore = async (excluded: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "oakridge-migrations-"));
  await mkdir(directory, { recursive: true });
  for (const name of migrationNames(await readdir(MIGRATIONS))) {
    if (name >= excluded) continue;
    await copyFile(join(MIGRATIONS, name), join(directory, name));
  }
  return directory;
};

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

/** A database with every migration before the branch-roles one applied. */
const databaseBeforeBranchRoles = async (name: string) => {
  const scratch = await createScratchDatabase(name);
  if (!scratch.ok) {
    // A missing PostgreSQL is a skip; a refused CREATE DATABASE is not, and a
    // caller that treated them alike would report a broken environment green.
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    return null;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  const before = await migrationsBefore(BEFORE_BRANCH_ROLES);
  await applyMigrations(sql, before);
  await rm(before, { recursive: true, force: true });
  return sql;
};

/** A run, so an epic profile has something to hang off. */
const seedRun = async (sql: PgPostgresExecutor): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at)
    VALUES ('00000000-0000-4000-8000-000000000001', 'dev-flow', 12, '{}'::jsonb, false, now())`, []);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context)
    VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '{}'::jsonb)`, []);
};

/**
 * The branch-roles migration, run against rows written before it.
 *
 * It rewrites data an operator owns: an epic's branch bindings, in jsonb. A
 * migration that only ever runs against an empty test database proves that it
 * parses, not that it moves anything — and the thing it moves here is which
 * branch every build unit's pull request will target.
 */
test("the branch-roles migration promotes the epic branch and renames the integration one", async () => {
  const sql = await databaseBeforeBranchRoles("oakridge_migration_test");
  if (!sql) {
    console.warn("migration backfill SKIPPED: no PostgreSQL reachable");
    return;
  }
  try {
    // A run and an epic profile exactly as the pre-rename code wrote them: the
    // epic's branch repeated inside every repository binding, and `base_branch`
    // meaning `main`.
    await seedRun(sql);
    await sql.query(`INSERT INTO oakridge.epic_workflow_profile
        (id, workflow_run_id, title, slug, lifecycle_state, final_merge_policy, repositories, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002',
        'Tiers page', 'tiers-page', 'active', 'guarded',
        '[{"repository_key":"api","repository_path":"/repos/api","base_branch":"main","epic_branch":"epic/tiers-page","final_merge_state":"pending"},
          {"repository_key":"web","repository_path":"/repos/web","base_branch":"trunk","epic_branch":"epic/tiers-page","final_merge_state":"pending"}]'::jsonb,
        now(), now())`, []);

    const applied = await applyMigrations(sql, MIGRATIONS);
    expect(applied).toContain(BEFORE_BRANCH_ROLES);

    const rows = await sql.query<{ readonly base_branch: string; readonly repositories: readonly { readonly repository_key: string; readonly integration_branch: string; readonly base_branch?: string; readonly epic_branch?: string }[] }>(
      "SELECT base_branch, repositories FROM oakridge.epic_workflow_profile", []);
    const profile = rows[0];

    // The epic's branch is promoted out of the bindings, once.
    expect(profile?.base_branch).toBe("epic/tiers-page");
    // Each repository keeps its own integration branch — they differ here on
    // purpose, because a rewrite that collapsed them would look correct against
    // the usual all-`main` case.
    expect(profile?.repositories.map((repository) => [repository.repository_key, repository.integration_branch]))
      .toEqual([["api", "main"], ["web", "trunk"]]);
    // And the words that meant two branches are gone.
    for (const repository of profile?.repositories ?? []) {
      expect(repository.epic_branch).toBeUndefined();
      expect(repository.base_branch).toBeUndefined();
    }
  } finally {
    await sql.close();
  }
}, 60_000);

/**
 * An epic whose bindings named different epic branches cannot become one base
 * branch, and picking the first would drop the others silently and
 * unrecoverably. It should never occur — `epic_branch` defaulted to
 * `epic/<slug>` for every repository and the launcher never sent it — but a
 * migration that guesses on data it cannot convert is worse than one that
 * stops.
 */
test("the branch-roles migration refuses an epic that carries more than one epic branch", async () => {
  const sql = await databaseBeforeBranchRoles("oakridge_migration_divergent_test");
  if (!sql) {
    console.warn("divergent-migration check SKIPPED: no PostgreSQL reachable");
    return;
  }
  try {
    await seedRun(sql);
    await sql.query(`INSERT INTO oakridge.epic_workflow_profile
        (id, workflow_run_id, title, slug, lifecycle_state, final_merge_policy, repositories, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002',
        'Split epic', 'split-epic', 'active', 'guarded',
        '[{"repository_key":"api","base_branch":"main","epic_branch":"epic/api"},
          {"repository_key":"web","base_branch":"main","epic_branch":"epic/web"}]'::jsonb,
        now(), now())`, []);

    await expect(applyMigrations(sql, MIGRATIONS)).rejects.toThrow(/more than one epic_branch/);

    // And it stopped before touching anything: the bindings are as they were.
    const rows = await sql.query<{ readonly repositories: readonly { readonly epic_branch?: string }[] }>(
      "SELECT repositories FROM oakridge.epic_workflow_profile", []);
    expect(rows[0]?.repositories.map((repository) => repository.epic_branch)).toEqual(["epic/api", "epic/web"]);
  } finally {
    await sql.close();
  }
}, 60_000);
