import type { ProjectId } from "../domain/primitives";
import type { CreateProject, Project } from "../domain/projects";
import type { ProjectRepository } from "./repositories";
import type { SqlExecutor } from "./sql-executor";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly repo_dir: string;
  readonly created_at: string;
  readonly forge_repository: Project["forge_repository"];
  readonly base_branch: string | null;
}

const decodeProject = (row: ProjectRow): Project => ({ ...row, id: row.id as ProjectId });

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insert(project: CreateProject): Promise<Project> {
    const rows = await this.sql.query<ProjectRow>(
      `INSERT INTO oakridge.project (id, name, repo_dir, created_at, forge_repository, base_branch)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, $6)
       RETURNING id::text, name, repo_dir, created_at::text, forge_repository, base_branch`,
      [project.id, project.name, project.repo_dir, project.created_at, project.forge_repository, project.base_branch],
    );
    return decodeProject(rows[0]!);
  }

  async list(): Promise<readonly Project[]> {
    const rows = await this.sql.query<ProjectRow>(
      "SELECT id::text, name, repo_dir, created_at::text, forge_repository, base_branch FROM oakridge.project ORDER BY created_at, id",
      [],
    );
    return rows.map(decodeProject);
  }

  async find_by_id(id: ProjectId): Promise<Project | null> {
    const rows = await this.sql.query<ProjectRow>(
      "SELECT id::text, name, repo_dir, created_at::text, forge_repository, base_branch FROM oakridge.project WHERE id = $1",
      [id],
    );
    return rows[0] ? decodeProject(rows[0]) : null;
  }
}
