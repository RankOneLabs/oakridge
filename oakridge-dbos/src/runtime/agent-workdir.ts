import { mkdirSync } from "node:fs";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { traced, type Traced } from "../domain/primitives";

/**
 * Make the directory a `workspace: none` session runs in usable by kbbl,
 * which cuts every session a worktree and so needs a git repository with a
 * commit to branch from. An empty repository with one empty commit keeps such
 * a session out of any real checkout. Idempotent: an existing repository with
 * a head is left as it is.
 */
export async function prepareAgentWorkdir(path: string, git: GitCommandRunner): Promise<Traced<string>> {
  try { mkdirSync(path, { recursive: true }); }
  catch (cause) { return traced("prepare_agent_workdir", path, String(cause)); }
  if ((await git.run(path, ["rev-parse", "--verify", "--quiet", "HEAD"])).exit_code === 0) return { ok: true, value: path };
  const init = await git.run(path, ["init", "--quiet"]);
  if (init.exit_code !== 0) return traced("prepare_agent_workdir", path, `git init failed: ${init.stderr.trim()}`);
  const commit = await git.run(path, ["-c", "user.name=oakridge", "-c", "user.email=oakridge@localhost", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "Oakridge agent workdir"]);
  if (commit.exit_code !== 0) return traced("prepare_agent_workdir", path, `git commit failed: ${commit.stderr.trim()}`);
  return { ok: true, value: path };
}
