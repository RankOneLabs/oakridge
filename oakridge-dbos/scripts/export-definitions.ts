/** Export legacy jsonb definitions before the authority tables are retired.
 *
 * PostgreSQL jsonb has already discarded the input JSON byte order and spacing.
 * A noncanonical value therefore needs a separately reviewed conversion record;
 * this command never represents PostgreSQL's rendering as the original input.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { loadDefinition, readJsonObject, readProgramObject, readPromptObject } from "../src/definitions/store";

export interface LegacyDefinitionRow {
  readonly id: string;
  readonly digest: string;
  readonly source_text: string;
  readonly program_text: string;
  readonly prompts_text: string;
}
export interface LegacyPromptRow { readonly content_digest: string; readonly content: string }
export interface ConversionReview {
  readonly legacy_id: string;
  readonly source_sha256: string;
  readonly program_sha256: string;
  readonly prompts_sha256: string;
}
export interface ExportInput {
  readonly definitions: readonly LegacyDefinitionRow[];
  readonly prompts: readonly LegacyPromptRow[];
  readonly conversion_reviews: readonly ConversionReview[];
}
export interface LegacyDefinitionMapping {
  readonly definition_id: string;
  readonly legacy_digest: string;
  readonly program_sha256: string;
  readonly source_jsonb_text: string;
  readonly program_jsonb_text: string;
  readonly prompts_jsonb_text: string;
}
export interface ExportManifest {
  readonly format: "oakridge-definition-export/v1";
  readonly definitions: Readonly<{ [legacy_id: string]: LegacyDefinitionMapping }>;
}
interface ExportObject { readonly kind: "workflows" | "prompts" | "operations" | "programs"; readonly id: string; readonly bytes: string }
export interface ExportPlan { readonly manifest: ExportManifest; readonly objects: readonly ExportObject[] }
export class DefinitionExportError extends Error {
  constructor(readonly kind: "MissingRecordedDependency" | "NoncanonicalHistoricalBytes" | "InvalidRecordedDefinition" | "ConflictingStoreObject",
    readonly affected_ids: readonly string[], detail: string) {
    super(`${kind}: ${affected_ids.join(", ")}: ${detail}`);
    this.name = kind;
  }
}
const sha = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
function canonical(value: unknown, id: string): string {
  const encoded = canonicalJson(value);
  if (!encoded.ok) throw new DefinitionExportError("InvalidRecordedDefinition", [id], encoded.error.detail);
  return encoded.value;
}
function parseJson(text: string, id: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new DefinitionExportError("InvalidRecordedDefinition", [id], "recorded JSON is invalid"); }
}
function object(value: unknown, id: string): Readonly<{ [key: string]: unknown }> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DefinitionExportError("InvalidRecordedDefinition", [id], "expected an object");
  return value as { [key: string]: unknown };
}
function promptMap(value: unknown, id: string): Readonly<{ [path: string]: string }> {
  const entries = Object.entries(object(value, id));
  if (entries.some(([, digest]) => typeof digest !== "string" || !digestPattern.test(digest)))
    throw new DefinitionExportError("InvalidRecordedDefinition", [id], "invalid recorded prompt digest");
  return Object.fromEntries(entries) as { [path: string]: string };
}
function reviewed(row: LegacyDefinitionRow, reviews: ReadonlyMap<string, ConversionReview>): boolean {
  const review = reviews.get(row.id);
  return !!review && review.source_sha256 === sha(row.source_text) &&
    review.program_sha256 === sha(row.program_text) && review.prompts_sha256 === sha(row.prompts_text);
}

/** All dependencies and review records are checked before any files are written. */
export function planDefinitionExport(input: ExportInput): ExportPlan {
  const promptRows = new Map(input.prompts.map((row) => [row.content_digest, row]));
  const reviews = new Map(input.conversion_reviews.map((row) => [row.legacy_id, row]));
  const missing = new Set<string>();
  const noncanonical = new Set<string>();
  const invalid = new Set<string>();
  const objects: ExportObject[] = [];
  const mappings: { [legacy_id: string]: LegacyDefinitionMapping } = {};
  for (const row of input.definitions) {
    const source = object(parseJson(row.source_text, row.id), row.id);
    const program = object(parseJson(row.program_text, row.id), row.id);
    const prompts = promptMap(parseJson(row.prompts_text, row.id), row.id);
    if (canonical(source, row.id) !== row.source_text || canonical(program, row.id) !== row.program_text ||
        canonical(prompts, row.id) !== row.prompts_text) {
      if (!reviewed(row, reviews)) noncanonical.add(row.id);
    }
    const operations = program.operations;
    if (!Array.isArray(operations)) { missing.add(`${row.id}: recorded operations`); continue; }
    const registryBytes = canonical(operations, row.id);
    const registryId = sha(registryBytes);
    if (source.operations !== undefined && source.operations !== null && source.operations !== registryId) {
      invalid.add(`${row.id}: source operation reference ${String(source.operations)}`);
      continue;
    }
    for (const [path, digest] of Object.entries(prompts)) {
      const prompt = promptRows.get(digest);
      if (!prompt) { missing.add(`${row.id}: ${path} -> ${digest}`); continue; }
      if (sha(prompt.content) !== digest) { invalid.add(`${row.id}: prompt ${path} digest mismatch`); continue; }
      if (prompt.content.startsWith("\uFEFF") || prompt.content.includes("\r") ||
          !prompt.content.endsWith("\n") || prompt.content.endsWith("\n\n")) {
        noncanonical.add(`${row.id}: prompt ${path}`); continue;
      }
      objects.push({ kind: "prompts", id: digest, bytes: prompt.content });
    }
    const workflowBytes = canonical({ source: { ...source, operations: registryId }, operations: registryId, prompts }, row.id);
    const definitionId = sha(workflowBytes);
    const programBytes = canonical(program, row.id);
    objects.push({ kind: "operations", id: registryId, bytes: registryBytes },
      { kind: "workflows", id: definitionId, bytes: workflowBytes },
      { kind: "programs", id: definitionId, bytes: programBytes });
    mappings[row.id] = { definition_id: definitionId, legacy_digest: row.digest,
      program_sha256: sha(programBytes), source_jsonb_text: row.source_text,
      program_jsonb_text: row.program_text, prompts_jsonb_text: row.prompts_text };
  }
  for (const row of input.prompts) {
    if (sha(row.content) !== row.content_digest) invalid.add(`prompt_content ${row.content_digest}: digest mismatch`);
    if (row.content.startsWith("\uFEFF") || row.content.includes("\r") ||
        !row.content.endsWith("\n") || row.content.endsWith("\n\n")) noncanonical.add(`prompt_content ${row.content_digest}`);
    objects.push({ kind: "prompts", id: row.content_digest, bytes: row.content });
  }
  if (missing.size) throw new DefinitionExportError("MissingRecordedDependency", [...missing].sort(), "export stopped before writing");
  if (invalid.size) throw new DefinitionExportError("InvalidRecordedDefinition", [...invalid].sort(), "export stopped before writing");
  if (noncanonical.size) throw new DefinitionExportError("NoncanonicalHistoricalBytes", [...noncanonical].sort(),
    "provide an independently reviewed conversion manifest with SHA-256 of each PostgreSQL jsonb rendering; original JSON input bytes are unavailable");
  return { manifest: { format: "oakridge-definition-export/v1", definitions: mappings }, objects };
}

