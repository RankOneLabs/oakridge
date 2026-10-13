import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { CoreClient } from "../src/core-client/client";
import { decodeCoreResponse } from "../src/core-client/core-types";
import { openDatabase } from "../src/storage/database";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { githubIdentityFromRemote } from "../src/runtime/project-identity";
import { selectControlPlaneAccess } from "../src/http/control-auth";
import { silentDurationMs } from "../src/adapters/kbbl";
import type { Workflow } from "../src/core-client/core-types";

const root = resolve(import.meta.dir, "../..");
const retainedPaths = [
  "oakridge-dbos/src/storage/migrate.ts",
  "oakridge-dbos/src/storage/migrations",
  "oakridge-dbos/src/runtime/compose.ts",
  "oakridge-dbos/src/workflows/topology.ts",
  "oakridge-dbos/src/workflows/engine-version.ts",
  "oakridge-dbos/src/http/app.ts",

  "oakridge-dbos/src/core-client/client.ts",
  "oakridge-dbos/src/core-client/core-types.ts",
  "oakridge-dbos/src/storage/database.ts",
  "oakridge-dbos/src/runtime/git-command-runner.ts",
  "oakridge-dbos/src/runtime/github-pull-requests.ts",
  "oakridge-dbos/src/runtime/project-identity.ts",
  "oakridge-dbos/src/http/control-auth.ts",
  "oakridge-dbos/src/adapters/kbbl.ts",
];

test("every named leaf operation remains present", () => {
  expect(retainedPaths.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
});

test("the domain directory holds only leaf support types", () => {
  expect(readdirSync(resolve(root, "oakridge-dbos/src/domain")).sort()).toEqual([
    "delegated-session.ts", "effect-instruction.ts", "primitives.ts", "projects.ts", "prompt-template.ts",
    "pull-request.ts", "repository-provisioning.ts", "workflow.ts",
  ]);
});

test("retained operations import and execute", async () => {
  expect(CoreClient.start({ wasm_path: "/nonexistent/workflow_evaluator.wasm" }).ok).toBe(false);
  expect(decodeCoreResponse(null)).toBeNull();
  await openDatabase("postgres://localhost/oakridge").destroy();
  expect((await new BunGitCommandRunner().run(root, ["rev-parse", "--is-inside-work-tree"])).exit_code).toBe(0);
  const reader = new GithubPullRequestReader({ token: "test" }, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
  expect(await reader.read("owner", "repo", 1)).toEqual({ ok: true, value: null });
  expect(githubIdentityFromRemote("https://github.com/owner/repo.git")?.name).toBe("repo");
  expect(selectControlPlaneAccess({ host: "127.0.0.1", token: undefined, allow_insecure_non_loopback: false }).kind).toBe("loopback_open");
  expect(silentDurationMs({}, Date.now())).toBeNull();
});

test("sample workers declare their kind", () => {
  const bundle = JSON.parse(readFileSync(resolve(root, "workflow-core/fixtures/bundles/fan-out.json"), "utf8")) as Workflow;
  const workers = Object.values(bundle.stages).flatMap((stage) => Object.values(stage.workers));
  expect(workers.length).toBeGreaterThan(0);
  expect(workers.every((worker) => worker.kind === "agent" || worker.kind === "code")).toBe(true);
});

// Provider literal ownership is enforced by provider-literal-lint.test.ts,
// including its sole named catalog exemption and positive controls.
