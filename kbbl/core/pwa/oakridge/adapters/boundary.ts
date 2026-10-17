import type { Project, ProjectId, ProjectUpdateError } from "../types";
import type { Result } from "../../lib/result";

interface ResponseParseError {
  operation: string;
  detail: string;
}

interface RawProject extends Omit<Project, "id"> {
  readonly id: string;
  readonly integration_branch?: string | null;
}
const ok = <T>(value: T): Result<T, ResponseParseError> => ({ ok: true, value });
const err = (operation: string, detail: string): Result<never, ResponseParseError> => ({ ok: false, error: { operation, detail } });

export const projectUpdateError = (path: string, detail: string): Result<never, ProjectUpdateError> => ({
  ok: false,
  error: { operation: "update project", path, detail },
});

export const parseProject = (value: unknown): Result<Project, ResponseParseError> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse project", "response was not an object");
  const project = value as Partial<RawProject>;
  if (typeof project.id !== "string" || !project.id.trim()) return err("parse project", "response contained an empty project id");
  if (typeof project.name !== "string") return err("parse project", "response contained an invalid project name");
  if (typeof project.repo_dir !== "string") return err("parse project", "response contained an invalid repository path");
  if (typeof project.created_at !== "string") return err("parse project", "response contained an invalid creation time");
  if (project.base_branch !== null && project.base_branch !== undefined && typeof project.base_branch !== "string") {
    return err("parse project", "response contained an invalid base branch");
  }
  if (project.integration_branch !== null && project.integration_branch !== undefined && typeof project.integration_branch !== "string") {
    return err("parse project", "response contained an invalid integration branch");
  }
  const forge = project.forge_repository;
  if (forge !== null && forge !== undefined && (typeof forge !== "object" || forge.provider !== "github"
      || typeof forge.owner !== "string" || typeof forge.name !== "string")) {
    return err("parse project", "response contained an invalid forge repository");
  }
  return ok({ ...project, id: project.id as ProjectId, base_branch: project.integration_branch ?? project.base_branch ?? null } as Project);
};

/**
 * The reason a request failed, in whichever field the route used to say it.
 *
 * Most routes answer `{ error }`, but the typed domain results answer
 * `{ kind, detail }` — a refused run delete says
 * `{ kind: "active_conflict", detail: "run has an active DBOS workflow attempt" }`.
 * Reading only `error` threw that away and showed a bare status code, so a
 * delete that the server had explained precisely looked to the operator like it
 * was simply broken.
 */
export function selectFailureDetail(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as { readonly error?: unknown; readonly detail?: unknown; readonly kind?: unknown };
  if (typeof candidate.error === "string" && candidate.error.length > 0) return candidate.error;
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) return candidate.detail;
  if (typeof candidate.kind === "string" && candidate.kind.length > 0) return candidate.kind;
  return fallback;
}
