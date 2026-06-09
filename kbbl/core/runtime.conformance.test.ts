import { runConformanceTests } from "./runtime.conformance";
import { createClaudeCodeRuntime } from "../adapters/claude-code";
import { createCodexRuntimeDescriptorOnly } from "../adapters/codex";

// === Claude Code conformance ===

runConformanceTests({
  makeRuntime: async () =>
    createClaudeCodeRuntime({
      claudeBin: "claude",
      port: 8788,
      dataDir: "/tmp",
    }),
  runtimeId: "claude-code",
});

// === Codex conformance ===
//
// Uses createCodexRuntimeDescriptorOnly() so the conformance suite runs
// without a real codex binary or live app-server. IO-requiring tests
// (spawn, events, terminate) are in kbbl/adapters/codex/index.test.ts.

runConformanceTests({
  makeRuntime: async () => createCodexRuntimeDescriptorOnly(),
  runtimeId: "codex",
});
