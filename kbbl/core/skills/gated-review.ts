import type { RuntimeId } from "../runtime";
import type { ArgSpec, Skill } from "./types";

export const GATED_REVIEW_MCP_URL = "http://otto:3555/mcp";
export const GATED_REVIEW_SERVER_NAME = "gated-review";

export type McpArgumentValue = string | number | boolean;
export type McpArguments = Record<string, McpArgumentValue>;

export type GatedReviewToolName =
  | "review.get_state"
  | "review.list_actions"
  | "open_pr"
  | "reply_to_thread"
  | "resolve_thread"
  | "request_next_round"
  | "git.push"
  | "git.pull"
  | "git.fetch"
  | "get_review_round"
  | "pr_status";

const GATED_REVIEW_TOOL_ALIASES: Readonly<Record<string, GatedReviewToolName>> = {
  git_push: "git.push",
  git_pull: "git.pull",
  git_fetch: "git.fetch",
};

export function canonicalGatedReviewToolName(name: string): string {
  return GATED_REVIEW_TOOL_ALIASES[name] ?? name;
}

interface GatedReviewToolSpec {
  name: GatedReviewToolName;
  description: string;
  args: ArgSpec[];
}

const stringArg = (key: string, required: boolean, hint: string): ArgSpec => ({
  key,
  required,
  hint,
  kind: "string",
});

const integerArg = (key: string, required: boolean, hint: string): ArgSpec => ({
  key,
  required,
  hint,
  kind: "integer",
});

const booleanArg = (key: string, hint: string): ArgSpec => ({
  key,
  required: false,
  hint,
  kind: "boolean",
});

/**
 * Curated from gated-review's MCP tools/list response. Repository and worktree
 * arguments are not exposed in the UI: kbbl binds them to the live session.
 */
export const GATED_REVIEW_TOOL_SPECS: readonly GatedReviewToolSpec[] = [
  {
    name: "review.get_state",
    description: "Read the current state of a gated review.",
    args: [stringArg("reviewId", true, "review id")],
  },
  {
    name: "review.list_actions",
    description: "List the actions recorded for a gated review.",
    args: [stringArg("reviewId", true, "review id")],
  },
  {
    name: "open_pr",
    description: "Open a pull request through the gated-review MCP server.",
    args: [
      stringArg("base", false, "base branch (main)"),
      stringArg("head", false, "head branch (current)"),
      stringArg("title", true, "pull request title"),
      stringArg("body", false, "pull request body"),
      booleanArg("draft", "open as draft"),
    ],
  },
  {
    name: "reply_to_thread",
    description: "Reply to a pull request review thread.",
    args: [
      stringArg("threadId", true, "review thread id"),
      stringArg("body", true, "reply"),
    ],
  },
  {
    name: "resolve_thread",
    description: "Resolve a handled pull request review thread.",
    args: [stringArg("threadId", true, "review thread id")],
  },
  {
    name: "request_next_round",
    description: "Request the next gated review round.",
    args: [integerArg("pullRequestNumber", true, "pull request number")],
  },
  {
    name: "git.push",
    description: "Push through the gated-review MCP server.",
    args: [
      stringArg("branch", false, "branch (current)"),
      booleanArg("force_with_lease", "force with lease"),
    ],
  },
  {
    name: "git.pull",
    description: "Pull through the gated-review MCP server.",
    args: [
      stringArg("branch", false, "branch (current)"),
      booleanArg("rebase", "rebase"),
    ],
  },
  {
    name: "git.fetch",
    description: "Fetch through the gated-review MCP server.",
    args: [stringArg("refspec", false, "refspec")],
  },
  {
    name: "get_review_round",
    description: "Read pull request review threads and comments.",
    args: [
      integerArg("pullRequestNumber", true, "pull request number"),
      booleanArg("includeResolved", "include resolved threads"),
    ],
  },
  {
    name: "pr_status",
    description: "Read pull request review and push status.",
    args: [integerArg("pullRequestNumber", true, "pull request number")],
  },
];

const GATED_REVIEW_TOOL_BY_NAME = new Map(
  GATED_REVIEW_TOOL_SPECS.map((spec) => [spec.name, spec]),
);

export function getGatedReviewToolSpec(
  name: string,
): GatedReviewToolSpec | undefined {
  return GATED_REVIEW_TOOL_BY_NAME.get(
    canonicalGatedReviewToolName(name) as GatedReviewToolName,
  );
}

export function gatedReviewSkills(backend: RuntimeId): Skill[] {
  const idPrefix = backend === "claude-code" ? "cc" : "codex";
  return GATED_REVIEW_TOOL_SPECS.map((tool) => ({
    id: `${idPrefix}:mcp:${GATED_REVIEW_SERVER_NAME}:${tool.name}`,
    name: `mcp:${GATED_REVIEW_SERVER_NAME}:${tool.name}`,
    description: tool.description,
    backend,
    scope: "system",
    args: tool.args,
    user_invocable: true,
    model_invocable: true,
  }));
}

