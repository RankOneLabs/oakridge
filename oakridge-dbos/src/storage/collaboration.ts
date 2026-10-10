import type { SqlExecutor } from "./sql-executor";

/** The linear artifact_revision predecessor chain, as stored by the authority. */
export interface RevisionCollaborationNode {
  readonly id: string;
  readonly predecessor_id: string | null;
  readonly execution_id: string | null;
}

/** Nearest agent-produced revision reachable from the reviewed revision. */
export interface RevisionCollaborationTarget {
  readonly revision_id: string;
  readonly execution_id: string;
}

export function revisionCollaborationTarget(reviewed_revision_id: string,
  revisions: readonly RevisionCollaborationNode[]): RevisionCollaborationTarget | null {
  const by_id = new Map(revisions.map((revision) => [revision.id, revision]));
  const visited = new Set<string>();
  let id: string | null = reviewed_revision_id;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const revision: RevisionCollaborationNode | undefined = by_id.get(id);
    if (!revision) return null;
    if (revision.execution_id !== null) return { revision_id: revision.id, execution_id: revision.execution_id };
    id = revision.predecessor_id;
  }
  return null;
}

export async function readRevisionCollaborationTarget(db: SqlExecutor, run_id: string,
  reviewed_revision_id: string): Promise<RevisionCollaborationTarget | null> {
  const rows = await db.query<RevisionCollaborationNode>(`WITH RECURSIVE predecessors AS (
    SELECT id,predecessor_id,execution_id,0 AS depth FROM authority.artifact_revision WHERE run_id=$1 AND id=$2
    UNION ALL
    SELECT r.id,r.predecessor_id,r.execution_id,p.depth+1 FROM authority.artifact_revision r
      JOIN predecessors p ON r.id=p.predecessor_id WHERE r.run_id=$1
  ) SELECT id,predecessor_id,execution_id FROM predecessors ORDER BY depth`, [run_id, reviewed_revision_id]);
  return revisionCollaborationTarget(reviewed_revision_id, rows);
}
