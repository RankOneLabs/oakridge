import type { Kysely } from "kysely";
import type { CompiledWorkflow, Workflow } from "../core-client/core-types";
import { err, ok, type DefinitionBundleId, type ProjectId, type Result, type RunId } from "../domain/primitives";
import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import type { OperatorEventPayload } from "../projections/operator-event";
import type { DB } from "./db-types";
import { anyOf, jsonText, type Database, type DatabaseTransaction } from "./database";
import type { DefinitionBundleRecord, ProjectRecord } from "./schema-records";

type Reader = Kysely<DB> | DatabaseTransaction;

/** Prompt text keyed by its sha256 content digest. */
export interface PromptContent { readonly content_digest: string; readonly content: string }

const isUniqueViolation = (cause: unknown): boolean =>
  !!cause && typeof cause === "object" && "code" in cause && cause.code === "23505";

/** Registry and visibility writes announce themselves on the operator stream in the same transaction. */
async function announce(trx: DatabaseTransaction, run_id: RunId | null, run_key: string, payload: OperatorEventPayload): Promise<void> {
  await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key, event_key: payload.kind,
    payload: jsonText(payload) }).execute();
}

// ------------------------------------------------------------- projects -----

export async function listProjects(db: Reader): Promise<readonly ProjectRecord[]> {
  return await db.selectFrom("authority.project").selectAll().orderBy("name").orderBy("id").execute() as ProjectRecord[];
}

export async function createProject(db: Database, draft: ProjectDraft): Promise<Result<ProjectRecord, ProjectWriteError>> {
  const id = crypto.randomUUID() as ProjectId;
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto("authority.project").values({ id, name: draft.name, repo_dir: draft.repo_dir,
        forge_repository: draft.forge_repository === null ? null : jsonText(draft.forge_repository),
        integration_branch: draft.integration_branch }).returningAll().executeTakeFirstOrThrow();
      await announce(trx, null, id, { kind: "invalidate", data: { target: "projects", run_id: null } });
      return ok(row as ProjectRecord);
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) return err({ kind: "duplicate_name", name: draft.name });
    throw cause;
  }
}

export async function updateProject(db: Database, id: ProjectId, draft: ProjectDraft): Promise<Result<ProjectRecord, ProjectWriteError>> {
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx.updateTable("authority.project").set({ name: draft.name, repo_dir: draft.repo_dir,
        forge_repository: draft.forge_repository === null ? null : jsonText(draft.forge_repository),
        integration_branch: draft.integration_branch }).where("id", "=", id).returningAll().executeTakeFirst();
      if (!row) return err({ kind: "missing", id });
      await announce(trx, null, id, { kind: "invalidate", data: { target: "projects", run_id: null } });
      return ok(row as ProjectRecord);
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) return err({ kind: "duplicate_name", name: draft.name });
    throw cause;
  }
}

export async function hasProject(db: Reader, id: ProjectId): Promise<boolean> {
  return (await db.selectFrom("authority.project").select("id").where("id", "=", id).executeTakeFirst()) !== undefined;
}

// ---------------------------------------------------------- definitions -----

export interface DefinitionPin {
  readonly source: Workflow;
  readonly compiled: CompiledWorkflow;
  /** Every prompt the source names, by path, with the text it compiled against. */
  readonly prompts: { readonly [path: string]: PromptContent };
}
export type PinnedBundle = { readonly kind: "pinned" | "existing"; readonly bundle: DefinitionBundleRecord };

/**
 * Pin a compiled workflow: its prompt texts are stored content-addressed and
 * the bundle records path -> digest (D9), so editing a prompt file afterwards
 * cannot change what this definition renders. A digest pinned before is
 * returned as it stands.
 */
export async function pinDefinition(db: Database, pin: DefinitionPin): Promise<PinnedBundle> {
  return db.transaction().execute(async (trx) => {
    const contents = Object.values(pin.prompts);
    if (contents.length) await trx.insertInto("authority.prompt_content").values(contents.map((prompt) => ({ ...prompt })))
      .onConflict((conflict) => conflict.column("content_digest").doNothing()).execute();
    const prompts = Object.fromEntries(Object.entries(pin.prompts).map(([path, prompt]) => [path, prompt.content_digest]));
    const inserted = await trx.insertInto("authority.definition_bundle").values({ id: crypto.randomUUID(), digest: pin.compiled.digest,
      source: jsonText(pin.source), checked_program: jsonText(pin.compiled), prompts: jsonText(prompts) })
      .onConflict((conflict) => conflict.column("digest").doNothing()).returningAll().executeTakeFirst();
    if (inserted) {
      await announce(trx, null, inserted.id, { kind: "invalidate", data: { target: "definitions", run_id: null } });
      return { kind: "pinned", bundle: inserted as DefinitionBundleRecord };
    }
    const existing = await trx.selectFrom("authority.definition_bundle").selectAll().where("digest", "=", pin.compiled.digest).executeTakeFirstOrThrow();
    return { kind: "existing", bundle: existing as DefinitionBundleRecord };
  });
}

/** The unarchived definition a launch by digest pins to. */
export async function findLaunchableDefinition(db: Reader, digest: string): Promise<DefinitionBundleId | null> {
  const row = await db.selectFrom("authority.definition_bundle").select("id")
    .where("digest", "=", digest).where("archived_at", "is", null).executeTakeFirst();
  return (row?.id ?? null) as DefinitionBundleId | null;
}

/** Stored prompt text by content digest; a digest with no stored content is absent from the map. */
export async function readPromptTexts(db: Reader, digests: readonly string[]): Promise<ReadonlyMap<string, string>> {
  if (digests.length === 0) return new Map();
  const rows = await db.selectFrom("authority.prompt_content").select(["content_digest", "content"])
    .where("content_digest", "=", anyOf([...new Set(digests)])).execute();
  return new Map(rows.map((row) => [row.content_digest, row.content]));
}

// ------------------------------------------------------------ archiving -----

/** An archived definition is hidden from the catalog; runs already pinned to it continue. */
export async function setDefinitionArchived(db: Database, bundle_id: string, is_archived: boolean): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.updateTable("authority.definition_bundle")
      .set((eb) => ({ archived_at: is_archived ? eb.fn.coalesce("archived_at", eb.fn<Date>("now")) : null }))
      .where("id", "=", bundle_id).returning("id").executeTakeFirst();
    if (!row) return false;
    await announce(trx, null, bundle_id, { kind: "invalidate", data: { target: "definitions", run_id: null } });
    return true;
  });
}

/** Archiving hides a run from the operator's listings; its units, effects and history are untouched. */
export async function setRunArchived(db: Database, run_id: RunId, is_archived: boolean): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.updateTable("authority.run")
      .set((eb) => ({ archived_at: is_archived ? eb.fn.coalesce("archived_at", eb.fn<Date>("now")) : null }))
      .where("id", "=", run_id).returning("id").executeTakeFirst();
    if (!row) return false;
    await announce(trx, run_id, run_id, { kind: "invalidate", data: { target: "run", run_id } });
    return true;
  });
}
