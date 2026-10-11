import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { Prompt, WorkflowDefinitionDescriptor } from "../source-contracts";
import { STAGE_TABLE, type StageTable } from "./run/stage-table";

export interface PromptSpec {
  readonly key: string;
  readonly path: string;
  readonly template_path: string;
  readonly stage: string;
  readonly action: string;
  readonly context: string;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");

export interface PromptCatalogEntry { readonly key: string; readonly path: string; readonly content_digest: string }

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
    const generated = path.match(/^workflow-config\/prompts\/dev-flow\/v3\/(.*)\.md$/);
    return { key: generated ? `${generated[1]}_v3` : path,
      path, content_digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export type PromptResolution = { readonly ok: true; readonly value: WorkflowDefinitionDescriptor }
  | { readonly ok: false; readonly key: string; readonly detail: string };

export function resolvePromptKeys(bundle: WorkflowDefinitionDescriptor): PromptResolution {
  const catalog = new Map(listPromptCatalog().map((prompt) => [prompt.key, prompt]));
  const prompts: Prompt[] = [];
  for (const prompt of bundle.prompts) {
    const found = catalog.get(prompt.key);
    if (!found) return { ok: false, key: prompt.key, detail: "prompt key is not in the catalog" };
    prompts.push({ ...prompt, path: found.path, content_digest: found.content_digest });
  }
  return { ok: true, value: { ...bundle, prompts } };
}

export function promptSpecs(table: StageTable = STAGE_TABLE): PromptSpec[] {
  return table.flatMap((stage) => stage.prompt_groups.flatMap((group) => group.actions.map((action) => ({
    key: `${group.prefix}_${action}_v3`,
    path: `workflow-config/prompts/dev-flow/v3/${group.prefix}_${action}.md`,
    template_path: `workflow-config/prompts/templates/${group.template}.md`,
    stage: stage.key,
    action,
    context: group.context,
  }))));
}

export function renderPrompt(spec: PromptSpec): Buffer {
  const template = readFileSync(resolve(repositoryRoot, spec.template_path), "utf8");
  return Buffer.from(`${template}\nStage: ${spec.stage}\nAction: ${spec.action.replaceAll("_", " ")}\nContext: ${spec.context}\n`);
}

/** In check mode, generated prompt drift is reported before bundle digests are read. */
export function renderPromptFiles(check: boolean, table: StageTable = STAGE_TABLE): string[] {
  const drift: string[] = [];
  for (const spec of promptSpecs(table)) {
    const path = resolve(repositoryRoot, spec.path);
    const expected = renderPrompt(spec);
    if (check) {
      try { if (!readFileSync(path).equals(expected)) drift.push(spec.path); }
      catch { drift.push(spec.path); }
    } else writeFileSync(path, expected);
  }
  return drift;
}

export function buildPrompts(table: StageTable = STAGE_TABLE): Prompt[] {
  return promptSpecs(table).map((spec) => ({
    key: spec.key,
    path: spec.path,
    input_schema: "session_action",
    content_digest: createHash("sha256").update(readFileSync(resolve(repositoryRoot, spec.path))).digest("hex")
  }));
}
