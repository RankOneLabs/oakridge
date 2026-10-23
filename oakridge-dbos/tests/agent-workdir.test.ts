import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareAgentWorkdir } from "../src/runtime/agent-workdir";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";

test("the agent workdir becomes a repository with a head kbbl can branch from, and preparing it again changes nothing", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-agent-workdir-"));
  const git = new BunGitCommandRunner();
  try {
    const path = resolve(root, "agents");
    const first = await prepareAgentWorkdir(path, git);
    const head = (await git.run(path, ["rev-parse", "HEAD"])).stdout.trim();
    const again = await prepareAgentWorkdir(path, git);
    expect({ first: first.ok, again: again.ok, has_head: /^[0-9a-f]{40}$/.test(head),
      unchanged: (await git.run(path, ["rev-parse", "HEAD"])).stdout.trim() === head }).toEqual({ first: true, again: true, has_head: true, unchanged: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
