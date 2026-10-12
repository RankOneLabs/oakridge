import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Workflow } from "../core-client/core-types";
import { traced, type Traced } from "../domain/primitives";
import type { PromptContent } from "../storage/registry-store";

/** Every prompt path a workflow names: each agent worker's modes and each review's prompt. */
export function selectPromptPaths(workflow: Workflow): readonly string[] {
  const paths = Object.values(workflow.stages).flatMap((stage) => [
    ...Object.values(stage.workers).flatMap((worker) => worker.kind === "agent" ? Object.values(worker.prompts) : []),
    ...Object.values(stage.reviews ?? {}).flatMap((review) => review.prompt ? [review.prompt] : []),
  ]);
  return [...new Set(paths)].sort();
}

const PROMPT_DIRECTORY = `workflow-config${sep}prompts${sep}`;
/**
 * Read one authored prompt, by its path relative to workflow-config/prompts.
 * The resolved file must stay inside that directory of the configured root.
 */
export function readAuthoredPrompt(path: string): Traced<PromptContent> {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes(".."))
    return traced("read_prompt", path, "prompt path is outside workflow-config/prompts");
  try {
    const root = realpathSync(process.env.OAKRIDGE_PROMPT_ROOT ?? resolve(import.meta.dir, "../../.."));
    const actual = realpathSync(resolve(root, "workflow-config/prompts", path));
    const inside = relative(root, actual);
    if (inside.startsWith("..") || isAbsolute(inside) || !inside.startsWith(PROMPT_DIRECTORY))
      return traced("read_prompt", path, "prompt path resolves outside workflow-config/prompts");
    const bytes = readFileSync(actual);
    return { ok: true, value: { content_digest: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("utf8") } };
  } catch (cause) { return traced("read_prompt", path, String(cause)); }
}

/** The text of every prompt a workflow names, by path, as it compiles and pins. */
export function readWorkflowPrompts(workflow: Workflow): Traced<{ readonly [path: string]: PromptContent }> {
  const prompts: { [path: string]: PromptContent } = {};
  for (const path of selectPromptPaths(workflow)) {
    const read = readAuthoredPrompt(path);
    if (!read.ok) return read;
    prompts[path] = read.value;
  }
  return { ok: true, value: prompts };
}
