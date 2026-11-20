import type { Result } from "canonical-json";

/**
 * A prompt names another authored prompt with `{{> path}}`, the path under
 * `workflow-config/prompts`. Includes are expanded when a definition is committed,
 * so a session receives the expanded text and its id covers every included byte.
 */
const INCLUDE = /\{\{>\s*([^{}\s]+)\s*\}\}/g;

/** Authored prompt text by its path under `workflow-config/prompts`. */
export interface PromptSourceTexts { readonly [authored_path: string]: string }
export type PromptIncludeFailureKind = "missing_include" | "include_cycle" | "expansion_too_large";
/** The most bytes one prompt may expand to; nested includes can otherwise double at every level. */
export const MAX_EXPANDED_PROMPT_BYTES = 1024 * 1024;
export interface PromptIncludeFailure {
  readonly operation: "expand_prompt";
  readonly kind: PromptIncludeFailureKind;
  /** The prompt being expanded when the include failed. */
  readonly entity_id: string;
  readonly detail: string;
}
/** Each referenced prompt's expanded text, and every authored prompt the expansion read. */
export interface ExpandedPrompts {
  readonly prompts: PromptSourceTexts;
  readonly sources: readonly string[];
}

/** The prompts this text includes directly, each once, in the order it first names them. */
export function selectIncludes(text: string): readonly string[] {
  return [...new Set([...text.matchAll(INCLUDE)].map((match) => match[1]))];
}

/** One trailing newline ends an included file; the include directive's own line supplies it. */
const includedText = (text: string): string => text.endsWith("\n") ? text.slice(0, -1) : text;

/** What every include in one expansion reads from and records into. */
interface PromptExpansion {
  readonly sources: PromptSourceTexts;
  /** Every authored prompt read so far. */
  readonly read: Set<string>;
  /** Each prompt already expanded, reused wherever it is included again. */
  readonly expanded: Map<string, string>;
}

function expandOne(path: string, chain: readonly string[], expansion: PromptExpansion): Result<string, PromptIncludeFailure> {
  const fail = (kind: PromptIncludeFailureKind, detail: string): Result<never, PromptIncludeFailure> =>
    ({ ok: false, error: { operation: "expand_prompt", kind, entity_id: chain[0] ?? path, detail } });
  if (chain.includes(path)) return fail("include_cycle", `prompt includes itself: ${[...chain, path].join(" -> ")}`);
  const known = expansion.expanded.get(path);
  if (known !== undefined) return { ok: true, value: known };
  if (!Object.hasOwn(expansion.sources, path)) return chain.length === 0
    ? fail("missing_include", `prompt ${path} is missing`)
    : fail("missing_include", `${chain.at(-1)} includes ${path}, which is missing`);
  expansion.read.add(path);
  const source = expansion.sources[path];
  const pieces: string[] = [];
  let bytes = 0;
  let position = 0;
  const append = (piece: string): boolean => {
    pieces.push(piece);
    bytes += Buffer.byteLength(piece);
    return bytes <= MAX_EXPANDED_PROMPT_BYTES;
  };
  const tooLarge = () => fail("expansion_too_large", `${path} expands past ${MAX_EXPANDED_PROMPT_BYTES} bytes`);
  for (const match of source.matchAll(INCLUDE)) {
    const included = expandOne(match[1], [...chain, path], expansion);
    if (!included.ok) return included;
    if (!append(source.slice(position, match.index)) || !append(includedText(included.value))) return tooLarge();
    position = match.index + match[0].length;
  }
  if (!append(source.slice(position))) return tooLarge();
  const value = pieces.join("");
  expansion.expanded.set(path, value);
  return { ok: true, value };
}

/** Expand every `{{> path}}` in each referenced prompt, failing on a missing file, a cycle, or an oversized expansion. */
export function expandPrompts(paths: readonly string[], sources: PromptSourceTexts): Result<ExpandedPrompts, PromptIncludeFailure> {
  const expansion: PromptExpansion = { sources, read: new Set(), expanded: new Map() };
  const prompts: [string, string][] = [];
  for (const path of paths) {
    const expanded = expandOne(path, [], expansion);
    if (!expanded.ok) return expanded;
    prompts.push([path, expanded.value]);
  }
  return { ok: true, value: { prompts: Object.fromEntries(prompts), sources: [...expansion.read].sort() } };
}
