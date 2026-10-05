import type { GitCommandOutcome, GitCommandRunner, GitCommandOptions } from "../domain/repository-provisioning";

/**
 * Bounded so a wedged or unreachable remote cannot hold a unit open forever.
 * Generous compared to a local read because the provisioning commands talk to
 * origin — an `ls-remote` over SSH to a cold host is seconds, not milliseconds.
 */
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface BunGitCommandRunnerOptions { readonly timeout_ms?: number }

/** Runs git as a subprocess. The IO edge: every failure leaves here as a value. */
export class BunGitCommandRunner implements GitCommandRunner {
  private readonly timeoutMs: number;

  constructor(options: BunGitCommandRunnerOptions = {}) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  async run(repository_path: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandOutcome> {
    if (options.signal?.aborted) return { exit_code: 130, stdout: "", stderr: "git operation aborted" };
    let child;
    try {
      child = Bun.spawn(["git", "-C", repository_path, ...args], { stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      // A directory that does not exist fails here rather than in git itself.
      return { exit_code: 128, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    const abort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, this.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (options.signal?.aborted) return { exit_code: 130, stdout, stderr: "git operation aborted" };
      if (timedOut) return { exit_code: exitCode === 0 ? 124 : exitCode, stdout, stderr: `timed out after ${this.timeoutMs}ms${stderr ? `: ${stderr}` : ""}` };
      return { exit_code: exitCode, stdout, stderr };
    } catch (error) {
      return { exit_code: 128, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