export interface McpSkillReference {
  serverName: string;
  toolName: string;
}

export function parseMcpSkillReference(skill: Skill): McpSkillReference | null {
  const [backend, marker, serverName, ...toolParts] = skill.id.split(":");
  if (
    (backend !== "cc" && backend !== "codex") ||
    marker !== "mcp" ||
    !serverName ||
    toolParts.length === 0
  ) {
    return null;
  }
  const toolName = toolParts.join(":");
  return {
    serverName,
    toolName:
      serverName === GATED_REVIEW_SERVER_NAME
        ? canonicalGatedReviewToolName(toolName)
        : toolName,
  };
}

type PrepareResult =
  | { ok: true; value: McpArguments }
  | { ok: false; error: string };

export interface GitContext {
  repository: string | null;
  branch: string | null;
}

export type GitContextResolver = (workdir: string) => Promise<GitContext>;

async function readGitValue(
  workdir: string,
  args: string[],
): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", workdir, ...args],
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) return null;
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}

export function repositoryFromRemote(remote: string): string | null {
  const scpMatch = remote.match(/^[^@]+@[^:]+:(.+)$/);
  let path = scpMatch?.[1] ?? null;
  if (path === null) {
    try {
      path = new URL(remote).pathname;
    } catch {
      path = remote;
    }
  }
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

export const resolveGitContext: GitContextResolver = async (workdir) => {
  const [remote, branch] = await Promise.all([
    readGitValue(workdir, ["config", "--get", "remote.origin.url"]),
    readGitValue(workdir, ["branch", "--show-current"]),
  ]);
  return {
    repository: remote === null ? null : repositoryFromRemote(remote),
    branch,
  };
};

function coerceArguments(
  spec: GatedReviewToolSpec,
  raw: Record<string, string>,
): PrepareResult {
  const values: McpArguments = {};
  const knownKeys = new Set(spec.args.map((arg) => arg.key));
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) return { ok: false, error: `unknown arg: ${key}` };
  }

  for (const arg of spec.args) {
    const rawValue = raw[arg.key] ?? "";
    if (arg.required && rawValue.trim().length === 0) {
      return { ok: false, error: `missing required arg: ${arg.key}` };
    }
    if (rawValue.length === 0) continue;

    if (arg.kind === "integer") {
      if (!/^-?\d+$/.test(rawValue.trim())) {
        return { ok: false, error: `${arg.key} must be an integer` };
      }
      values[arg.key] = Number.parseInt(rawValue, 10);
    } else if (arg.kind === "boolean") {
      if (rawValue !== "true" && rawValue !== "false") {
        return { ok: false, error: `${arg.key} must be true or false` };
      }
      values[arg.key] = rawValue === "true";
    } else {
      values[arg.key] = rawValue;
    }
  }
  return { ok: true, value: values };
}

const REPOSITORY_TOOLS = new Set<GatedReviewToolName>([
  "open_pr",
  "reply_to_thread",
  "resolve_thread",
  "request_next_round",
  "git.push",
  "git.pull",
  "git.fetch",
  "get_review_round",
  "pr_status",
]);

export async function prepareGatedReviewArguments({
  toolName,
  rawArgs,
  workdir,
  gitContextResolver = resolveGitContext,
}: {
  toolName: string;
  rawArgs: Record<string, string>;
  workdir: string;
  gitContextResolver?: GitContextResolver;
}): Promise<PrepareResult> {
  const spec = getGatedReviewToolSpec(toolName);
  if (!spec) {
    return { ok: false, error: `unsupported gated-review tool: ${toolName}` };
  }

  const coerced = coerceArguments(spec, rawArgs);
  if (!coerced.ok) return coerced;
  const values = coerced.value;

  const needsRepository = REPOSITORY_TOOLS.has(spec.name);
  const needsBranch =
    spec.name === "open_pr" &&
    !values.head;
  const context =
    needsRepository || needsBranch
      ? await gitContextResolver(workdir)
      : { repository: null, branch: null };

  if (REPOSITORY_TOOLS.has(spec.name)) {
    if (context.repository === null) {
      return {
        ok: false,
        error: "repository is required (could not derive owner/repository from origin)",
      };
    }
    values.repository = context.repository;
  }

  if (
    spec.name === "git.push" ||
    spec.name === "git.pull" ||
    spec.name === "git.fetch"
  ) {
    values.repo_path = workdir;
  }
  if (spec.name === "open_pr") {
    values.base ??= "main";
    if (!values.head) {
      if (context.branch === null) {
        return { ok: false, error: "head is required (could not derive current branch)" };
      }
      values.head = context.branch;
    }
  }

  return { ok: true, value: values };
}
