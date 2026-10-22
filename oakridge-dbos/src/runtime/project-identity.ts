import type { ForgeRepository } from "../storage/json-column-types";
import type { ProjectRepositoryIdentity } from "../domain/projects";

const GIT_TIMEOUT_MS = 2_000;

export function githubIdentityFromRemote(value: string): ForgeRepository | null {
  const remote = value.trim().replace(/\/+$/, "");
  const prefix = ["git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/"]
    .find((candidate) => remote.startsWith(candidate));
  if (!prefix) return null;
  const segments = remote.slice(prefix.length).replace(/\.git$/, "").split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { provider: "github", owner: segments[0], name: segments[1] };
}

async function gitOutput(repo_dir: string, args: readonly string[]): Promise<string | null> {
  const child = Bun.spawn(["git", "-C", repo_dir, ...args], { stdout: "pipe", stderr: "ignore" });
  let timed_out = false;
  const timer = setTimeout(() => { timed_out = true; child.kill(); }, GIT_TIMEOUT_MS);
  try {
    const code = await child.exited;
    return timed_out || code !== 0 ? null : (await new Response(child.stdout).text()).trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveProjectRepositoryIdentity(repo_dir: string,
  git_output: (repo_dir: string, args: readonly string[]) => Promise<string | null> = gitOutput): Promise<ProjectRepositoryIdentity | null> {
  const remote = await git_output(repo_dir, ["remote", "get-url", "origin"]);
  if (!remote) return null;
  const forge_repository = githubIdentityFromRemote(remote);
  if (!forge_repository) return null;
  const symbolic_head = await git_output(repo_dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const integration_branch = symbolic_head?.startsWith("origin/") ? symbolic_head.slice("origin/".length) || null : null;
  return { forge_repository, integration_branch };
}
