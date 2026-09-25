import type { AcpUiEvent, UiSessionHistory } from "./types";

type ConversationEvent = Extract<AcpUiEvent, { kind: "user_message" | "agent_message" }>;

function conversationLines(events: readonly AcpUiEvent[]): string[] {
  const messages: Array<{ kind: ConversationEvent["kind"]; id: string; text: string }> = [];
  let isAdjacentMessage = false;
  for (const event of events) {
    if (event.kind !== "user_message" && event.kind !== "agent_message") {
      isAdjacentMessage = false;
      continue;
    }
    const text = event.content.map((part) => part.text).join("");
    const previous = isAdjacentMessage ? messages.at(-1) : undefined;
    if (previous?.kind === event.kind && previous.id === event.id) {
      previous.text += text;
    } else {
      messages.push({ kind: event.kind, id: event.id, text });
    }
    isAdjacentMessage = true;
  }
  return messages
    .map((message) => ({ kind: message.kind, text: message.text.trim() }))
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

  const conversation = conversationLines(history.events);
  return `${source}\n\nConversation from the previous session:\n\n${conversation.join("\n\n") || "(No prior messages.)"}\n\nContinue from this context in the new worktree. Wait for the operator's next instruction.`;
}
