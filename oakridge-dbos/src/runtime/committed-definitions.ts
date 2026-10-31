import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileWorkflow, type CoreClient } from "../core-client/client";
import type { DefinitionBundleId } from "../domain/primitives";
import { isWorkflowOutline } from "../http/app";
import type { Database } from "../storage/database";
import { pinDefinition, setLaunchableDefinitions } from "../storage/registry-store";
import { LAUNCHABLE_WORKFLOWS } from "../../../workflow-config/src/workflow-sources";
import { readWorkflowPrompts, selectConfigRoot } from "./prompt-files";

export interface CommittedDefinition { readonly workflow: string; readonly bundle_id: DefinitionBundleId; readonly digest: string }

/**
 * Pin every launchable workflow from its committed JSON
 * (`workflow-core/fixtures/bundles/<name>.json`) and prompt files, and make
 * those the only launchable definitions. Run at boot, so a deploy launches
 * exactly what it ships. A workflow that does not read or compile fails the
 * boot rather than leaving the previous definition launchable.
 */
export async function pinCommittedDefinitions(db: Database, core: CoreClient): Promise<readonly CommittedDefinition[]> {
  const root = selectConfigRoot();
  const pinned: CommittedDefinition[] = [];
  for (const workflow of LAUNCHABLE_WORKFLOWS) {
    const path = resolve(root, "workflow-core/fixtures/bundles", `${workflow}.json`);
    const source: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isWorkflowOutline(source)) throw new Error(`${path} is not a workflow`);
    const prompts = readWorkflowPrompts(source);
    if (!prompts.ok) throw new Error(`${path}: ${prompts.error.entity_id}: ${prompts.error.detail}`);
    const texts = Object.fromEntries(Object.entries(prompts.value).map(([prompt, content]) => [prompt, content.content]));
    const compiled = await compileWorkflow(core, { workflow: source, prompts: texts });
    if (!compiled.ok) throw new Error(`${path} does not compile: ${compiled.error.detail}`);
    const { bundle } = await pinDefinition(db, { source, compiled: compiled.value, prompts: prompts.value });
    pinned.push({ workflow, bundle_id: bundle.id, digest: bundle.digest });
  }
  await setLaunchableDefinitions(db, pinned.map((definition) => definition.bundle_id));
  return pinned;
}
