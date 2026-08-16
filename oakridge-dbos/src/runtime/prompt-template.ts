import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface PromptTemplateLoader {
  load(path: string): Promise<string>;
}

export const createPromptTemplateLoader = (root: string): PromptTemplateLoader => {
  const resolvedRoot = resolve(root);
  return {
    async load(path: string): Promise<string> {
      const resolvedPath = resolve(resolvedRoot, path);
      if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
        throw new Error(`prompt template '${path}' is outside the configured prompt root`);
      }
      return readFile(resolvedPath, "utf8");
    },
  };
};
