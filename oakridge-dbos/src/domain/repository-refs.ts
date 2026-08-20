import type { JsonValue } from "./primitives";
import { err, ok, type Result } from "./primitives";
import { readJsonPointer } from "./json-pointer";
import type { SlotBinding } from "./delegated-session";

/**
 * The branches a run works against, and how a stage comes to hold them.
 *
 * Three exist, and two of them used to be called "base":
 *
 *   | role | was | who makes it | who targets it |
 *   |------|-----|--------------|----------------|
 *   | integration | `base_branch` | pre-existing (`main`) | the run's final pull request |
 *   | base        | `epic_branch` | this stage | every build unit's pull request |
 *   | working     | `cohort/…`    | a build unit's worktree | nothing; it is the head |
 *
 * So `base_branch` meant `main` in the final-integration checks and meant
 * `epic/<slug>` in the cohort ones, and the build agent was handed both under
 * slots that both read "base". A stage that picked the wrong one opened its
 * pull request against the wrong target.
 *
 * One name per role now. A run has exactly **one base branch** — everything it
 * builds stacks on that, and every unit's pull request targets it — and each
 * build unit gets **one working branch**. `main` is not a base from the run's
 * point of view at all; it is where the base branch was cut from and where the
 * finished work merges back, so it is the integration branch, and only final
 * integration ever needs to look at it.
 *
 * The refs are a typed artifact, produced by a stage that guarantees them and
 * declared as an input by every stage that needs them. Existence is a property
 * of graph order rather than of an operator having run a git command
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
 *
 * It carries no base branch. There is one for the whole run, and an entry that
 * could name its own was an entry that could disagree with its siblings.
 */
export interface RunContextRepository {
  readonly key: string;
  readonly path: string;
  /** Where this repository's base branch is cut from, and where its work merges back. */
  readonly integration_branch: string;
}

/** Where a repository entry carries its key — the unit id the stage fans out on. */
export const RUN_CONTEXT_REPOSITORY_KEY_POINTER = "/key";

/** What one provisioned repository looks like once the stage has guaranteed it. */
export interface RepositoryRefs {
  readonly repository_key: string;
  readonly repository_path: string;
  /** `main`, or whatever this repository merges finished work back into. */
  readonly integration_branch: string;
  /** The run's one base branch, now known to exist on origin in this repository. */
  readonly base_branch: string;
  /** The commit the base branch points at on origin, once it is known to exist. */
  readonly base_head_sha: string;
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
  const integrationBranch = nonEmptyString(readJsonPointer(value, "/integration_branch"), "integration_branch");
  if (!integrationBranch.ok) return integrationBranch;
  return ok({ key: key.value, path: path.value, integration_branch: integrationBranch.value });
};

/**
 * The one branch a run builds on, from its configured name or the epic's slug.
 *
 * One selector because two callers used to compute it — the epic profile the
 * operator reads and the run context the stages read — and a default that
 * drifts between them names two different branches for the same run. Now there
 * is also only one *value*: it was overridable per repository, so a two-repo
 * run could carry two different base branches and nothing in the flow could
 * express which one a stage meant.
 */
export const selectBaseBranch = (configured: string | null | undefined, slug: string): string =>
  configured ?? `epic/${slug}`;

export interface BaseBranchError {
  readonly operation: "parse_base_branch";
  readonly detail: string;
}

/**
 * A branch name, or why the resolved value is not one.
 *
 * The provisioning stage's `base_branch` is a binding, and binding resolution
 * stringifies whatever it finds — so a run context carrying `base_branch: null`
 * resolved to the string `"null"` and this stage pushed a branch by that name.
 * The launch gate cannot catch it: a present-but-null key satisfies the pointer
 * that reads it, deliberately, because `planner_effort: null` means "the
 * runtime's default". A branch name has no such reading, so it is parsed where
 * it is used rather than assumed from where it entered.
 */
export const parseBaseBranch = (value: JsonValue): Result<string, BaseBranchError> =>
  typeof value === "string" && value.trim() !== ""
    ? ok(value)
    : err({ operation: "parse_base_branch", detail: `base branch must resolve to a non-empty string, got ${JSON.stringify(value)}` });

/**
 * What the provisioning stage is configured with: where its repositories are,
 * which branch to guarantee in each, and how many it may do at once.
 * Deliberately one knob and two locations — the entry shape is
 * `RunContextRepository`, not a set of pointers a definition gets to reinvent.
 */
export interface RepositoryProvisioningDefinitionConfig {
  readonly repositories: SlotBinding;
  readonly base_branch: SlotBinding;
  readonly max_parallel: number;
}

/** What one provisioning unit resolves to, once its repository is in hand. */
export interface ResolvedRepositoryProvisioningConfig {
  readonly executor_type: typeof PROVISION_REPOSITORY_REFS_STAGE_TYPE;
  readonly output_name: string;
  readonly repository: RunContextRepository;
  readonly base_branch: string;
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
  const baseBranch = readJsonPointer(value, "/base_branch");
  if (typeof baseBranch !== "string" || baseBranch.length === 0) {
    return err({ operation: "parse_resolved_repository_provisioning", detail: "resolved config 'base_branch' must be a non-empty string" });
  }
  const repository = readJsonPointer(value, "/repository");
  if (repository === undefined) return err({ operation: "parse_resolved_repository_provisioning", detail: "resolved config has no 'repository'" });
  const parsed = parseRunContextRepository(repository);
  if (!parsed.ok) return err({ operation: "parse_resolved_repository_provisioning", detail: parsed.error.detail });
  return ok({ executor_type: PROVISION_REPOSITORY_REFS_STAGE_TYPE, output_name: outputName, repository: parsed.value, base_branch: baseBranch });
};
