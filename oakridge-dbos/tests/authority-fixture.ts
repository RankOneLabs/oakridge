import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createScratchDatabase, type ScratchDatabase } from "../scripts/scratch-database";
import { CoreClient, compileWorkflow } from "../src/core-client/client";
import type { Event, Workflow, Writer } from "../src/core-client/core-types";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { readWorkflowPrompts } from "../src/runtime/prompt-files";
import { commitEvent, launchRunId, type CommitResult } from "../src/storage/commit";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { pinDefinition } from "../src/storage/registry-store";

/** A migrated scratch database on OAKRIDGE_TEST_DATABASE_URL's server and an in-process core. */
export interface Authority {
  readonly db: Database;
  readonly core: CoreClient;
  readonly url: string;
  close(): Promise<void>;
}

export function testServerUrl(): string {
  const url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  return url;
}

/** An empty scratch database, dropped by the returned function. */
export function scratchDatabase(): Promise<ScratchDatabase> {
  return createScratchDatabase(testServerUrl(), `oakridge_test_${crypto.randomUUID().replaceAll("-", "")}`);
}

export async function openAuthority(): Promise<Authority> {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  const started = CoreClient.start();
  if (!started.ok) throw new Error("core WASM did not load");
  const core = started.value;
  return { db, core, url: scratch.url, async close() { core.close(); await db.destroy(); await scratch.drop(); } };
}

const root = resolve(import.meta.dir, "../..");
export function sampleWorkflow(name: "review-loop" | "fan-out"): Workflow {
  return JSON.parse(readFileSync(resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), "utf8")) as Workflow;
}

/** Compile and pin a sample, as POST /api/definitions does. */
export function pinSample(authority: Pick<Authority, "db" | "core">, name: "review-loop" | "fan-out" = "review-loop"):
  Promise<{ readonly bundle_id: DefinitionBundleId; readonly digest: string }> {
  return pinWorkflow(authority, sampleWorkflow(name));
}
export async function pinWorkflow(authority: Pick<Authority, "db" | "core">, workflow: Workflow):
  Promise<{ readonly bundle_id: DefinitionBundleId; readonly digest: string }> {
  const prompts = readWorkflowPrompts(workflow);
  if (!prompts.ok) throw new Error(prompts.error.detail);
  const compiled = await compileWorkflow(authority.core, { workflow,
    prompts: Object.fromEntries(Object.entries(prompts.value).map(([path, prompt]) => [path, prompt.content])) });
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const pinned = await pinDefinition(authority.db, { source: workflow, compiled: compiled.value, prompts: prompts.value });
  return { bundle_id: pinned.bundle.id, digest: pinned.bundle.digest };
}

export const OPERATOR: Writer = { kind: "operator", subject: "credential:test" };
export const executor = (action: string): Writer => ({ kind: "executor", attempt: action });

export interface Submit { readonly run_id: RunId; readonly event: Event; readonly writer?: Writer; readonly ingress_id?: string | null }
/** Commit one event with a fresh ingress id unless one is given; wakes are recorded, not acted on. */
export function submitter(authority: Pick<Authority, "db" | "core">, wakes: RunId[] = []) {
  return (input: Submit): Promise<CommitResult> => commitEvent({ db: authority.db, core: authority.core, wake: (run_id) => { wakes.push(run_id); } },
    { run_id: input.run_id, ingress_id: input.ingress_id === undefined ? crypto.randomUUID() : input.ingress_id,
      event: input.event, writer: input.writer ?? OPERATOR });
}

/** Launch a pinned definition as POST /api/runs does. */
export async function launch(authority: Pick<Authority, "db" | "core">, input: { readonly bundle_id: DefinitionBundleId; readonly request_id: string; readonly input: unknown }):
  Promise<{ readonly run_id: RunId; readonly result: CommitResult }> {
  const run_id = launchRunId(input.request_id);
  const result = await commitEvent({ db: authority.db, core: authority.core, wake: () => undefined }, { run_id, ingress_id: input.request_id,
    event: { kind: "launched", input: input.input }, writer: OPERATOR, launch: { definition_bundle_id: input.bundle_id, project_id: null } });
  return { run_id, result };
}

/** The unit id of a top-level unit of a run. */
export const unitOf = (run_id: RunId, key: string): string => `${run_id}/${key}`;

/** The action id the core gave a worker's latest attempt in a run: action ids are hashes, so tests read them, never build them. */
export async function actionOf(authority: Pick<Authority, "db">, run_id: RunId, worker: string): Promise<string> {
  const attempt = await authority.db.selectFrom("authority.attempt").select("action_id").where("run_id", "=", run_id)
    .where("worker", "=", worker).orderBy("created_at", "desc").executeTakeFirst();
  if (!attempt) throw new Error(`${worker} has no attempt in ${run_id}`);
  return attempt.action_id;
}