function writeVerified(path: string, bytes: string, affectedId: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== bytes)
      throw new DefinitionExportError("ConflictingStoreObject", [affectedId], path);
    return;
  }
  writeFileSync(path, bytes, { flag: "wx" });
  if (readFileSync(path, "utf8") !== bytes)
    throw new DefinitionExportError("ConflictingStoreObject", [affectedId], `written bytes differ: ${path}`);
}

/** Existing objects are accepted only when byte identical; reruns are deterministic. */
export function writeDefinitionExport(root: string, plan: ExportPlan): void {
  const unique = new Map<string, ExportObject>();
  for (const item of plan.objects) {
    const key = `${item.kind}/${item.id}`;
    if (unique.has(key) && unique.get(key)!.bytes !== item.bytes)
      throw new DefinitionExportError("ConflictingStoreObject", [key], "two recorded objects have different bytes");
    unique.set(key, item);
  }
  const manifestBytes = canonical(plan.manifest, "legacy-definition-map.json");
  for (const [key, item] of unique) {
    if (item.kind !== "programs" && sha(item.bytes) !== item.id)
      throw new DefinitionExportError("ConflictingStoreObject", [key], "planned bytes do not hash to ID");
    const path = resolve(root, item.kind, `${item.id}.${item.kind === "prompts" ? "md" : "json"}`);
    if (existsSync(path) && readFileSync(path, "utf8") !== item.bytes)
      throw new DefinitionExportError("ConflictingStoreObject", [key], path);
  }
  const manifestPath = resolve(root, "legacy-definition-map.json");
  if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") !== manifestBytes)
    throw new DefinitionExportError("ConflictingStoreObject", ["legacy-definition-map.json"], manifestPath);
  for (const kind of ["workflows", "prompts", "operations", "programs"]) mkdirSync(resolve(root, kind), { recursive: true });
  for (const [key, item] of [...unique].sort(([left], [right]) => left.localeCompare(right))) {
    const path = resolve(root, item.kind, `${item.id}.${item.kind === "prompts" ? "md" : "json"}`);
    writeVerified(path, item.bytes, key);
    if (item.kind === "prompts") readPromptObject(root, item.id);
    else if (item.kind === "programs") readProgramObject(root, item.id);
    else readJsonObject(root, item.kind, item.id);
  }
  for (const mapping of Object.values(plan.manifest.definitions)) {
    loadDefinition(root, mapping.definition_id);
    const programBytes = readFileSync(resolve(root, "programs", `${mapping.definition_id}.json`), "utf8");
    if (sha(programBytes) !== mapping.program_sha256)
      throw new DefinitionExportError("ConflictingStoreObject", [mapping.definition_id], "recorded program digest differs");
  }
  writeVerified(manifestPath, manifestBytes, "legacy-definition-map.json");
}

