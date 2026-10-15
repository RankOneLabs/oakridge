import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_FILENAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const DISABLE_FOREIGN_KEYS_MARKER = "-- kbbl:disable_foreign_keys";

function isForeignKeysEnabled(db: Database): boolean {
  const row = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  return row?.foreign_keys === 1;
}

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
  // A recorded migration with no file means this database was built by a
  // different migration history (the ledger was rebaselined since). Applying
  // the current files over it would fail midway or skip a changed schema.
  const known = new Set(files);
  const foreign = [...seen].filter((name) => !known.has(name)).sort();
  if (foreign.length > 0) {
    const location = db.filename && db.filename !== ":memory:" ? db.filename : "this database";
    throw new Error(
      `${location} records migrations kbbl no longer has (${foreign.join(", ")}): it predates the current schema baseline. ` +
        "Move it aside and restart kbbl to create a fresh one.",
    );
  }

  const applied: string[] = [];

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (seen.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const shouldDisableForeignKeys = sql.includes(DISABLE_FOREIGN_KEYS_MARKER);
    const restoreForeignKeys = shouldDisableForeignKeys && isForeignKeysEnabled(db);
    if (shouldDisableForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        insertMigration.run(file, new Date().toISOString());
      })();
    } finally {
      if (restoreForeignKeys) db.exec("PRAGMA foreign_keys = ON");
    }
    applied.push(file);
  }

  return { applied };
}
