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
  const result = template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) =>
    Object.hasOwn(slots, key) ? slots[key]! : match,
  );
  const remaining = /\{\{[^}]+\}\}/.exec(result);
  if (remaining) {
    throw new Error(`unfilled prompt slot: ${remaining[0]}`);
  }
  return result;
}
