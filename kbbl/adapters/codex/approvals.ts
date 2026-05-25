// Approval normalization: maps Codex server-request methods → kbbl tool names + inputs.

import type {
  FileChangeRequestApprovalParams,
  CommandExecutionRequestApprovalParams,
} from "./protocol/generated/types";

export interface NormalizedApproval {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Map a kbbl allow/deny decision back to a Codex decision object. */
  codexDecision: (decision: "allow" | "deny") => { decision: string };
}

export function normalizeFileChangeApproval(
  params: FileChangeRequestApprovalParams,
): NormalizedApproval {
  return {
    toolName: "ApplyPatch",
    toolInput: {
      changes: (params as unknown as { changes?: unknown[] }).changes ?? [],
      reason: params.reason,
    },
    codexDecision: (d) => ({ decision: d === "allow" ? "accept" : "cancel" }),
  };
}

export function normalizeCommandExecutionApproval(
  params: CommandExecutionRequestApprovalParams,
): NormalizedApproval {
  return {
    toolName: "Exec",
    toolInput: {
      command: params.command,
      cwd: params.cwd,
      commandActions: params.commandActions,
    },
    codexDecision: (d) => ({ decision: d === "allow" ? "accept" : "cancel" }),
  };
}

/**
 * Route by method string.
 * Only the two v2 approval methods are supported (probe finding #2).
 * Unknown methods return null — callers should send cancel and continue.
 */
export function normalizeApprovalByMethod(
  method: string,
  params: unknown,
): NormalizedApproval | null {
  if (method === "item/fileChange/requestApproval") {
    return normalizeFileChangeApproval(params as FileChangeRequestApprovalParams);
  }
  if (method === "item/commandExecution/requestApproval") {
    return normalizeCommandExecutionApproval(
      params as CommandExecutionRequestApprovalParams,
    );
  }
  // Unknown / legacy method — no-op
  return null;
}
