import { resolve } from "node:path";

async function git(path: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * Gives a test repository a bare origin on disk that already holds `branches`
 * (cut from its current head), so `repository.prepare` finds the run's base
 * branch without reaching GitHub. The GitHub URL stays as the push URL, which
 * is where the operation reads the repository's identity. The origin lives
 * inside the repository's `.git`, so removing the repository removes it.
 */
export async function addLocalOrigin(repository: string, github_url: string, branches: readonly string[]): Promise<string> {
  const origin = resolve(repository, ".git", "origin.git");
  await git(repository, "clone", "-q", "--bare", repository, origin);
  for (const branch of branches) await git(origin, "branch", "-f", branch, "HEAD");
  await git(repository, "remote", "add", "origin", origin);
  await git(repository, "remote", "set-url", "--push", "origin", github_url);
  return origin;
}

/** Moves `branch` on a bare origin to a new empty commit, as a merge into it would. */
export async function advanceOrigin(origin: string, branch: string): Promise<string> {
  const next = await git(origin, "-c", "user.email=e2e@oakridge.test", "-c", "user.name=e2e", "commit-tree", `${branch}^{tree}`, "-p", branch, "-m", "next");
  await git(origin, "update-ref", `refs/heads/${branch}`, next);
  return next;
}
