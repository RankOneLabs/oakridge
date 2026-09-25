import type { AcpUiEvent, UiSessionHistory } from "./types";

function conversationLine(event: AcpUiEvent): string | null {
  if (event.kind !== "user_message" && event.kind !== "agent_message") return null;
  const text = event.content.map((part) => part.text).join("").trim();
  if (!text) return null;
  return `${event.kind === "user_message" ? "User" : "Assistant"}: ${text}`;
}

/** The previous ACP session belongs to its original worktree. Carry its
 * visible conversation into a new session as a durable initial turn. */
export function buildResumeContext(parentSid: string, history: UiSessionHistory): string {
  const source = `Previous session: ${parentSid} (open #session/${parentSid} for the original transcript).`;
  if (history.kind === "summary") {
    return `${source}\n\nThe original transcript is unavailable. This is the saved handoff (${history.summary.method}):\n\n${history.summary.markdown}\n\nContinue from this context in the new worktree. Wait for the operator's next instruction.`;
  }

  const conversation = history.events.map(conversationLine).filter((line): line is string => line !== null);
  return `${source}\n\nConversation from the previous session:\n\n${conversation.join("\n\n") || "(No prior messages.)"}\n\nContinue from this context in the new worktree. Wait for the operator's next instruction.`;
}
