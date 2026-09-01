// Pure transforms from ACP session/update notifications to the kbbl UI
// event union (§13). Normalizes ACP semantics only — provider-private
// payloads and _meta are never interpreted. Unknown update types project
// to null (§13.3): logged by the caller, never a crash.

import type * as schema from "@agentclientprotocol/sdk";

import type {
  AcpUiEvent,
  UiContent,
  UiPlanEntry,
  UiPermissionOption,
  UiSessionConfig,
} from "./types";

function contentBlockText(block: schema.ContentBlock): UiContent {
  if (block.type === "text") return { type: "text", text: block.text };
  // Non-text blocks render as a tagged placeholder until richer content
  // support lands with the PWA cutover (§13.2).
  return { type: "text", text: `[${block.type}]` };
}

let chunkCounter = 0;
function chunkId(messageId: string | null | undefined): string {
  if (messageId) return messageId;
  chunkCounter += 1;
  return `chunk-${chunkCounter}`;
}

export function projectConfigOptions(
  options: readonly schema.SessionConfigOption[],
): AcpUiEvent {
  const projected: UiSessionConfig[] = options.map((option) => {
    if (option.type === "boolean") {
      return {
        id: option.id,
        name: option.name,
        category: option.category ?? null,
        type: "boolean",
        value: option.currentValue,
        options: [],
      };
    }
    const flat = option.options.flatMap((entry) =>
      "options" in entry
        ? entry.options.map((item) => ({ value: item.value, name: item.name }))
        : [{ value: entry.value, name: entry.name }],
    );
    return {
      id: option.id,
      name: option.name,
      category: option.category ?? null,
      type: "select",
      value: option.currentValue,
      options: flat,
    };
  });
  return { kind: "config_options", options: projected };
}

export function projectPermissionRequest(
  requestId: string,
  request: schema.RequestPermissionRequest,
): AcpUiEvent {
  const options: UiPermissionOption[] = request.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind ?? null,
  }));
  return {
    kind: "permission",
    requestId,
    title: request.toolCall.title ?? "Permission required",
    options,
  };
}

/**
 * Projects one session/update into a UI event, or null for update types
 * the UI does not render (compaction internals, mode echoes, unknown
 * extension updates).
 */
export function projectSessionUpdate(
  update: schema.SessionUpdate,
  replayed: boolean,
): AcpUiEvent | null {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return {
        kind: "user_message",
        id: chunkId(update.messageId),
        content: [contentBlockText(update.content)],
        replayed,
      };
    case "agent_message_chunk":
      return {
        kind: "agent_message",
        id: chunkId(update.messageId),
        content: [contentBlockText(update.content)],
        streaming: !replayed,
        replayed,
      };
    case "agent_thought_chunk":
      return {
        kind: "thought",
        id: chunkId(update.messageId),
        content: [contentBlockText(update.content)],
        streaming: !replayed,
        replayed,
      };
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
        content: update.content ?? null,
        locations: (update.locations ?? []).map((location) => ({
          path: location.path,
          line: location.line ?? null,
        })),
      };
    case "tool_call_update":
      return {
        kind: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title ?? "",
        status: update.status ?? "in_progress",
        content: update.content ?? null,
        locations: (update.locations ?? []).map((location) => ({
          path: location.path,
          line: location.line ?? null,
        })),
      };
    case "plan": {
      const entries: UiPlanEntry[] = update.entries.map((entry) => ({
        content: entry.content,
        status: entry.status,
        priority: entry.priority,
      }));
      return { kind: "plan", entries };
    }
    case "available_commands_update":
      return {
        kind: "commands",
        commands: update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description ?? null,
        })),
      };
    case "config_option_update":
      return projectConfigOptions(update.configOptions);
    case "session_info_update":
      return {
        kind: "session_info",
        title: update.title ?? null,
        updatedAt: update.updatedAt ?? null,
      };
    case "usage_update":
      return {
        kind: "usage",
        used: update.used,
        size: update.size,
        cost: update.cost
          ? { amount: update.cost.amount, currency: update.cost.currency }
          : undefined,
      };
    default:
      return null;
  }
}
