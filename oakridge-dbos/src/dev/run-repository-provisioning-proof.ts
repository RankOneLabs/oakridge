/**
 * Runs the repository provisioning transform against a real working copy.
 *
 * The end-to-end suite exercises this through the whole backend against a
 * fixture repository it builds itself. This proof points the same code at a
 * repository someone actually works in — a real remote, real credentials, real
 * refs — which is the part a fixture cannot stand in for.
 *
 * It pushes the epic branch to origin when it is absent. That is the feature,
 * and it is idempotent: run it twice and the second run adopts what the first
 * published rather than reseeding it.
 *
 *   REPOSITORY_PATH=/path/to/repo EPIC_BRANCH=epic/thing BASE_BRANCH=main \
 *     bun run src/dev/run-repository-provisioning-proof.ts
 */
import { describeRepositoryProvisioningFailure, provisionRepositoryRefs } from "../domain/repository-provisioning";
import type { RunContextRepository } from "../domain/repository-refs";
import { BunGitCommandRunner } from "../runtime/git-command-runner";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const repository: RunContextRepository = {
  key: process.env.REPOSITORY_KEY?.trim() || "proof",
  path: required("REPOSITORY_PATH"),
  integration_branch: process.env.INTEGRATION_BRANCH?.trim() || "main",
};

const provisioned = await provisionRepositoryRefs(
  { repository, base_branch: required("BASE_BRANCH") },
  new BunGitCommandRunner(),
);
if (!provisioned.ok) {
  console.log(`FAILED ${provisioned.error.kind}: ${describeRepositoryProvisioningFailure(provisioned.error)}`);
  process.exitCode = 1;
} else {
  console.log(`OK ${JSON.stringify(provisioned.value)}`);
}
