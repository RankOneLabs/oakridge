/**
 * The v15 storage cutover deliberately removes the v14 repositories and DBOS
 * topology. Cohort c8 will compose their v15 replacements here.
 *
 * Keeping this typed boundary lets process and harness callers compile while
 * making an attempted launch fail immediately with the actual unavailable
 * capability, rather than through a missing-module error.
 */
import type { Hono } from "hono";

import type { ExecutorAdapter } from "../domain/execution";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { CohortPollOutcome, PullRequestReader } from "./github-pull-requests";

export interface OakridgeRuntimeConfig {
  readonly database_url: string;
  readonly application_version: string;
  readonly executor_adapters: readonly ExecutorAdapter[];
  readonly prompt_template_directory: string;
  readonly control_token?: string;
  readonly git_commands?: GitCommandRunner;
  readonly pull_request_reader?: PullRequestReader;
  readonly now?: () => string;
}

export interface OakridgeRuntime {
  readonly app: Hono;
  dispatch_launches(): Promise<number>;
  seed_builtins(): Promise<void>;
  poll_pull_requests(): Promise<readonly CohortPollOutcome[] | null>;
  orphaned_version_runs(): Promise<readonly OrphanedVersionRuns[]>;
  close(): Promise<void>;
}

export const createOakridgeRuntime = async (_config: OakridgeRuntimeConfig): Promise<OakridgeRuntime> => {
  throw new Error("Oakridge v15 runtime composition is unavailable until cohort c8");
};
