#!/usr/bin/env bun
// Mock Claude Code subprocess for compact/runCompact tests. Reads
// JSON lines on stdin; emits canned events on stdout. Behavior is
// driven by environment variables so each test can configure its
// scenario without rewriting the script:
//
//   MOCK_CC_BEHAVIOR=
//     "echo_compact_reply"  → on receipt of any user message, emit a
//                              system/init then a templated handoff
//                              `result` event with stop_reason:
//                              "end_turn" and the markdown content.
//     "stall"                → emit only the system/init then sit
//                              forever (used to test compact timeout).
//     "spawn_failure"        → exit immediately with code 1 (used to
//                              test successor spawn failure — set as
//                              the SECOND session's behavior).
//     "garbage_reply"        → emit a result with non-handoff
//                              content (parser test).
//
//   MOCK_CC_HANDOFF_MARKDOWN=  override the markdown template for
//                              echo_compact_reply scenarios.
//   MOCK_CC_SESSION_ID=        override the system/init session_id;
//                              defaults to "mock-cc-sid-<pid>".

const behavior = process.env.MOCK_CC_BEHAVIOR ?? "echo_compact_reply";
const md =
  process.env.MOCK_CC_HANDOFF_MARKDOWN ??
  `## Goal\nFinish the build plan.\n\n## Decisions made\n- chose mock CC: simpler than spawning real Claude\n\n## Approaches rejected\n- live CC: too slow for unit tests\n\n## Files & state in scope\n- session-manager.compact.test.ts\n\n## Open questions\n- none\n\n## Next concrete action\nLand the PR.\n`;

const sessionId =
  process.env.MOCK_CC_SESSION_ID ?? `mock-cc-sid-${process.pid}`;

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (behavior === "spawn_failure") {
  process.exit(1);
}

emit({ type: "system", subtype: "init", session_id: sessionId });

if (behavior === "stall") {
  process.stdin.resume();
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1 << 30);
}

if (behavior === "echo_compact_reply" || behavior === "garbage_reply") {
  process.stdin.resume();
  let buffered = "";
  process.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      const replyMd = behavior === "garbage_reply" ? "no structure" : md;
      emit({
        type: "result",
        stop_reason: "end_turn",
        model: "mock-model",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: replyMd }],
      });
    }
  });
}
