import type { JsonValue } from "./primitives";
import { err, ok, type Result } from "./primitives";
import { readJsonPointer } from "./json-pointer";
import type { SlotBinding } from "./delegated-session";

/**
 * The git refs a run works against, and how a stage comes to hold them.
 *
 * The epic branch used to travel only inside `run_context` — named by
 * `prepare-run-context`, validated at launch, and read out again by a
 * `context_lookup` pointer buried in the build stage's worktree template. No
 * slot, no artifact type, no producer: four disconnected places agreeing by
 * convention that a branch would exist, and nothing anywhere that created it.
 *
 * So the refs are a typed artifact now, produced by a stage that guarantees
 * them and declared as an input by the stage that needs them. Existence is a
 * property of graph order rather than of an operator having run a git command
 * beforehand.
 */

/** The stage type, and the executor registered under the same key. */
export const PROVISION_REPOSITORY_REFS_STAGE_TYPE = "provision_repository_refs";

/** The artifact type the stage emits, one per repository. */
export const REPOSITORY_REFS_ARTIFACT_TYPE = "dev.repository_refs";

/**
 * One entry of a prepared run context's `/repositories`, exactly as
 * `prepareRunContext` writes it. This is the source the model mirrors: change
 * the shape there and this parser is what fails, rather than a pointer
 * somewhere downstream resolving to `undefined`.
 */
export interface RunContextRepository {
  readonly key: string;
  readonly path: string;
  readonly base_branch: string;
  readonly epic_branch: string;
}

/** Where a repository entry carries its key — the unit id the stage fans out on. */
export const RUN_CONTEXT_REPOSITORY_KEY_POINTER = "/key";

/** What one provisioned repository looks like once the stage has guaranteed it. */
export interface RepositoryRefs {
  readonly repository_key: string;
  readonly repository_path: string;
  readonly base_branch: string;
  readonly epic_branch: string;
  /** The commit the epic branch points at on origin, once it is known to exist. */
  readonly epic_head_sha: string;
}

export interface RunContextRepositoryError {
  readonly operation: "parse_run_context_repository";
  readonly detail: string;
}

const nonEmptyString = (value: JsonValue | undefined, field: string): Result<string, RunContextRepositoryError> =>
  typeof value === "string" && value.length > 0
    ? ok(value)
    : err({ operation: "parse_run_context_repository", detail: `repository '${field}' must be a non-empty string` });

/**
 * A repository entry, or the reason it is not one. Parsed rather than cast,
 * because the value arrives as an untyped fan-out parameter and the first place
 * a missing field would otherwise surface is a git command with an empty
 * argument.
 */
export const parseRunContextRepository = (value: JsonValue): Result<RunContextRepository, RunContextRepositoryError> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({ operation: "parse_run_context_repository", detail: "repository must be a JSON object" });
  }
  const key = nonEmptyString(readJsonPointer(value, "/key"), "key");
  if (!key.ok) return key;
  const path = nonEmptyString(readJsonPointer(value, "/path"), "path");
  if (!path.ok) return path;
  const baseBranch = nonEmptyString(readJsonPointer(value, "/base_branch"), "base_branch");
  if (!baseBranch.ok) return baseBranch;
  const epicBranch = nonEmptyString(readJsonPointer(value, "/epic_branch"), "epic_branch");
  if (!epicBranch.ok) return epicBranch;
  return ok({ key: key.value, path: path.value, base_branch: baseBranch.value, epic_branch: epicBranch.value });
};

/**
 * The epic branch a repository targets, from its configured name or the epic's
 * slug. One selector because two callers used to compute it — the epic profile
 * the operator reads and the run context the stages read — and a default that
 * drifts between them names two different branches for the same run.
 */
export const selectEpicBranch = (configured: string | null | undefined, slug: string): string =>
  configured ?? `epic/${slug}`;

/**
 * What the provisioning stage is configured with: where its repositories are,
 * and how many it may provision at once. Deliberately one knob and a location —
 * the entry shape is `RunContextRepository`, not a set of pointers a definition
 * gets to reinvent.
 */
export interface RepositoryProvisioningDefinitionConfig {
  readonly repositories: SlotBinding;
  readonly max_parallel: number;
}

/** What one provisioning unit resolves to, once its repository is in hand. */
export interface ResolvedRepositoryProvisioningConfig {
  readonly executor_type: typeof PROVISION_REPOSITORY_REFS_STAGE_TYPE;
  readonly output_name: string;
  readonly repository: RunContextRepository;
}

export interface ResolvedRepositoryProvisioningError {
  readonly operation: "parse_resolved_repository_provisioning";
  readonly detail: string;
}

/**
 * Reads a resolved config back off the wire. The execution request carries it
 * as `JsonValue` — it has been through the workflow journal — so the executor
 * narrows it rather than assuming the shape it was written with.
 */
export const parseResolvedRepositoryProvisioningConfig = (value: JsonValue): Result<ResolvedRepositoryProvisioningConfig, ResolvedRepositoryProvisioningError> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({ operation: "parse_resolved_repository_provisioning", detail: "resolved config must be a JSON object" });
  }
  if (readJsonPointer(value, "/executor_type") !== PROVISION_REPOSITORY_REFS_STAGE_TYPE) {
    return err({ operation: "parse_resolved_repository_provisioning", detail: `resolved config is not a '${PROVISION_REPOSITORY_REFS_STAGE_TYPE}' config` });
  }
  const outputName = readJsonPointer(value, "/output_name");
  if (typeof outputName !== "string" || outputName.length === 0) {
    return err({ operation: "parse_resolved_repository_provisioning", detail: "resolved config 'output_name' must be a non-empty string" });
  }
  const repository = readJsonPointer(value, "/repository");
  if (repository === undefined) return err({ operation: "parse_resolved_repository_provisioning", detail: "resolved config has no 'repository'" });
  const parsed = parseRunContextRepository(repository);
  if (!parsed.ok) return err({ operation: "parse_resolved_repository_provisioning", detail: parsed.error.detail });
  return ok({ executor_type: PROVISION_REPOSITORY_REFS_STAGE_TYPE, output_name: outputName, repository: parsed.value });
};
