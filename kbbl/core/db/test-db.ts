import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyMigrations } from "./migrations";

export function openTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  applyMigrations(db, join(import.meta.dir, "migrations"));
  return db;
}
