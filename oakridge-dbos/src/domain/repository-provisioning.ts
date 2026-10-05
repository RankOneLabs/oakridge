export interface GitCommandOutcome {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git command against a repository directory. Implemented at the IO edge. */
export interface GitCommandOptions { readonly signal?: AbortSignal }
export interface GitCommandRunner {
  run(repository_path: string, args: readonly string[], options?: GitCommandOptions): Promise<GitCommandOutcome>;
}
