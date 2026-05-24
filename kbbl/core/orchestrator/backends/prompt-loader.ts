import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// kbbl package root: three levels up from this file's directory
// (backends/ → orchestrator/ → core/ → kbbl/)
const kbblRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function loadPrompt(name: string): string {
  const promptsDir = process.env.KBBL_PROMPTS_DIR ?? join(kbblRoot, "prompts");
  return readFileSync(join(promptsDir, name), "utf8");
}

export function renderPrompt(template: string, slots: Record<string, string>): string {
  // Validate against the template, not the rendered output: user-supplied
  // content interpolated via slots (e.g. BRIEF_RENDERED) may legitimately
  // contain literal `{{X}}` text — that must not be mistaken for an
  // unfilled slot in the template itself.
  const slotPattern = /\{\{([^}]+)\}\}/g;
  for (const match of template.matchAll(slotPattern)) {
    const key = match[1]!;
    if (!Object.hasOwn(slots, key)) {
      throw new Error(`unfilled prompt slot: {{${key}}}`);
    }
  }
  return template.replace(slotPattern, (_match, key: string) => slots[key]!);
}
