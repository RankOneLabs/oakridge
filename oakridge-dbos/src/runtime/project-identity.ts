import type { ProjectRepositoryIdentity, ProjectRepositoryIdentityResolver } from "../domain/projects";

const GIT_TIMEOUT_MS = 2_000;

export const githubIdentityFromRemote = (remoteValue: string): ProjectRepositoryIdentity["forge_repository"] | null => {
  const remote = remoteValue.trim().replace(/\/+$/, "");
  const prefixes = ["git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/"];
  const prefix = prefixes.find((candidate) => remote.startsWith(candidate));
  if (!prefix) return null;
  const path = remote.slice(prefix.length).replace(/\.git$/, "");
  const segments = path.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { provider: "github", owner: segments[0], name: segments[1] };
};

const gitOutput = async (repoDir: string, args: readonly string[]): Promise<string | null> => {
  const process = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process.kill(); }, GIT_TIMEOUT_MS);
  try {
    const exitCode = await process.exited;
    if (timedOut || exitCode !== 0) return null;
    return (await new Response(process.stdout).text()).trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export class GitProjectRepositoryIdentityResolver implements ProjectRepositoryIdentityResolver {
  constructor(private readonly git_output: (repo_dir: string, args: readonly string[]) => Promise<string | null> = gitOutput) {}

  async resolve(repoDir: string): Promise<ProjectRepositoryIdentity | null> {
    const remote = await this.git_output(repoDir, ["remote", "get-url", "origin"]);
    if (!remote) return null;
    const forgeRepository = githubIdentityFromRemote(remote);
    if (!forgeRepository) return null;
    const symbolicHead = await this.git_output(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const baseBranch = symbolicHead?.startsWith("origin/") ? symbolicHead.slice("origin/".length) || null : null;
    return { forge_repository: forgeRepository, base_branch: baseBranch };
  }
}
