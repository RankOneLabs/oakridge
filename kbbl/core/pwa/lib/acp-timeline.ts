// Pure projection from the AcpUiEvent stream to what the session view
// renders (§13). The stream is chunk-level: consecutive message/thought
// chunks sharing an id fold into one bubble, tool_call updates land on
// the card they update, permission_resolved retires its card, and the
// non-timeline kinds (config, commands, usage, session info, turn state)
// fold latest-wins into view state.

import type {
  AcpUiEvent,
  UiAvailableCommand,
  UiPermissionOption,
  UiPlanEntry,
  UiSessionConfig,
  UiToolLocation,
} from "../types";

export interface PermissionResolution {
  outcome: "selected" | "cancelled";
  optionId: string | null;
}

export type TimelineItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "agent"; key: string; text: string; streaming: boolean }
  | { kind: "thought"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      title: string;
      status: string;
      content: unknown;
      locations: readonly UiToolLocation[];
    }
  | { kind: "plan"; key: string; entries: readonly UiPlanEntry[] }
  | {
      kind: "permission";
      key: string;
      requestId: string;
      title: string;
      options: readonly UiPermissionOption[];
      resolution: PermissionResolution | null;
    }
  | {
      kind: "turn_note";
      key: string;
      state: "cancelled" | "failed" | "unknown";
      stopReason: string | null;
      detail: string | null;
    };

export interface UsageState {
  used: number | null;
  size: number | null;
  cost: { amount: number; currency: string } | null;
}

export interface SessionProjection {
  items: TimelineItem[];
  configOptions: readonly UiSessionConfig[];
  commands: readonly UiAvailableCommand[];
  usage: UsageState | null;
  sessionTitle: string | null;
  /** True while the last turn_state says a prompt is running. */
  turnActive: boolean;
  /** Permission cards still awaiting an operator answer. */
  openPermissions: Extract<TimelineItem, { kind: "permission" }>[];
}

function contentText(content: readonly { type: "text"; text: string }[]): string {
  return content.map((block) => block.text).join("");
}

