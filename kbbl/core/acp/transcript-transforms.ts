import type * as schema from "@agentclientprotocol/sdk";
import {
  PERMISSION_OPTION_KINDS, PLAN_ENTRY_STATUSES, PLAN_PRIORITIES, TOOL_KINDS, TOOL_STATUSES,
  type OpenEnum, type PermissionOptionKind, type PlanEntryStatus, type PlanPriority,
  type ToolContent, type ToolKind, type ToolStatus,
} from "./transcript-model";

function projectOpenEnum<T extends string>(values: readonly T[], raw: string): OpenEnum<T> {
  const value = values.find((candidate) => candidate === raw);
  return value === undefined ? { is_recognized: false, raw } : { is_recognized: true, value };
}

export function projectToolStatus(raw: string): OpenEnum<ToolStatus> {
  return projectOpenEnum(TOOL_STATUSES, raw);
}

export function projectToolKind(raw: string): OpenEnum<ToolKind> {
  return projectOpenEnum(TOOL_KINDS, raw);
}

export function projectPlanEntryStatus(raw: string): OpenEnum<PlanEntryStatus> {
  return projectOpenEnum(PLAN_ENTRY_STATUSES, raw);
}

export function projectPlanPriority(raw: string): OpenEnum<PlanPriority> {
  return projectOpenEnum(PLAN_PRIORITIES, raw);
}

export function projectPermissionOptionKind(raw: string | null | undefined): PermissionOptionKind | null {
  return PERMISSION_OPTION_KINDS.find((kind) => kind === raw) ?? null;
}

export function openEnumSpelling(value: OpenEnum<string>): string {
  return value.is_recognized ? value.value : value.raw;
}

function projectToolBlock(block: schema.ToolCallContent): ToolContent {
  const acp_type = String(block.type);
  switch (block.type) {
    case "content":
      return block.content.type === "text"
        ? { type: "text", text: block.content.text }
        : { type: "unsupported", acp_type: block.content.type };
    case "diff":
      return { type: "diff", path: block.path, old_text: block.oldText ?? null, new_text: block.newText };
    case "terminal":
      return { type: "terminal", terminal_id: block.terminalId };
    default:
      return { type: "unsupported", acp_type };
  }
}

export function projectToolContent(blocks: readonly schema.ToolCallContent[] | null | undefined): readonly ToolContent[] {
  return blocks?.map(projectToolBlock) ?? [];
}
