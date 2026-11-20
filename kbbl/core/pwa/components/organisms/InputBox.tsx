import { TextArea } from "../atoms/TextArea";
import { Button } from "../atoms/Button";
import { useState, type ReactNode, type Ref } from "react";
import { useMutation } from "@tanstack/react-query";

import { useSendInput, type SendInputCallbacks } from "../../hooks/useSendInput";

/** Fit the composer to its draft; CSS caps its height and keeps overflow scrollable. */
function fitToContent(field: HTMLTextAreaElement | null): void {
  if (!field) return;
  field.style.height = "auto";
  const borderHeight = field.offsetHeight - field.clientHeight;
  field.style.height = `${field.scrollHeight + borderHeight}px`;
}

export function InputBox({
  ref,
  sid,
  tools,
  onSend,
  onSendAccepted,
  onSendFailed,
  isTurnActive,
  onInterruptingChange,
}: SendInputCallbacks & {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  tools?: ReactNode;
  // True while a turn is in flight. Interrupt cancels that turn and leaves
  // the session live; session removal lives in the session listings.
  isTurnActive: boolean;
  onInterruptingChange?: (isInterrupting: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { send: sendInput, isPending } = useSendInput(sid, { onSend, onSendAccepted, onSendFailed });

  async function send() {
    const payload = text.trim();
    if (!payload || isPending) return;
    setText("");
    setError(null);
    const result = await sendInput(payload);
    if (result.ok) return;
    if (result.error.kind === "rejected") {
      setText(payload);
      setError(result.error.message);
    } else {
      setError(`${result.error.message} — delivery status unknown, check the transcript before retrying`);
    }
  }

  const interruptMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });

  async function interrupt() {
    if (interruptMutation.isPending) return;
    setError(null);
    onInterruptingChange?.(true);
    try {
      await interruptMutation.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      onInterruptingChange?.(false);
    }
  }

  return (
    <div className="input-bar" ref={ref}>
      {error && <div className="input-error">error: {error}</div>}
      <div className="input-bar-row">
        {tools}
        {isTurnActive && (
          <Button variant="session"
            type="button"
            className="btn-interrupt"
            onClick={() => void interrupt()}
            disabled={interruptMutation.isPending}
            aria-label={interruptMutation.isPending ? "Interrupting current turn" : "Interrupt current turn"}
            title="Interrupt the current turn. The session stays live so you can redirect it with another message."
          >
            <span aria-hidden="true">{interruptMutation.isPending ? "…" : "■"}</span>
          </Button>
        )}
        <TextArea
          ref={(field) => fitToContent(field)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="message agent…"
          aria-label="message input"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="session"
          type="button"
          onClick={() => void send()}
          disabled={isPending || text.trim().length === 0}
        >
          Send
        </Button>
      </div>
      <span className="input-hint">
        Enter to send · Shift+Enter for newline
      </span>
    </div>
  );
}