export function projectTimeline(
  events: readonly AcpUiEvent[],
): SessionProjection {
  const items: TimelineItem[] = [];
  const toolIndexById = new Map<string, number>();
  const permissionIndexById = new Map<string, number>();
  let planIndex: number | null = null;
  let configOptions: readonly UiSessionConfig[] = [];
  let commands: readonly UiAvailableCommand[] = [];
  let usage: UsageState | null = null;
  let sessionTitle: string | null = null;
  let turnActive = false;

  // Chunk folding: a run of same-kind, same-id message chunks is one
  // bubble; anything else (a tool call, a different id) closes the run.
  let openRun: { kind: "user" | "agent" | "thought"; id: string; index: number } | null =
    null;

  events.forEach((event, eventIndex) => {
    switch (event.kind) {
      case "user_message":
      case "agent_message":
      case "thought": {
        const kind =
          event.kind === "user_message"
            ? ("user" as const)
            : event.kind === "agent_message"
              ? ("agent" as const)
              : ("thought" as const);
        const text = contentText(event.content);
        if (openRun && openRun.kind === kind && openRun.id === event.id) {
          const existing = items[openRun.index];
          if (existing.kind === "user") {
            items[openRun.index] = { ...existing, text: existing.text + text };
          } else if (existing.kind === "agent" || existing.kind === "thought") {
            items[openRun.index] = {
              ...existing,
              text: existing.text + text,
              streaming: event.kind === "user_message" ? false : event.streaming,
            };
          }
          return;
        }
        const key = `${kind}-${eventIndex}`;
        if (kind === "user") {
          items.push({ kind, key, text });
        } else {
          items.push({
            kind,
            key,
            text,
            streaming: event.kind === "user_message" ? false : event.streaming,
          });
        }
        openRun = { kind, id: event.id, index: items.length - 1 };
        return;
      }
      case "tool_call": {
        openRun = null;
        const existingIndex = toolIndexById.get(event.toolCallId);
        if (existingIndex !== undefined) {
          const existing = items[existingIndex];
          if (existing.kind === "tool") {
            items[existingIndex] = {
              ...existing,
              title: event.title.length > 0 ? event.title : existing.title,
              status: event.status,
              content: event.content ?? existing.content,
              locations:
                (event.locations?.length ?? 0) > 0
                  ? (event.locations ?? existing.locations)
                  : existing.locations,
            };
          }
          return;
        }
        items.push({
          kind: "tool",
          key: `tool-${event.toolCallId}-${eventIndex}`,
          toolCallId: event.toolCallId,
          title: event.title,
          status: event.status,
          content: event.content,
          locations: event.locations ?? [],
        });
        toolIndexById.set(event.toolCallId, items.length - 1);
        return;
      }
      case "plan": {
        openRun = null;
        if (planIndex !== null) {
          const existing = items[planIndex];
          if (existing.kind === "plan") {
            items[planIndex] = { ...existing, entries: event.entries };
          }
          return;
        }
        items.push({
          kind: "plan",
          key: `plan-${eventIndex}`,
          entries: event.entries,
        });
        planIndex = items.length - 1;
        return;
      }
      case "permission": {
        openRun = null;
        items.push({
          kind: "permission",
          key: `permission-${event.requestId}-${eventIndex}`,
          requestId: event.requestId,
          title: event.title,
          options: event.options,
          resolution: null,
        });
        permissionIndexById.set(event.requestId, items.length - 1);
        return;
      }
      case "permission_resolved": {
        const index = permissionIndexById.get(event.requestId);
        if (index === undefined) return;
        const existing = items[index];
        if (existing.kind === "permission") {
          items[index] = {
            ...existing,
            resolution: {
              outcome: event.outcome,
              optionId: event.optionId ?? null,
            },
          };
        }
        return;
      }
      case "turn_state": {
        openRun = null;
        turnActive = event.state === "prompting";
        if (
          event.state === "cancelled" ||
          event.state === "failed" ||
          event.state === "unknown"
        ) {
          items.push({
            kind: "turn_note",
            key: `turn-${eventIndex}`,
            state: event.state,
            stopReason: event.stopReason ?? null,
            detail: event.detail ?? null,
          });
        }
        return;
      }
      case "config_options":
        configOptions = event.options;
        return;
      case "commands":
        commands = event.commands;
        return;
      case "usage":
        usage = {
          used: event.used ?? null,
          size: event.size ?? null,
          cost: event.cost ?? null,
        };
        return;
      case "session_info":
        sessionTitle = event.title ?? sessionTitle;
        return;
    }
  });

  const openPermissions = items.filter(
    (item): item is Extract<TimelineItem, { kind: "permission" }> =>
      item.kind === "permission" && item.resolution === null,
  );

  return {
    items,
    configOptions,
    commands,
    usage,
    sessionTitle,
    turnActive,
    openPermissions,
  };
}

/** Config selectors grouped for the config bar (§12.3): semantic
 * categories get dedicated slots; everything else lands in overflow. */
export interface GroupedConfigOptions {
  model: UiSessionConfig | null;
  thoughtLevel: UiSessionConfig | null;
  mode: UiSessionConfig | null;
  overflow: UiSessionConfig[];
}

export function groupConfigOptions(
  options: readonly UiSessionConfig[],
): GroupedConfigOptions {
  const grouped: GroupedConfigOptions = {
    model: null,
    thoughtLevel: null,
    mode: null,
    overflow: [],
  };
  for (const option of options) {
    if (option.type !== "select" && option.type !== "boolean") continue;
    if (option.category === "model" && grouped.model === null) {
      grouped.model = option;
    } else if (option.category === "thought_level" && grouped.thoughtLevel === null) {
      grouped.thoughtLevel = option;
    } else if (option.category === "mode" && grouped.mode === null) {
      grouped.mode = option;
    } else {
      grouped.overflow.push(option);
    }
  }
  return grouped;
}
