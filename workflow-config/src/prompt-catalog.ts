import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

export interface PromptCatalogEntry {
  readonly key: string;
  readonly path: string;
  readonly content_digest: string;
}

/** Server-owned catalog of every regular prompt beneath the allowlisted root. */
export function listPromptCatalog(): PromptCatalogEntry[] {
  const root = realpathSync(process.env.OAKRIDGE_PROMPT_ROOT ?? repositoryRoot);
  const prompt_root = realpathSync(resolve(root, "workflow-config/prompts"));
  if (relative(root, prompt_root).split(sep).join("/") !== "workflow-config/prompts")
    throw new Error("prompt catalog root is outside the allowlist");
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  visit(prompt_root);
  return files.map((file): PromptCatalogEntry => {
    const path = relative(root, file).split(sep).join("/");
    return { key: path, path, content_digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
  }).sort((left, right) => left.path.localeCompare(right.path));
}
