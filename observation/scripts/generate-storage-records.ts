/** Generate Kysely row records directly from the committed SQL baseline. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPaths = ["0001_observation.sql", "0002_projection.sql"]
  .map((name) => resolve(import.meta.dir, "../src/storage/migrations", name));
const revisionLinksPath = resolve(import.meta.dir, "../src/storage/migrations/0003_revision_links.sql");
const outputPath = resolve(import.meta.dir, "../src/storage/db-types.ts");
const tables = migrationPaths.flatMap((path) => [...readFileSync(path, "utf8").matchAll(/CREATE TABLE observation\.(\w+) \(\n([\s\S]*?)\n\);/g)]);
if (tables.length !== 8) throw new Error(`expected eight observation tables, found ${tables.length}`);
const lines = [
  "// Generated from src/storage/migrations. Run bun observation/scripts/generate-storage-records.ts.",
  'import type { Generated } from "kysely";',
  'import type { JsonValue } from "../domain/primitives";',
  "",
];
const names: string[] = [];
for (const [, tableName, definition] of tables) {
  if (!tableName || !definition) throw new Error("malformed table declaration");
  const interfaceName = `Observation${tableName.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("")}`;
  names.push(`  "observation.${tableName}": ${interfaceName};`);
  lines.push(`export interface ${interfaceName} {`);
  for (const line of definition.split("\n")) {
    const column = /^  (\w+) (text|jsonb|timestamptz|boolean)\b(.*)$/.exec(line);
    if (!column) continue;
    const [, name, sqlType, modifiers] = column;
    const type = sqlType === "text" ? "string" : sqlType === "jsonb" ? "JsonValue" : sqlType === "timestamptz" ? "Date" : "boolean";
    const nullable = !modifiers?.includes("NOT NULL") && !modifiers?.includes("PRIMARY KEY");
    const columnType = `${type}${nullable ? " | null" : ""}`;
    lines.push(`  ${name}: ${modifiers?.includes("DEFAULT ") ? `Generated<${columnType}>` : columnType};`);
  }
  if (tableName === "source_revision") {
    const revisionLinks = readFileSync(revisionLinksPath, "utf8");
    const columns = [...revisionLinks.matchAll(/^  ADD COLUMN (\w+) (text),?$/gm)];
    if (columns.map(([, name]) => name).join(",") !== "predecessor_id,subject_id")
      throw new Error("unexpected source revision link columns");
    for (const [, name] of columns) lines.push(`  ${name}: string | null;`);
  }
  lines.push("}", "");
}
lines.push("export interface DB {", ...names, "}", "");
const generated = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) throw new Error("observation db-types.ts has drifted; regenerate it");
} else writeFileSync(outputPath, generated);
