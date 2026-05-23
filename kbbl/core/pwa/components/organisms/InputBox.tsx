import { useState, type Ref } from "react";
import { useMutation } from "@tanstack/react-query";

// Distinguishes a server's explicit non-OK response (which means the server
// definitively rejected the message — safe to roll back the optimistic
// bubble and re-show the text) from a thrown fetch (network drop, request
// abort mid-flight — we don't know whether the server processed it, so
// leave the bubble and warn the operator).
class ServerRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerRejection";
  }
}

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
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: async (payload: string) => {
      const res = await fetch(`/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new ServerRejection(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
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

  async function send() {
    const payload = text.trim();
    if (!payload || sendMutation.isPending) return;
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
    setError(null);
    const localId = onSend(payload);
    // [hang-debug] Bracket the POST /:sid/input mutation so we can tell
    // whether send hung pre-flight, mid-flight, or completed (and the
    // bubble-reconciliation is the stuck step).
    const debugStart = Date.now();
    console.debug(`[hang-debug] send.start sid=${sid} localId=${localId} bytes=${payload.length}`);
    try {
      await sendMutation.mutateAsync(payload);
      console.debug(`[hang-debug] send.ok sid=${sid} localId=${localId} elapsed_ms=${Date.now() - debugStart}`);
    } catch (err) {
      const elapsed = Date.now() - debugStart;
      if (err instanceof ServerRejection) {
        console.debug(`[hang-debug] send.reject sid=${sid} localId=${localId} elapsed_ms=${elapsed} msg=${JSON.stringify(err.message)}`);
        onSendFailed(localId);
        setText(payload);
        setError(err.message);
      } else {
        const msg = err instanceof Error ? err.message : "request failed";
        console.warn(`[hang-debug] send.network_error sid=${sid} localId=${localId} elapsed_ms=${elapsed} msg=${JSON.stringify(msg)}`);
        setError(
          `${msg} — delivery status unknown, check the transcript before retrying`,
        );
      }
    }
  }

  async function stop() {
    if (stopMutation.isPending) return;
    setError(null);
    try {
      await stopMutation.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
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
              if (stopMutation.isPending) return;
              if (confirmStop) {
                void stop();
              } else {
                setConfirmStop(true);
              }
            }}
            onBlur={() => setConfirmStop(false)}
            disabled={stopMutation.isPending}
            title="Kills the CC subprocess. Resume from the ended banner to fork a new session with the same context."
          >
            {stopMutation.isPending ? "stopping…" : confirmStop ? "confirm" : "Stop"}
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
          disabled={sendMutation.isPending || text.trim().length === 0}
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