export async function exportDefinitions(databaseUrl: string, root: string, reviews: readonly ConversionReview[]): Promise<ExportManifest> {
  const db = openDatabase(databaseUrl);
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(trx);
      const definitions = await sql<LegacyDefinitionRow>`SELECT id, digest, source::text AS source_text,
        checked_program::text AS program_text, prompts::text AS prompts_text
        FROM authority.definition_bundle ORDER BY id`.execute(trx);
      const prompts = await sql<LegacyPromptRow>`SELECT content_digest, content FROM authority.prompt_content ORDER BY content_digest`.execute(trx);
      const plan = planDefinitionExport({ definitions: definitions.rows, prompts: prompts.rows, conversion_reviews: reviews });
      writeDefinitionExport(root, plan);
      return plan.manifest;
    });
  } finally { await db.destroy(); }
}

if (import.meta.main) {
  const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
  const root = process.env.OAKRIDGE_DEFINITION_ROOT;
  if (!databaseUrl || !root) throw new Error("DBOS_SYSTEM_DATABASE_URL and OAKRIDGE_DEFINITION_ROOT are required");
  const reviewPath = process.argv[2];
  const reviews = reviewPath ? JSON.parse(readFileSync(reviewPath, "utf8")) as ConversionReview[] : [];
  console.log(JSON.stringify(await exportDefinitions(databaseUrl, root, reviews), null, 2));
}
