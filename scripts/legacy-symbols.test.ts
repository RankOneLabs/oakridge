import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const fixedStrings = [
  ["TASKS", "ARTIFACT"].join("_"),
  ["analysis", "link", "declaration"].join("-"),
  ["legacy", "Definitions"].join(""),
  ["legacy", "RunEvents"].join(""),
  ["RETIRED", "MODEL", "IDS"].join("_"),
  ["observation.artifact-revision", "v3"].join("/"),
  ["tasks", "body"].join("_"),
  ["dev", "tasks"].join("."),
];

test("cutover removes phase0 and retired protocol symbols", () => {
  expect(existsSync(resolve(root, "phase0"))).toBe(false);
  const result = Bun.spawnSync({
    cwd: root,
    cmd: ["git", "grep", "-nF", ...fixedStrings.flatMap((symbol) => ["-e", symbol]), "--", "*.ts", "*.tsx", "*.rs", "*.py", "*.sh"],
  });
  expect({ code: result.exitCode, matches: result.stdout.toString() }).toEqual({ code: 1, matches: "" });
});

test("Oakridge and observation ship one PostgreSQL baseline and keep the SQLite ledger at migration 007", () => {
  const migrations = (path: string) => readdirSync(resolve(root, path)).filter((name) => name.endsWith(".sql")).sort();
  expect(migrations("oakridge-dbos/src/storage/migrations")).toEqual(["0001_core.sql"]);
  expect(migrations("observation/src/storage/migrations")).toHaveLength(1);
  expect(migrations("kbbl/core/db/migrations").at(-1)).toBe("007_session_applied_model_name.sql");
});
