/** Generate Kysely row records directly from the committed SQL baseline. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baselinePath = resolve(import.meta.dir, "../src/storage/migrations/0001_observation.sql");
const outputPath = resolve(import.meta.dir, "../src/storage/db-types.ts");
/** The target model's tables, named here so a baseline edit cannot silently change the set. */
const TARGET_TABLES = ["schema_baseline", "source_revision", "extractor_definition", "logical_item", "item_occurrence",
  "item_relation", "extraction_issue", "question_definition", "evaluator_definition", "evidence_set",
  "evaluation_execution", "grading_provider_attempt", "grade_observation", "source_event_cursor", "source_event_outcome"];
const tables = [...readFileSync(baselinePath, "utf8").matchAll(/CREATE TABLE observation\.(\w+) \(\n([\s\S]*?)\n\);/g)];
const declared = tables.map(([, tableName]) => tableName);
if (declared.join() !== TARGET_TABLES.join()) throw new Error(`baseline tables differ from the target: ${declared.join(", ")}`);
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
    const column = /^  (\w+) (text\[\]|text|jsonb|timestamptz|boolean|bigint|integer|numeric|double precision)(?![\w\[])(.*)$/.exec(line);
    if (!column) continue;
    const [, name, sqlType, modifiers] = column;
    const type = sqlType === "text[]" ? "string[]" : sqlType === "text" ? "string" : sqlType === "jsonb" ? "JsonValue" : sqlType === "timestamptz" ? "Date" : sqlType === "boolean" ? "boolean" : "number";
    const nullable = !modifiers?.includes("NOT NULL") && !modifiers?.includes("PRIMARY KEY") && !modifiers?.includes("GENERATED ALWAYS AS");
    const columnType = `${type}${nullable ? " | null" : ""}`;
    lines.push(`  ${name}: ${(modifiers?.includes("DEFAULT ") || modifiers?.includes("GENERATED ALWAYS AS")) ? `Generated<${columnType}>` : columnType};`);
  }
  lines.push("}", "");
}
lines.push("export interface DB {", ...names, "}", "");
const generated = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) throw new Error("observation db-types.ts has drifted; regenerate it");
} else writeFileSync(outputPath, generated);
