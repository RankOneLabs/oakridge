/** Generate observation records from the catalog built by the ordered manifest. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { createScratchDatabase } from "./scratch-database";

const outputPath = resolve(import.meta.dir, "../src/storage/db-types.ts");
// Retype the last catalog snapshot when the database used for generation is unavailable.
// The regular catalog generation remains the authoritative path for schema changes.
if (process.argv.includes("--retype-json-snapshot")) {
  const snapshot = readFileSync(outputPath, "utf8");
  let generated = snapshot.replace('import type { JsonColumn, NullableJsonColumn } from "./json-column-types";',
    'import type { JsonColumn, NullableJsonColumn, GeneratedJsonColumn } from "./json-column-types";')
    .replace('import type { JsonValue } from "../domain/primitives";\n\n',
      'import type { JsonValue } from "../domain/primitives";\nimport type { JsonColumn, NullableJsonColumn, GeneratedJsonColumn } from "./json-column-types";\n\n')
    .replace(/: Generated<JsonValue>;/g, ': GeneratedJsonColumn<JsonValue>;')
    .replace(/: Generated<JsonColumn<JsonValue>>;/g, ': GeneratedJsonColumn<JsonValue>;')
    .replace(/: JsonValue \| null;/g, ': NullableJsonColumn<JsonValue>;')
    .replace(/: JsonValue;/g, ': JsonColumn<JsonValue>;');
  if (!generated.includes('export interface ObservationSourceEventIssue {')) {
    const issueColumns = readFileSync(resolve(import.meta.dir, '../src/storage/migrations/0016_source_event_issue.sql'), 'utf8')
      .split('CREATE TABLE observation.source_event_issue (')[1]!.split('\n);')[0]!.split('\n')
      .map((line) => line.trim().replace(/,$/, '')).filter((line) => line && !line.startsWith('PRIMARY KEY'));
    const column = (line: string): string => {
      const [name, type] = line.split(/\s+/, 2);
      const nullable = !line.includes('NOT NULL') && !line.includes('PRIMARY KEY');
      const value = type === 'jsonb' ? nullable ? 'NullableJsonColumn<JsonValue>' : 'JsonColumn<JsonValue>'
        : type === 'timestamptz' ? nullable ? 'Date | null' : 'Date' : nullable ? 'string | null' : 'string';
      return `  ${name}: ${line.includes('DEFAULT') ? `Generated<${value}>` : value};`;
    };
    generated = generated.replace('export interface ObservationSourceEventOutcome {',
      `export interface ObservationSourceEventIssue {\n${issueColumns.map(column).join('\n')}\n}\n\nexport interface ObservationSourceEventOutcome {`)
      .replace('  "observation.source_event_outcome": ObservationSourceEventOutcome;',
        '  "observation.source_event_issue": ObservationSourceEventIssue;\n  "observation.source_event_outcome": ObservationSourceEventOutcome;');
  }
  if (!generated.includes('  collection_key: string | null;')) generated = generated.replace(
    '  definition_id: string | null;\n}', '  definition_id: string | null;\n  collection_key: string | null;\n}');
  writeFileSync(outputPath, generated);
  process.exit(0);
}
interface CatalogColumn { readonly table_name: string; readonly column_name: string; readonly data_type: string;
  readonly udt_name: string; readonly is_nullable: string; readonly column_default: string | null; readonly is_generated: string }

function columnType(column: CatalogColumn): string {
  if (column.udt_name === "jsonb") {
    const type = column.is_nullable === "YES" ? "NullableJsonColumn<JsonValue>" : "JsonColumn<JsonValue>";
    return column.column_default !== null || column.is_generated !== "NEVER" ? "GeneratedJsonColumn<JsonValue>" : type;
  }
  const type = column.udt_name === "jsonb" ? "JsonValue" : column.udt_name === "timestamptz" ? "Date"
    : column.udt_name === "bool" ? "boolean" : ["int2", "int4", "int8", "numeric", "float4", "float8"].includes(column.udt_name)
      ? "number" : "string";
  const nullable = column.is_nullable === "YES" ? `${type} | null` : type;
  return column.column_default !== null || column.is_generated !== "NEVER" ? `Generated<${nullable}>` : nullable;
}

async function generateRecords(serverUrl: string): Promise<string> {
  const scratch = await createScratchDatabase(serverUrl, `observation_records_${randomBytes(6).toString("hex")}`);
  try {
    const db = openDatabase(scratch.url);
    try {
      await migrateEmptyDatabase(db);
      const catalog = await sql<CatalogColumn>`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, is_generated
        FROM information_schema.columns WHERE table_schema = 'observation' ORDER BY table_name, ordinal_position`.execute(db);
      const tables = new Map<string, CatalogColumn[]>();
      for (const column of catalog.rows) {
        const columns = tables.get(column.table_name) ?? [];
        columns.push(column);
        tables.set(column.table_name, columns);
      }
      const lines = ["// Generated from src/storage/migrations. Run bun observation/scripts/generate-storage-records.ts.",
        'import type { Generated } from "kysely";', 'import type { JsonValue } from "../domain/primitives";',
        'import type { JsonColumn, NullableJsonColumn, GeneratedJsonColumn } from "./json-column-types";', ""];
      const names: string[] = [];
      for (const [table, columns] of tables) {
        const interfaceName = `Observation${table.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("")}`;
        names.push(`  "observation.${table}": ${interfaceName};`);
        lines.push(`export interface ${interfaceName} {`);
        for (const column of columns) lines.push(`  ${column.column_name}: ${columnType(column)};`);
        lines.push("}", "");
      }
      lines.push("export interface DB {", ...names, "}", "");
      return lines.join("\n");
    } finally { await db.destroy(); }
  } finally { await scratch.drop(); }
}

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
const generated = await generateRecords(serverUrl);
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) throw new Error("observation db-types.ts has drifted; regenerate it");
} else writeFileSync(outputPath, generated);
