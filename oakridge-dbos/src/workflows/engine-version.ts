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
  "storage/launch-receipts.ts",
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
 * injected services. Routes, projections, bundles and UI sources are outside
 * the engine manifest and do not change the recovery version.
 */
export function computeEngineVersion(workflows_dir: string = import.meta.dir): string {
  const hash = createHash("sha256");
  for (const name of [...ENGINE_SOURCE_MANIFEST].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(resolve(workflows_dir, "..", name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** An operator override for forks and rollbacks; otherwise the engine digest. */
export function selectApplicationVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.DBOS_APPLICATION_VERSION?.trim() || computeEngineVersion();
}
