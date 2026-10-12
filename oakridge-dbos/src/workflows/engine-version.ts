import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_WASM_PATH } from "../core-client/client";

/**
 * Runtime sources reachable from the workflows and their injected services:
 * the core client, the storage factory and stores, commit, and the production
 * provider. The import-graph test checks this manifest when engine
 * dependencies change.
 */
export const ENGINE_SOURCE_MANIFEST: readonly string[] = [
  "core-client/client.ts",
  "core-client/core-types.ts",
  "domain/effect-instruction.ts",
  "domain/primitives.ts",
  "effects/operations/production-provider.ts",
  "effects/outcomes.ts",
  "effects/provider-catalog.ts",
  "projections/run-view.ts",
  "storage/commit.ts",
  "storage/database.ts",
  "storage/executor-store.ts",
  "storage/read-store.ts",
  "storage/registry-store.ts",
  "storage/snapshot-store.ts",
  "workflows/engine-version.ts",
  "workflows/topology.ts",
];

/**
 * The DBOS application version scopes workflow recovery: a process only resumes
 * PENDING workflows recorded under its own version. The version therefore has
 * to move when workflow behavior changes, including imported engine logic and
 * injected services, and when the Rust WASM module changes. Routes,
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
  return createHash("sha256").update(readFileSync(resolve(workflows_dir, "../storage/migrations/0001_core.sql"))).digest("hex");
}

/**
 * The Rust core decides every transition, so its build is part of the engine.
 * The digest covers the WASM module loaded by the Bun host.
 */
export function computeCoreWasmDigest(wasm_path: string = CORE_WASM_PATH): string {
  return createHash("sha256").update(readFileSync(wasm_path)).digest("hex");
}

export interface EngineVersionSources {
  readonly wasm_path?: string;
  readonly workflows_dir?: string;
}

export function computeEngineVersion(sources: EngineVersionSources): string {
  const workflows_dir = sources.workflows_dir ?? import.meta.dir;
  const hash = createHash("sha256");
  hash.update("engine-source\0");
  hash.update(computeEngineSourceDigest(workflows_dir));
  hash.update("\0storage-baseline\0");
  hash.update(computeStorageBaselineDigest(workflows_dir));
  hash.update("\0core-wasm\0");
  hash.update(computeCoreWasmDigest(sources.wasm_path));
  return hash.digest("hex").slice(0, 16);
}

/** An operator override for forks and rollbacks; otherwise the engine digest. */
export function selectApplicationVersion(wasm_path: string = CORE_WASM_PATH, env: NodeJS.ProcessEnv = process.env): string {
  return env.DBOS_APPLICATION_VERSION?.trim() || computeEngineVersion({ wasm_path });
}
