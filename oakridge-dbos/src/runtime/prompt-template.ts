import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PromptTemplateLoader {
  load(path: string): Promise<string>;
}

export const createPromptTemplateLoader = (root: string): PromptTemplateLoader => {
  const resolvedRoot = resolve(root);
  return {
    async load(path: string): Promise<string> {
      const resolvedPath = resolve(resolvedRoot, path);
      const relativePath = relative(resolvedRoot, resolvedPath);
      const isOutsideRoot =
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath);
      if (isOutsideRoot) {
        throw new Error(`prompt template '${path}' is outside the configured prompt root`);
      }
      return readFile(resolvedPath, "utf8");
    },
  };
};
