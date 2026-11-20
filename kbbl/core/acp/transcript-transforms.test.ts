import { expect, test } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";
import {
  PERMISSION_OPTION_KINDS, PLAN_ENTRY_STATUSES, PLAN_PRIORITIES, TOOL_KINDS, TOOL_STATUSES,
} from "./transcript-model";
import {
  openEnumSpelling, projectPermissionOptionKind, projectPlanEntryStatus, projectPlanPriority,
  projectToolContent, projectToolKind, projectToolStatus,
} from "./transcript-transforms";

test.each([...TOOL_STATUSES])("recognizes tool status %s", (value) => {
  expect(projectToolStatus(value)).toEqual({ is_recognized: true, value });
});
test.each([...TOOL_KINDS])("recognizes tool kind %s", (value) => {
  expect(projectToolKind(value)).toEqual({ is_recognized: true, value });
});
test.each([...PLAN_ENTRY_STATUSES])("recognizes plan entry status %s", (value) => {
  expect(projectPlanEntryStatus(value)).toEqual({ is_recognized: true, value });
});
test.each([...PLAN_PRIORITIES])("recognizes plan priority %s", (value) => {
  expect(projectPlanPriority(value)).toEqual({ is_recognized: true, value });
});

test.each([
  ["tool status", projectToolStatus, "In_Progress"],
  ["tool kind", projectToolKind, " execute "],
  ["plan status", projectPlanEntryStatus, "compiling"],
  ["plan priority", projectPlanPriority, "HIGH"],
] as const)("preserves an unknown %s byte for byte", (_name, project, raw) => {
  const projected = project(raw);
  expect(projected).toEqual({ is_recognized: false, raw });
  expect(openEnumSpelling(projected)).toBe(raw);
});

test.each([...PERMISSION_OPTION_KINDS])("recognizes permission option kind %s", (kind) => {
  expect(projectPermissionOptionKind(kind)).toBe(kind);
});

test.each(["maybe", null, undefined])("maps permission option kind %s to null", (kind) => {
  expect(projectPermissionOptionKind(kind)).toBeNull();
});

test("projects ACP text, image, diffs, terminal and unknown tool content", () => {
  const blocks: schema.ToolCallContent[] = [
    { type: "content", content: { type: "text", text: "stdout" } },
    { type: "content", content: { type: "image", data: "YQ==", mimeType: "image/png" } },
    { type: "diff", path: "new.ts", newText: "new" },
    { type: "diff", path: "existing.ts", oldText: "before", newText: "after" },
    { type: "terminal", terminalId: "term-1" },
    { type: "future_block" } as unknown as schema.ToolCallContent,
  ];
  expect(projectToolContent(blocks)).toEqual([
    { type: "text", text: "stdout" },
    { type: "unsupported", acp_type: "image" },
    { type: "diff", path: "new.ts", old_text: null, new_text: "new" },
    { type: "diff", path: "existing.ts", old_text: "before", new_text: "after" },
    { type: "terminal", terminal_id: "term-1" },
    { type: "unsupported", acp_type: "future_block" },
  ]);
});

test.each([null, undefined])("projects absent tool content %s to an empty list", (blocks) => {
  expect(projectToolContent(blocks)).toEqual([]);
});
