import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_FILENAME = /^\d{3}_[a-z0-9_]+\.sql$/;

type ForeignKeyViolation = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

export function applyMigrations(db: Database, migrationsDir: string): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => MIGRATION_FILENAME.test(f))
    .sort();

  const seen = new Set(
    db.query<{ name: string }, []>("SELECT name FROM _migrations").all().map((r) => r.name),
  );

  const applied: string[] = [];

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (seen.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      const foreignKeyViolations = db
        .query<ForeignKeyViolation, []>("PRAGMA foreign_key_check")
        .all();
      if (foreignKeyViolations.length > 0) {
        throw new Error(`Migration ${file} failed foreign key check`);
      }
      insertMigration.run(file, new Date().toISOString());
    })();
    applied.push(file);
  }

  return { applied };
}
