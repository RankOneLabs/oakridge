import { Database } from "bun:sqlite";

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  created_at: string;
}

export function insertProject(
  db: Database,
  { id, name, repo_path }: { id: string; name: string; repo_path: string },
): Project {
  return db
    .prepare<Project, [string, string, string]>(
      "INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?) RETURNING *",
    )
    .get(id, name, repo_path)!;
}

export function getProject(db: Database, id: string): Project | null {
  return db.prepare<Project, [string]>("SELECT * FROM projects WHERE id = ?").get(id) ?? null;
}

export function listProjects(db: Database): Project[] {
  return db.prepare<Project, []>("SELECT * FROM projects ORDER BY created_at, id").all();
}
