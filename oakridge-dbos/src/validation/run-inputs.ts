import { isAbsolute } from "node:path";
import { isLegalCohortKey } from "../decision/schedule-cohorts";
import { z } from "zod";
import type { V15RunInputs } from "../domain/dev-flow-v15";
import { err, ok, type Result, type RepositoryKey } from "../domain/primitives";

const settings = z.object({ runtime: z.enum(["codex", "claude-code"]), model: z.string().nullable(), effort: z.string().nullable() });
const branch = z.string().min(1).refine((value) => !/[\x00-\x20\x7f~^:?*\[\]\\]/.test(value)
  && !value.includes("..") && !value.includes("@{") && !value.includes("//")
  && !value.startsWith("/") && !value.startsWith("-") && !value.endsWith("/") && !value.endsWith(".")
  && value !== "@" && value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")), "invalid Git branch");
const repository = z.object({ key: z.string().refine(isLegalCohortKey), path: z.string().refine(isAbsolute), integration_branch: branch,
  forge_repository: z.object({ provider: z.literal("github"), owner: z.string().min(1), name: z.string().min(1) }).nullable() });
const inputs = z.object({ brief_notes: z.string(), base_branch: branch, repositories: z.array(repository).min(1).refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, "repository keys must be unique"),
  builder: settings, planner: settings, oakridge_url: z.string().url() });
export interface V15RuntimeContext extends V15RunInputs { readonly oakridge_url: string }
export interface RunInputError { readonly operation: "validate_run_inputs"; readonly detail: string }
export const parseRunInputs = (source: unknown): Result<V15RuntimeContext, RunInputError> => {
  const parsed = inputs.safeParse(source);
  if (!parsed.success) return err({ operation: "validate_run_inputs", detail: parsed.error.message });
  return ok({ ...parsed.data, repositories: parsed.data.repositories.map((repository) => ({
    ...repository, key: repository.key as RepositoryKey,
  })) });
};
