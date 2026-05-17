import { useState, type Ref } from "react";

export function InputBox({
  ref,
  sid,
  onSend,
  onSendFailed,
  canStop,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  onSend: (text: string) => number;
  onSendFailed: (localId: number) => void;
  canStop: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const payload = text.trim();
    if (!payload || sending) return;
    // Clear the input + add the optimistic bubble *before* the network round
    // trip so the operator gets immediate "I sent" feedback even on a slow
    // tailnet. Two failure modes, treated differently:
    //  - Explicit non-OK response (4xx/5xx): server definitively rejected.
    //    Roll the bubble back, restore the text, surface the server's
    //    error so the operator can edit/retry without losing the message.
    //  - Thrown fetch (network drop, server crash mid-request): we don't
    //    know whether the server processed it. Leave the bubble in place
    //    and warn that delivery is uncertain — re-sending could double the
    //    command if the original actually went through.
    setText("");
    setSending(true);
    setError(null);
    const localId = onSend(payload);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const msg =
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`;
        onSendFailed(localId);
        setText(payload);
        setError(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setError(
        `${msg} — delivery status unknown, check the transcript before retrying`,
      );
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  }

  return (
    <div className="input-bar" ref={ref}>
      {error && <div className="input-error">error: {error}</div>}
      <div className="input-bar-row">
        {canStop && (
          <button
            type="button"
            className={`btn-stop ${confirmStop ? "is-confirming" : ""}`}
            onClick={() => {
              if (stopping) return;
              if (confirmStop) {
                void stop();
              } else {
                setConfirmStop(true);
              }
            }}
            onBlur={() => setConfirmStop(false)}
            disabled={stopping}
            title="Kills the CC subprocess. Resume from the ended banner to fork a new session with the same context."
          >
            {stopping ? "stopping…" : confirmStop ? "confirm" : "Stop"}
          </button>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="message CC…"
          aria-label="message input"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
        >
          Send
        </button>
      </div>
      <span className="input-hint">
        Enter to send · Shift+Enter for newline
      </span>
    </div>
  );
}
