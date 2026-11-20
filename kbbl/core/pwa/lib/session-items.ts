import { openEnumSpelling } from "../../acp/transcript-transforms";
import type { PermissionItem } from "../../acp/transcript-model";
import type {
  SessionLiveState,
  TranscriptItem,
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

function selectPermission(item: PermissionItem): Extract<TimelineItem, { kind: "permission" }> {
  return {
    kind: "permission",
    key: item.id,
    requestId: item.request_id,
    title: item.title,
    options: item.options.map(({ option_id, name, kind }) => ({ optionId: option_id, name, kind })),
    resolution: item.resolution && {
      outcome: item.resolution.kind,
      optionId: item.resolution.kind === "selected" ? item.resolution.option_id : null,
    },
  };
}

type LiveTimelineItems = Pick<SessionLiveState, "open_permissions" | "latest_plan">;

export function selectSessionTranscriptItems(items: readonly TranscriptItem[], state: LiveTimelineItems): readonly TranscriptItem[] {
  const { open_permissions, latest_plan } = state;
  if (open_permissions.length === 0 && latest_plan === null && !items.some((item) => item.kind === "permission" && item.resolution === null)) {
    return items;
  }
  const openPermissions = new Set(open_permissions.map((item) => item.id));
  const visibleItems = items.filter((item) => item.kind !== "permission" || item.resolution !== null || openPermissions.has(item.id));
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const stateItems = latest_plan === null ? open_permissions : [...open_permissions, latest_plan];
  const missingItems = stateItems.filter((item) => !visibleIds.has(item.id));
  return missingItems.length === 0
    ? visibleItems
    : [...visibleItems, ...missingItems].sort((a, b) => a.seq - b.seq);
}

export function selectSessionTimelineItems(items: readonly TranscriptItem[], state: SessionLiveState): TimelineItem[] {
  return selectTimelineItems(selectSessionTranscriptItems(items, state));
}

export function selectTimelineItems(items: readonly TranscriptItem[]): TimelineItem[] {
  return items.map((item) => {
    const key = item.id;
    switch (item.kind) {
      case "user_message":
        return { kind: "user", key, text: item.text };
      case "agent_message":
      case "thought":
        return { kind: item.kind === "agent_message" ? "agent" : "thought", key, text: item.text, streaming: item.is_streaming };
      case "tool_call":
        return { kind: "tool", key, toolCallId: item.tool_call_id, title: item.title,
          status: openEnumSpelling(item.status), content: item.content.length > 0 ? item.content : null, locations: item.locations };
      case "plan":
        return { kind: "plan", key, entries: item.entries.map(({ content, status, priority }) =>
          ({ content, status: openEnumSpelling(status), priority: openEnumSpelling(priority) })) };
      case "permission":
        return selectPermission(item);
      case "turn_note":
        return { kind: "turn_note", key, state: item.state, stopReason: item.stop_reason, detail: item.detail };
    }
  });
}

export function selectOpenPermissions(state: SessionLiveState): Extract<TimelineItem, { kind: "permission" }>[] {
  return state.open_permissions.map(selectPermission);
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
