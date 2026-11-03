import { githubIdentityFromRemote } from "../src/runtime/project-identity";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import type { GitCommandOutcome, GitCommandRunner, GitCommandOptions } from "../src/domain/repository-provisioning";

interface McpReply { readonly error?: unknown; readonly result?: { readonly isError?: boolean } }
const protocol = "2025-03-26";

/** Verification needs an existing base; every remote fetch goes through gated-review. */
export class LiveSourceGit implements GitCommandRunner {
  private readonly local = new BunGitCommandRunner();
  constructor(private readonly endpoint: string) {}

  async fetch(repository_path: string, refspec: string, signal?: AbortSignal): Promise<void> {
    const remote = await this.local.run(repository_path, ["remote", "get-url", "origin"]);
    const repository = githubIdentityFromRemote(remote.stdout);
    if (!repository) throw new Error("source repository requires a GitHub origin");
    let session: string | null = null;
    const post = (body: unknown) => fetch(this.endpoint, { method: "POST", signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": protocol } : {}) }, body: JSON.stringify(body) });
    try {
      const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: protocol, capabilities: {}, clientInfo: { name: "oakridge-live-source", version: "1" } } });
      if (!initialized.ok) throw new Error(`gated-review initialize HTTP ${initialized.status}`);
      session = initialized.headers.get("mcp-session-id");
      await initialized.json();
      if (!session) throw new Error("gated-review returned no session");
      const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (!notified.ok) throw new Error(`gated-review initialized HTTP ${notified.status}`);
      const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "git.fetch", arguments: { repository: `${repository.owner}/${repository.name}`, repo_path: repository_path, refspec } } });
      if (!response.ok) throw new Error(`gated-review git.fetch HTTP ${response.status}`);
      const result = await response.json() as McpReply;
      if (!result.result || result.error || result.result.isError) throw new Error("gated-review refused source-base fetch");
    } finally {
      if (session) await fetch(this.endpoint, { method: "DELETE", headers: { "mcp-session-id": session } }).catch(() => undefined);
    }
  }

  async run(path: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandOutcome> {
    try {
      if (args[0] === "fetch") {
        if (args[1] !== "origin" || args.length !== 3) throw new Error("unsupported verification fetch");
        await this.fetch(path, args[2]!, options.signal);
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        const branch = args[2]?.replace(/^refs\/heads\//, "");
        if (args[1] !== "origin" || !branch) throw new Error("unsupported source-base lookup");
        await this.fetch(path, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, options.signal);
        const head = await this.local.run(path, ["rev-parse", `refs/remotes/origin/${branch}`], options);
        return head.exit_code === 0 ? { ...head, stdout: `${head.stdout.trim()}\trefs/heads/${branch}\n` } : head;
      }
      if (["push", "pull", "clone"].includes(args[0] ?? "")) throw new Error("verification never creates or changes a remote branch");
      return this.local.run(path, args, options);
    } catch (cause) { return { exit_code: 1, stdout: "", stderr: String(cause) }; }
  }
}
