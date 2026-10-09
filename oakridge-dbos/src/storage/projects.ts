import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import type { ProjectId, ProjectRecord } from "./schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { err, ok, type Result } from "../domain/primitives";
import type { SessionPolicy } from "../domain/session-settings";

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

export type SessionPolicyWriteError = { readonly kind: "missing"; readonly id: ProjectId }
  | { readonly kind: "stale_version"; readonly expected: number; readonly actual: number };

/** Serialize every affected run before changing the project policy. */
export async function setSessionPolicy(db: TransactionalSqlExecutor, id: ProjectId, policy: SessionPolicy): Promise<Result<SessionPolicy, SessionPolicyWriteError>> {
  return db.transaction(async (tx) => {
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE project_id=$1 ORDER BY id", [id]);
    for (const run of runs) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run.id]);
    const current = (await tx.query<{ session_policy: SessionPolicy | null }>("SELECT session_policy FROM authority.project WHERE id=$1 FOR UPDATE", [id]))[0];
    if (!current) return err({ kind: "missing", id });
    const version = current.session_policy?.version ?? 0;
    if (policy.version !== version + 1) return err({ kind: "stale_version", expected: version + 1, actual: policy.version });
    await tx.query("UPDATE authority.project SET session_policy=$2 WHERE id=$1", [id, JSON.stringify(policy)]);
    return ok(policy);
  });
}
