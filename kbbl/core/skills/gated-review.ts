import type { RuntimeId } from "../runtime";
import type { ArgSpec, Skill } from "./types";

export const GATED_REVIEW_MCP_URL = "http://otto:3555/mcp";
export const GATED_REVIEW_SERVER_NAME = "gated-review";

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
 * arguments are not exposed in the UI: the live model derives them from its
 * session context when it handles the steering request.
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

/**
 * Format an MCP rail selection as a normal user request for the live model.
 * kbbl deliberately does not execute the tool itself: the model must receive
 * this text in its turn context and make the MCP call through its own runtime.
 */
export function formatMcpSkillRequest(
  skill: Skill,
  args: Record<string, string>,
): string | null {
  const reference = parseMcpSkillReference(skill);
  if (reference === null) return null;

  const declaredArgKeys = new Set(skill.args.map((arg) => arg.key));
  const providedArgs = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        declaredArgKeys.has(key) && value.trim().length > 0,
    ),
  );
  const argumentEntries = Object.keys(providedArgs);
  if (argumentEntries.length === 0) {
    return `Use the ${reference.serverName} MCP tool ${reference.toolName}.`;
  }
  return `Use the ${reference.serverName} MCP tool ${reference.toolName} with these arguments: ${JSON.stringify(providedArgs)}.`;
}
