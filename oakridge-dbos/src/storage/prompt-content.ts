import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { Result } from "./commit";
import type { SqlExecutor } from "./sql-executor";

/**
 * A pinned definition owns its prompt bytes. They are read from the authored
 * file once, when a digest is first pinned, and stored content-addressed;
 * every later render reads the stored bytes, so editing or regenerating a
 * prompt file cannot change, or break, a definition that is already pinned.
 */
export type PromptDeclaration = DefinitionBundle["prompts"][number];
export interface PromptContent { readonly content_digest: string; readonly content: string }
/** Stored prompt text by prompt key, for the prompts one decision renders. */
export type PromptTexts = ReadonlyMap<string, string>;

// A JSON list keeps the parameter portable across both PostgreSQL drivers.
const DIGESTS_SQL = "SELECT content_digest,content FROM authority.prompt_content WHERE content_digest IN (SELECT jsonb_array_elements_text($1::jsonb))";

function reject(operation: string, entity_id: string, detail: string): Result<never> {
  return { ok: false, error: { operation, entity_id, detail } };
}

/** The allowlist is relative to the configured repository root. */
const PROMPT_PREFIX = `workflow-config${sep}prompts${sep}`;
/** Read an authored prompt file and verify it against its declared digest. */
export function readAuthoredPrompt(prompt: PromptDeclaration): Result<PromptContent> {
  const path = prompt.path;
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || !path.startsWith("workflow-config/prompts/"))
    return reject("resolve_prompt", prompt.key, "prompt path is outside the configured allowlist");
  let content: Buffer;
  try {
    const root = realpathSync(process.env.OAKRIDGE_PROMPT_ROOT ?? resolve(import.meta.dir, "../../.."));
    const actual = realpathSync(resolve(root, path));
    const relative_path = relative(root, actual);
    if (relative_path.startsWith("..") || isAbsolute(relative_path) || !relative_path.startsWith(PROMPT_PREFIX))
      return reject("resolve_prompt", prompt.key, "prompt path is outside the configured root or allowlist");
    content = readFileSync(actual);
  } catch (cause) { return reject("resolve_prompt", prompt.key, String(cause)); }
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== prompt.content_digest)
    return reject("resolve_prompt", prompt.key, `prompt content digest mismatch: expected ${prompt.content_digest}, actual ${digest}`);
  return { ok: true, value: { content_digest: digest, content: content.toString("utf8") } };
}

function isPromptDeclaration(prompt: unknown): prompt is PromptDeclaration {
  if (!prompt || typeof prompt !== "object") return false;
  const candidate = prompt as Partial<PromptDeclaration>;
  return typeof candidate.key === "string" && typeof candidate.path === "string" && typeof candidate.content_digest === "string";
}

/**
 * Every declared prompt's content: stored bytes when the digest is already
 * pinned, otherwise the authored file, verified against its digest.
 */
export async function resolveBundlePrompts(db: SqlExecutor, bundle: DefinitionBundle, operation: string): Promise<Result<readonly PromptContent[]>> {
  if (!Array.isArray(bundle.prompts) || !bundle.prompts.every(isPromptDeclaration))
    return reject(operation, bundle.key, "malformed prompt declaration");
  const digests = [...new Set(bundle.prompts.map((prompt) => prompt.content_digest))];
  const stored = new Map((await db.query<PromptContent>(
    DIGESTS_SQL, [JSON.stringify(digests)]))
    .map((row) => [row.content_digest, row]));
  const resolved = new Map<string, PromptContent>();
  for (const prompt of bundle.prompts) {
    if (resolved.has(prompt.content_digest)) continue;
    const existing = stored.get(prompt.content_digest);
    if (existing) { resolved.set(prompt.content_digest, existing); continue; }
    const authored = readAuthoredPrompt(prompt);
    if (!authored.ok) return { ok: false, error: { ...authored.error, operation } };
    resolved.set(prompt.content_digest, authored.value);
  }
  return { ok: true, value: [...resolved.values()] };
}

/** Content-addressed and immutable: a repeated digest is already the same bytes. */
export async function storePromptContents(tx: SqlExecutor, prompts: readonly PromptContent[]): Promise<void> {
  for (const prompt of prompts)
    await tx.query("INSERT INTO authority.prompt_content (content_digest,content) VALUES ($1,$2) ON CONFLICT (content_digest) DO NOTHING",
      [prompt.content_digest, prompt.content]);
}

/** The stored text of each named prompt; a key with no stored content is an error, never a file read. */
export async function readStoredPrompts(tx: SqlExecutor, bundle: DefinitionBundle, keys: readonly string[]): Promise<Result<PromptTexts>> {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return { ok: true, value: new Map() };
  const declarations = new Map(bundle.prompts.map((prompt) => [prompt.key, prompt]));
  const missing_declaration = wanted.find((key) => !declarations.has(key));
  if (missing_declaration !== undefined) return reject("read_prompt", missing_declaration, "pinned prompt missing");
  const digests = wanted.map((key) => declarations.get(key)!.content_digest);
  const rows = await tx.query<PromptContent>(DIGESTS_SQL, [JSON.stringify(digests)]);
  const by_digest = new Map(rows.map((row) => [row.content_digest, row.content]));
  const texts = new Map<string, string>();
  for (const key of wanted) {
    const content = by_digest.get(declarations.get(key)!.content_digest);
    if (content === undefined) return reject("read_prompt", key, "pinned prompt content is not stored");
    texts.set(key, content);
  }
  return { ok: true, value: texts };
}
