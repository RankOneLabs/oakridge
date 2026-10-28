/** Generate Kysely row records directly from the committed SQL baseline. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baselinePath = resolve(import.meta.dir, "../src/storage/migrations/0001_observation.sql");
const outputPath = resolve(import.meta.dir, "../src/storage/db-types.ts");
const baseline = readFileSync(baselinePath, "utf8");
const tables = [...baseline.matchAll(/CREATE TABLE observation\.(\w+) \(\n([\s\S]*?)\n\);/g)];
if (tables.length !== 3) throw new Error(`expected three observation baseline tables, found ${tables.length}`);
const lines = [
  "// Generated from src/storage/migrations/0001_observation.sql. Run bun observation/scripts/generate-storage-records.ts.",
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
    lines.push(`  ${name}: ${modifiers?.includes("DEFAULT ") ? `Generated<${type}>` : type};`);
  }
  lines.push("}", "");
}
lines.push("export interface DB {", ...names, "}", "");
const generated = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) throw new Error("observation db-types.ts has drifted; regenerate it");
} else writeFileSync(outputPath, generated);
