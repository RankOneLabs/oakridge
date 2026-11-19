import type { Result } from "canonical-json";

/**
 * A prompt names another authored prompt with `{{> path}}`, the path under
 * `workflow-config/prompts`. Includes are expanded when a definition is committed,
 * so a session receives the expanded text and its id covers every included byte.
 */
const INCLUDE = /\{\{>\s*([^{}\s]+)\s*\}\}/g;

/** Authored prompt text by its path under `workflow-config/prompts`. */
export interface PromptSourceTexts { readonly [authored_path: string]: string }
export type PromptIncludeFailureKind = "missing_include" | "include_cycle";
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

/** One trailing newline ends an included file; the include directive's own line supplies it. */
const includedText = (text: string): string => text.endsWith("\n") ? text.slice(0, -1) : text;

function expandOne(path: string, sources: PromptSourceTexts, chain: readonly string[], read: Set<string>): Result<string, PromptIncludeFailure> {
  const fail = (kind: PromptIncludeFailureKind, detail: string): Result<never, PromptIncludeFailure> =>
    ({ ok: false, error: { operation: "expand_prompt", kind, entity_id: chain[0] ?? path, detail } });
  if (chain.includes(path)) return fail("include_cycle", `prompt includes itself: ${[...chain, path].join(" -> ")}`);
  if (!Object.hasOwn(sources, path)) return chain.length === 0
    ? fail("missing_include", `prompt ${path} is missing`)
    : fail("missing_include", `${chain.at(-1)} includes ${path}, which is missing`);
  read.add(path);
  let expanded = "";
  let position = 0;
  for (const match of sources[path].matchAll(INCLUDE)) {
    const included = expandOne(match[1], sources, [...chain, path], read);
    if (!included.ok) return included;
    expanded += sources[path].slice(position, match.index) + includedText(included.value);
    position = match.index + match[0].length;
  }
  return { ok: true, value: expanded + sources[path].slice(position) };
}

/** Expand every `{{> path}}` in each referenced prompt, failing on a missing file or a cycle. */
export function expandPrompts(paths: readonly string[], sources: PromptSourceTexts): Result<ExpandedPrompts, PromptIncludeFailure> {
  const read = new Set<string>();
  const prompts: [string, string][] = [];
  for (const path of paths) {
    const expanded = expandOne(path, sources, [], read);
    if (!expanded.ok) return expanded;
    prompts.push([path, expanded.value]);
  }
  return { ok: true, value: { prompts: Object.fromEntries(prompts), sources: [...read].sort() } };
}
