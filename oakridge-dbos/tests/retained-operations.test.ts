import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { CoreClient } from "../src/core-client/client";
import { decodeCoreResponse } from "../src/core-client/core-types";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { githubIdentityFromRemote } from "../src/runtime/project-identity";
import { selectControlPlaneAccess } from "../src/http/control-auth";
import { silentDurationMs } from "../src/adapters/kbbl";
import { settingForRole } from "../src/effects/operations/selected-publication-contract";
import type { Workflow } from "../src/core-client/core-types";

const root = resolve(import.meta.dir, "../..");
const deletedPaths = [
  "oakridge-dbos/src/compiler/compile-v15.ts",
  "oakridge-dbos/src/decision",
  "oakridge-dbos/src/validation",
  "oakridge-dbos/src/runtime/run-launch-dispatch.ts",
  "oakridge-dbos/src/seed",
  "oakridge-dbos/src/adapters/dev-flow.ts",
  "oakridge-dbos/src/migrate.ts",
  "docs/v15-contracts",
  "docs/v15-storage-baseline-inventory.md",
  "docs/oakridge-v2-runbook.md",
  "oakridge-dbos/docs/v15-cutover.md",
  "docs/replacement",
];
const retainedPaths = [
  "oakridge-dbos/src/storage/migrate.ts",
  "oakridge-dbos/src/storage/migrations",
  "oakridge-dbos/src/runtime/compose.ts",
  "oakridge-dbos/src/workflows/topology.ts",
  "oakridge-dbos/src/workflows/engine-version.ts",
  "oakridge-dbos/src/http/app.ts",

  "oakridge-dbos/src/core-client/client.ts",
  "oakridge-dbos/src/core-client/core-types.ts",
  "oakridge-dbos/src/storage/sql-executor.ts",
  "oakridge-dbos/src/runtime/git-command-runner.ts",
  "oakridge-dbos/src/runtime/github-pull-requests.ts",
  "oakridge-dbos/src/runtime/project-identity.ts",
  "oakridge-dbos/src/http/control-auth.ts",
  "oakridge-dbos/src/adapters/kbbl.ts",
];

test("old interpreter paths are absent", () => {
  expect(deletedPaths.filter((path) => existsSync(resolve(root, path)))).toEqual([]);
});

test("every named leaf operation remains present", () => {
  expect(retainedPaths.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
});

test("only leaf support types remain in the former domain directory", () => {
  expect(readdirSync(resolve(root, "oakridge-dbos/src/domain")).sort()).toEqual([
    "delegated-session.ts", "execution.ts", "primitives.ts", "projects.ts",
    "pull-request.ts", "repository-provisioning.ts", "session-settings.ts", "workflow.ts",
  ]);
});

test("retained operations import and execute", async () => {
  expect(CoreClient.start({ wasm_path: "/nonexistent/workflow_evaluator.wasm" }).ok).toBe(false);
  expect(decodeCoreResponse(null)).toBeNull();
  const sql = PgPostgresExecutor.connect("postgres://localhost/oakridge");
  await sql.close();
  expect((await new BunGitCommandRunner().run(root, ["rev-parse", "--is-inside-work-tree"])).exit_code).toBe(0);
  const reader = new GithubPullRequestReader({ token: "test" }, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
  expect(await reader.read("owner", "repo", 1)).toEqual({ ok: true, value: null });
  expect(githubIdentityFromRemote("https://github.com/owner/repo.git")?.name).toBe("repo");
  expect(selectControlPlaneAccess({ host: "127.0.0.1", token: undefined, allow_insecure_non_loopback: false }).kind).toBe("loopback_open");
  expect(silentDurationMs({}, Date.now())).toBeNull();
});

test("v2 sample workers declare their kind without v1 provider routing", () => {
  const bundle = JSON.parse(readFileSync(resolve(root, "workflow-core/fixtures/bundles/fan-out.json"), "utf8")) as Workflow;
  const workers = Object.values(bundle.stages).flatMap((stage) => Object.values(stage.workers));
  expect(workers.length).toBeGreaterThan(0);
  expect(workers.every((worker) => worker.kind === "agent" || worker.kind === "code")).toBe(true);
  expect(JSON.stringify(bundle)).not.toMatch(/"provider_kind"|"input_contract"/);
});

// Provider literal ownership is enforced by provider-literal-lint.test.ts,
// including its sole named catalog exemption and positive controls.

if (false) {
  // @ts-expect-error an unrecognized setting role must fail at typecheck time
  settingForRole([], "unknown_role");
}
