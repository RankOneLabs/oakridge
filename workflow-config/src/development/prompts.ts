import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Prompt } from "../source-contracts";
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
