import type { RepositoryFile, RepositoryFileRequest, RepositoryReader } from "../ports/artifact-source";

const COMMIT = /^[0-9a-f]{7,64}$/i;
const GIT_TIMEOUT_MS = 10_000;

interface GitOutput { readonly code: number | null; readonly stdout: Uint8Array; readonly stderr: string }
type Git = (repository_path: string, args: readonly string[]) => Promise<GitOutput | null>;

/** The IO boundary: a git that cannot be spawned is reported as null, never thrown. */
const spawnGit: Git = async (repository_path, args) => {
  try {
    const child = Bun.spawn(["git", "-C", repository_path, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore",
      timeout: GIT_TIMEOUT_MS, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_TERMINAL_PROMPT: "0" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout: new Uint8Array(stdout), stderr };
  } catch { return null; }
};

/** A path inside the commit's tree. Parent steps and absolute paths never address one. */
const isTreePath = (path: string): boolean => path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");

/** Whether `git ls-tree -z` output holds an entry for exactly this path. */
const listsPath = (listing: Uint8Array, path: string): boolean =>
  new TextDecoder().decode(listing).split("\0").some((entry) => entry.slice(entry.indexOf("\t") + 1) === path);

/** A NUL byte marks a file binary, as git itself treats one, and no JSON text stored as jsonb can hold it. */
const isBinary = (bytes: Uint8Array): boolean => bytes.includes(0);
/** File bytes as the evidence that can carry them: text content, or only the size of a binary file. */
const fileOf = (bytes: Uint8Array): RepositoryFile => isBinary(bytes) ? { state: "binary", byte_size: bytes.byteLength }
  : { state: "present", content: new TextDecoder().decode(bytes) };

/**
 * Reads files at an exact commit with `git ls-tree` and `git cat-file`, never from a worktree. A readable commit
 * without the path is `absent`, which is evidence; a repository, commit, tree or object that cannot be read
 * is `unavailable`, which makes the question that needed it wait. A binary file is `binary`: present, sized, not copied.
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
      // Listing the path's entry tells absence apart from a tree git cannot read: an empty listing
      // is absence, a failed one is unavailability.
      const listed = await git(repository_path, ["--literal-pathspecs", "ls-tree", "-z", commit_sha, "--", path]);
      if (!listed) return { state: "unavailable", detail: "git could not be run" };
      if (listed.code !== 0) return { state: "unavailable", detail: listed.stderr.trim() || `the tree of ${commit_sha} could not be read` };
      if (!listsPath(listed.stdout, path)) return { state: "absent" };
      const content = await git(repository_path, ["cat-file", "-p", `${commit_sha}:${path}`]);
      return content?.code === 0 ? fileOf(content.stdout)
        : { state: "unavailable", detail: content?.stderr.trim() || "git could not be run" };
    },
  };
}
