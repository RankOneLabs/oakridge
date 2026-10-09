import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import type { ProjectId, ProjectRecord } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";
import { err, ok, type Result } from "../domain/primitives";

const isUniqueViolation = (cause: unknown): boolean =>
  !!cause && typeof cause === "object" && "code" in cause && cause.code === "23505";

/** A project id is supplied so an import keeps the identity it had before cutover. */
export async function createProject(db: SqlExecutor, id: ProjectId, draft: ProjectDraft): Promise<Result<ProjectRecord, ProjectWriteError>> {
  try {
    const rows = await db.query<ProjectRecord>(`INSERT INTO authority.project (id,name,repo_dir,forge_repository,integration_branch)
      VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`, [id, draft.name, draft.repo_dir, draft.forge_repository === null ? null : JSON.stringify(draft.forge_repository), draft.integration_branch]);
    return ok(rows[0]!);
  } catch (cause) {
    if (isUniqueViolation(cause)) return err({ kind: "duplicate_name", name: draft.name });
    throw cause;
  }
}

export async function updateProject(db: SqlExecutor, id: ProjectId, draft: ProjectDraft): Promise<Result<ProjectRecord, ProjectWriteError>> {
  try {
    const rows = await db.query<ProjectRecord>(`UPDATE authority.project SET name=$2,repo_dir=$3,forge_repository=$4::jsonb,integration_branch=$5
      WHERE id=$1 RETURNING *`, [id, draft.name, draft.repo_dir, draft.forge_repository === null ? null : JSON.stringify(draft.forge_repository), draft.integration_branch]);
    return rows[0] ? ok(rows[0]) : err({ kind: "missing", id });
  } catch (cause) {
    if (isUniqueViolation(cause)) return err({ kind: "duplicate_name", name: draft.name });
    throw cause;
  }
}
