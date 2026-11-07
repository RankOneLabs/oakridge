import type { RepositoryFile, RepositoryFileRequest, RepositoryReader } from "../ports/artifact-source";

const COMMIT = /^[0-9a-f]{7,64}$/i;
const GIT_TIMEOUT_MS = 10_000;

interface GitOutput { readonly code: number | null; readonly stdout: string; readonly stderr: string }
type Git = (repository_path: string, args: readonly string[]) => Promise<GitOutput | null>;

/** The IO boundary: a git that cannot be spawned is reported as null, never thrown. */
const spawnGit: Git = async (repository_path, args) => {
  try {
    const child = Bun.spawn(["git", "-C", repository_path, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore",
      timeout: GIT_TIMEOUT_MS, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_TERMINAL_PROMPT: "0" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } catch { return null; }
};

/** A path inside the commit's tree. Parent steps and absolute paths never address one. */
const isTreePath = (path: string): boolean => path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");

/**
 * Reads files at an exact commit with `git cat-file`, never from a worktree. A readable commit
 * without the path is `absent`, which is evidence; a repository or commit that cannot be read is
 * `unavailable`, which makes the question that needed it wait.
 */
export function createGitRepositoryReader(git: Git = spawnGit): RepositoryReader {
  const hasCommit = async (repository_path: string, commit_sha: string): Promise<boolean> =>
    COMMIT.test(commit_sha) && (await git(repository_path, ["cat-file", "-e", `${commit_sha}^{commit}`]))?.code === 0;
  return {
    hasCommit,
    async readFile({ repository_path, commit_sha, path }: RepositoryFileRequest): Promise<RepositoryFile> {
      if (!await hasCommit(repository_path, commit_sha))
        return { state: "unavailable", detail: `commit ${commit_sha} is not readable in ${repository_path}` };
      if (!isTreePath(path)) return { state: "absent" };
      const object = `${commit_sha}:${path}`;
      const kind = await git(repository_path, ["cat-file", "-t", object]);
      if (!kind) return { state: "unavailable", detail: "git could not be run" };
      if (kind.code !== 0) return { state: "absent" };
      const content = await git(repository_path, ["cat-file", "-p", object]);
      return content?.code === 0 ? { state: "present", content: content.stdout }
        : { state: "unavailable", detail: content?.stderr.trim() || "git could not be run" };
    },
  };
}
