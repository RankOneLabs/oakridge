import type { TranscriptItem } from "./transcript-model";
import type { UiSessionHistory } from "./types";

function conversationLines(items: readonly TranscriptItem[]): string[] {
  return items
    .filter((item) => item.kind === "user_message" || item.kind === "agent_message")
    .map((item) => ({ kind: item.kind, text: item.text.trim() }))
    .filter((message) => message.text !== "")
    .map((message) => `${message.kind === "user_message" ? "User" : "Assistant"}: ${message.text}`);
}

/** The previous ACP session belongs to its original worktree. Carry its
 * visible conversation into a new session as a durable initial turn. */
export function buildResumeContext(parentSid: string, history: UiSessionHistory): string {
  const source = `Previous session: ${parentSid} (open #session/${parentSid} for the original transcript).`;
  if (history.kind === "summary") {
    return `${source}\n\nThe original transcript is unavailable. This is the saved handoff (${history.summary.method}):\n\n${history.summary.markdown}\n\nContinue from this context in the new worktree. Wait for the operator's next instruction.`;
  }

  const conversation = conversationLines(history.transcript?.items ?? []);
  return `${source}\n\nConversation from the previous session:\n\n${conversation.join("\n\n") || "(No prior messages.)"}\n\nContinue from this context in the new worktree. Wait for the operator's next instruction.`;
}
