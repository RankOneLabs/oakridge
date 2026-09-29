import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { WorkflowDefinition, PromptBundle, PromptBundleEntry } from "../domain/workflow";

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

/** Load and content-address the complete role × launch-reason matrix. */
export const createPromptBundle = async (definition: WorkflowDefinition, loader: PromptTemplateLoader): Promise<PromptBundle> => {
  const unique = new Map<string, PromptBundleEntry>();
  for (const stage of Object.values(definition.graph.stages)) {
    if (stage.stage_type !== "delegated_session") continue;
    const config = stage.config as { readonly prompt_matrix?: readonly Omit<PromptBundleEntry, "content">[] };
    for (const entry of config.prompt_matrix ?? []) {
      const content = await loader.load(entry.template_path);
      unique.set(`${entry.session_role}:${entry.launch_reason}`, { ...entry, content });
    }
  }
  const matrix = [...unique.values()].sort((left, right) => `${left.session_role}:${left.launch_reason}`.localeCompare(`${right.session_role}:${right.launch_reason}`));
  const hash = createHash("sha256").update(JSON.stringify(matrix)).digest("hex");
  return { version: 1, hash, matrix };
};
