import { describe, test, expect } from "bun:test";
import {
  normalizeApprovalByMethod,
  normalizeFileChangeApproval,
  normalizeCommandExecutionApproval,
} from "./approvals";
import type {
  FileChangeRequestApprovalParams,
  CommandExecutionRequestApprovalParams,
} from "./protocol/generated/types";

const fileChangeParams: FileChangeRequestApprovalParams = {
  threadId: "t1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1700000000,
  reason: "Creating test file",
  grantRoot: null,
};

const commandParams: CommandExecutionRequestApprovalParams = {
  threadId: "t1",
  turnId: "turn-1",
  itemId: "item-2",
  startedAtMs: 1700000000,
  reason: null,
  command: "/bin/bash -lc 'echo hello'",
  cwd: "/tmp",
  commandActions: [{ type: "unknown", command: "echo hello" }],
  proposedExecpolicyAmendment: [],
  availableDecisions: ["accept", "cancel"],
};

describe("normalizeApprovalByMethod", () => {
  test("fileChange → ApplyPatch", () => {
    const result = normalizeApprovalByMethod(
      "item/fileChange/requestApproval",
      fileChangeParams,
    );
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("ApplyPatch");
  });

  test("commandExecution → Exec", () => {
    const result = normalizeApprovalByMethod(
      "item/commandExecution/requestApproval",
      commandParams,
    );
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Exec");
  });

  test("unknown method → null", () => {
    expect(normalizeApprovalByMethod("item/legacy/requestApproval", {})).toBeNull();
    expect(normalizeApprovalByMethod("unknown", {})).toBeNull();
    expect(normalizeApprovalByMethod("", {})).toBeNull();
  });
});

describe("normalizeFileChangeApproval", () => {
  test("includes reason in toolInput", () => {
    const result = normalizeFileChangeApproval(fileChangeParams);
    expect(result.toolInput.reason).toBe("Creating test file");
  });

  test("decision mapping: allow → accept", () => {
    const result = normalizeFileChangeApproval(fileChangeParams);
    expect(result.codexDecision("allow")).toEqual({ decision: "accept" });
  });

  test("decision mapping: deny → cancel", () => {
    const result = normalizeFileChangeApproval(fileChangeParams);
    expect(result.codexDecision("deny")).toEqual({ decision: "cancel" });
  });
});

describe("normalizeCommandExecutionApproval", () => {
  test("includes command and cwd in toolInput", () => {
    const result = normalizeCommandExecutionApproval(commandParams);
    expect(result.toolInput.command).toBe("/bin/bash -lc 'echo hello'");
    expect(result.toolInput.cwd).toBe("/tmp");
  });

  test("includes commandActions in toolInput", () => {
    const result = normalizeCommandExecutionApproval(commandParams);
    expect(Array.isArray(result.toolInput.commandActions)).toBe(true);
  });

  test("decision mapping: allow → accept", () => {
    const result = normalizeCommandExecutionApproval(commandParams);
    expect(result.codexDecision("allow")).toEqual({ decision: "accept" });
  });

  test("decision mapping: deny → cancel", () => {
    const result = normalizeCommandExecutionApproval(commandParams);
    expect(result.codexDecision("deny")).toEqual({ decision: "cancel" });
  });
});
