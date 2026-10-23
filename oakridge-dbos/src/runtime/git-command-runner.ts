import type { GitCommandOutcome, GitCommandRunner, GitCommandOptions } from "../domain/repository-provisioning";

/** Runs git as a subprocess. The IO edge: every failure leaves here as a value. */
export class BunGitCommandRunner implements GitCommandRunner {
  async run(repository_path: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandOutcome> {
    if (options.signal?.aborted) return { exit_code: 130, stdout: "", stderr: "git operation aborted" };
    let child;
    try {
      child = Bun.spawn(["git", "-C", repository_path, ...args], { stdout: "pipe", stderr: "pipe", detached: true });
    } catch (error) {
      // A directory that does not exist fails here rather than in git itself.
      return { exit_code: 128, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    const abort = (): void => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (options.signal?.aborted) return { exit_code: 130, stdout, stderr: "git operation aborted" };
      return { exit_code: exitCode, stdout, stderr };
    } catch (error) {
      return { exit_code: 128, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
