import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runtime sources reachable from the workflows and their injected services:
 * the core client, mutation service, SQL executor and production provider.
 * The import-graph test checks this manifest when engine dependencies change.
 */
export const ENGINE_SOURCE_MANIFEST: readonly string[] = [
  "adapters/kbbl.ts",
  "core-client/bundle-content-hash.ts",
  "core-client/client.ts",
  "core-client/generated-contracts.ts",
  "core-client/observation-roots.ts",
  "core-client/transport-errors.ts",
  "domain/execution.ts",
  "domain/primitives.ts",
  "effects/evidence.ts",
  "effects/intents.ts",
  "effects/operations/production-provider.ts",
  "effects/operations/pull-request-observation.ts",
  "effects/operations/repository-preparation.ts",
  "effects/operations/selected-publication-contract.ts",
  "effects/operations/selected-request.ts",
  "effects/outcomes.ts",
  "effects/provider.ts",
  "effects/provider-catalog.ts",
  "projections/record-selectors.ts",
  "projections/scope-view.ts",
  "runtime/advance-children.ts",
  "runtime/git-command-runner.ts",
  "runtime/github-pull-requests.ts",
  "runtime/project-identity.ts",
  "storage/capacity.ts",
  "storage/child-cancellation.ts",
  "storage/command-selection.ts",
  "storage/commit.ts",
  "storage/effect-results.ts",
  "storage/effect-secret.ts",
  "storage/launch-receipts.ts",
  "storage/lifecycle-trigger.ts",
  "storage/mutation-service.ts",
  "storage/receipts.ts",
  "storage/revocation.ts",
  "storage/run-lifecycle.ts",
  "storage/snapshot-reader.ts",
  "storage/sql-executor.ts",
  "storage/stage-publications.ts",
  "storage/storage-validator.ts",
  "workflows/engine-version.ts",
  "workflows/topology.ts",
];

/**
 * The DBOS application version scopes workflow recovery: a process only resumes
 * PENDING workflows recorded under its own version. The version therefore has
 * to move when workflow behavior changes, including imported engine logic and
 * injected services, and when the Rust core binary changes. Routes,
 * projections, bundles and UI sources are outside the engine manifest and do
 * not change the recovery version.
 */
export function computeEngineSourceDigest(workflows_dir: string = import.meta.dir): string {
  const hash = createHash("sha256");
  for (const name of [...ENGINE_SOURCE_MANIFEST].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(resolve(workflows_dir, "..", name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The authority baseline is asserted independently of the TypeScript import graph. */
export function computeStorageBaselineDigest(workflows_dir: string = import.meta.dir): string {
  return createHash("sha256").update(readFileSync(resolve(workflows_dir, "../storage/migrations/0001_core_authority.sql"))).digest("hex");
}

/**
 * The Rust core decides every transition, so its build is part of the engine.
 * The digest covers the binary this process actually spawns, not the source
 * tree, so a stale build cannot share a version with the source it lags.
 */
export function computeCoreBinaryDigest(core_binary: string): string {
  return createHash("sha256").update(readFileSync(core_binary)).digest("hex");
}

export interface EngineVersionSources {
  readonly core_binary: string;
  readonly workflows_dir?: string;
}

export function computeEngineVersion(sources: EngineVersionSources): string {
  const workflows_dir = sources.workflows_dir ?? import.meta.dir;
  const hash = createHash("sha256");
  hash.update("engine-source\0");
  hash.update(computeEngineSourceDigest(workflows_dir));
  hash.update("\0storage-baseline\0");
  hash.update(computeStorageBaselineDigest(workflows_dir));
  hash.update("\0core-binary\0");
  hash.update(computeCoreBinaryDigest(sources.core_binary));
  return hash.digest("hex").slice(0, 16);
}

/** An operator override for forks and rollbacks; otherwise the engine digest. */
export function selectApplicationVersion(core_binary: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.DBOS_APPLICATION_VERSION?.trim() || computeEngineVersion({ core_binary });
}
