import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The DBOS application version scopes workflow recovery: a process only resumes
 * PENDING workflows recorded under its own version. The version therefore has
 * to move exactly when the workflow functions change — not when a bundle, a
 * route, a projection or the operator UI changes — or a deploy strands every
 * in-flight run for nothing. The workflow functions all live in this
 * directory, so the version is a digest of this directory's sources.
 */
export function computeEngineVersion(workflows_dir: string = import.meta.dir): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(workflows_dir).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts")).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(workflows_dir, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** An operator override for forks and rollbacks; otherwise the engine digest. */
export function selectApplicationVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.DBOS_APPLICATION_VERSION?.trim() || computeEngineVersion();
}
