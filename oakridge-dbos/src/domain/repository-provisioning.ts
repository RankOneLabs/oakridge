export interface GitCommandOutcome {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git command against a repository directory. Implemented at the IO edge. */
export interface GitCommandRunner {
  run(repository_path: string, args: readonly string[]): Promise<GitCommandOutcome>;
}
