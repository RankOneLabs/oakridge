import type { Kysely } from "kysely";
import { err, ok, type ProjectId, type Result, type RunId } from "../domain/primitives";
import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import type { OperatorEventPayload } from "../projections/operator-event";
import type { DB } from "./db-types";
import { jsonText, type Database, type DatabaseTransaction } from "./database";
import type { ProjectRecord } from "./schema-records";

type Reader = Kysely<DB> | DatabaseTransaction;

const isUniqueViolation = (cause: unknown): boolean =>
  !!cause && typeof cause === "object" && "code" in cause && cause.code === "23505";

/** Project and visibility writes announce themselves on the operator stream in the same transaction. */
async function announce(trx: DatabaseTransaction, run_id: RunId | null, run_key: string, payload: OperatorEventPayload): Promise<void> {
  await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key,
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
