import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { listPromptCatalog } from "../../../workflow-config/src/prompt-catalog";
import type { Workflow } from "../core-client/core-types";
import type { PinnedPrompts } from "./json-column-types";
import type { Result } from "./commit";
import type { SqlExecutor } from "./sql-executor";

/**
 * A pinned definition owns its prompt bytes. A workflow names prompts by key
 * only; the key is resolved against the server-owned catalog once, when a
 * digest is first pinned, and the resulting key -> digest map is stored on the
 * definition row. Every later render reads the stored bytes, so editing or
 * regenerating a prompt file cannot change a definition that is already pinned.
 */
export interface PromptContent { readonly content_digest: string; readonly content: string }
/** Stored prompt text by prompt key, for the prompts one action renders. */
export type PromptTexts = ReadonlyMap<string, string>;
export interface ResolvedPrompts { readonly contents: readonly PromptContent[]; readonly pinned: PinnedPrompts }

// A JSON list keeps the parameter portable across both PostgreSQL drivers.
const DIGESTS_SQL = "SELECT content_digest,content FROM authority.prompt_content WHERE content_digest IN (SELECT jsonb_array_elements_text($1::jsonb))";

function reject(operation: string, entity_id: string, detail: string): Result<never> {
  return { ok: false, error: { operation, entity_id, detail } };
}

/** The allowlist is relative to the configured repository root. */
const PROMPT_PREFIX = `workflow-config${sep}prompts${sep}`;
/** Read a catalogued prompt file and verify it against the digest the catalog reported. */
export function readAuthoredPrompt(prompt: { readonly key: string; readonly path: string; readonly content_digest: string }): Result<PromptContent> {
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

/** Every prompt key a workflow names: each agent worker's prompts, and each operator review's prompt. */
export function workflowPromptKeys(workflow: Workflow): readonly string[] {
  const keys = new Set<string>();
  for (const stage of Object.values(workflow.stages)) {
    for (const worker of Object.values(stage.workers))
      if (worker.kind === "agent") for (const key of Object.values(worker.prompts)) keys.add(key);
    for (const review of Object.values(stage.reviews ?? {}))
      if (review.prompt != null) keys.add(review.prompt);
  }
  return [...keys].sort();
}

/**
 * Resolve every prompt key the workflow names against the catalog, returning
 * the bytes to store and the key -> digest map to pin on the definition.
 */
export function resolveWorkflowPrompts(workflow: Workflow, operation: string): Result<ResolvedPrompts> {
  let catalog: ReadonlyMap<string, { readonly key: string; readonly path: string; readonly content_digest: string }>;
  try { catalog = new Map(listPromptCatalog().map((entry) => [entry.key, entry])); }
  catch (cause) { return reject(operation, workflow.workflow, String(cause)); }
  const contents = new Map<string, PromptContent>();
  const pinned: Record<string, string> = {};
  for (const key of workflowPromptKeys(workflow)) {
    const entry = catalog.get(key);
    if (!entry) return reject(operation, key, "prompt key is not in the catalog");
    pinned[key] = entry.content_digest;
    if (contents.has(entry.content_digest)) continue;
    const authored = readAuthoredPrompt(entry);
    if (!authored.ok) return { ok: false, error: { ...authored.error, operation } };
    contents.set(entry.content_digest, authored.value);
  }
  return { ok: true, value: { contents: [...contents.values()], pinned } };
}

/** Content-addressed and immutable: a repeated digest is already the same bytes. */
export async function storePromptContents(tx: SqlExecutor, prompts: readonly PromptContent[]): Promise<void> {
  for (const prompt of prompts)
    await tx.query("INSERT INTO authority.prompt_content (content_digest,content) VALUES ($1,$2) ON CONFLICT (content_digest) DO NOTHING",
      [prompt.content_digest, prompt.content]);
}

/** The stored text of each named prompt; a key with no stored content is an error, never a file read. */
export async function readStoredPrompts(tx: SqlExecutor, pinned: PinnedPrompts, keys: readonly string[]): Promise<Result<PromptTexts>> {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return { ok: true, value: new Map() };
  const missing_declaration = wanted.find((key) => pinned[key] === undefined);
  if (missing_declaration !== undefined) return reject("read_prompt", missing_declaration, "pinned prompt missing");
  const rows = await tx.query<PromptContent>(DIGESTS_SQL, [JSON.stringify(wanted.map((key) => pinned[key]!))]);
  const by_digest = new Map(rows.map((row) => [row.content_digest, row.content]));
  const texts = new Map<string, string>();
  for (const key of wanted) {
    const content = by_digest.get(pinned[key]!);
    if (content === undefined) return reject("read_prompt", key, "pinned prompt content is not stored");
    texts.set(key, content);
  }
  return { ok: true, value: texts };
}
