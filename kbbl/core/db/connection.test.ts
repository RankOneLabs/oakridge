import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("openDb", () => {
  test("creates the file on open", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kbbl-db-test-"));
    const path = join(tmpDir, "test.db");
    const db = openDb(path);
    db.close();
    expect(Bun.file(path).size).toBeGreaterThan(0);
  });

  test("journal_mode is wal", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kbbl-db-test-"));
    const db = openDb(join(tmpDir, "test.db"));
    const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    db.close();
    expect(row?.journal_mode).toBe("wal");
  });

  test("foreign_keys is on", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kbbl-db-test-"));
    const db = openDb(join(tmpDir, "test.db"));
    const row = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    db.close();
    expect(row?.foreign_keys).toBe(1);
  });
});
