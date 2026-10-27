import { useRef, useState } from "react";
import { randomUuid } from "../../lib/random-uuid";

export type HandoffSendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

interface SendReceipt {
  readonly turn_key?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
}

/** One idempotency key per composed handoff, preserved across retries. */
export function useSendToBuilder(sessionId: string | null) {
  const [state, setState] = useState<HandoffSendState>({ kind: "idle" });
  const request = useRef<{ readonly text: string; readonly id: string } | null>(null);
  const inFlight = useRef(false);
  const sent = useRef(false);

  async function send(text: string): Promise<void> {
    if (!sessionId || !text || inFlight.current || sent.current) return;
    inFlight.current = true;
    setState({ kind: "sending" });
    if (request.current?.text !== text) request.current = { text, id: randomUuid() };
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, client_message_id: request.current.id }),
      });
      const body = await response.json().catch(() => null) as SendReceipt | null;
      if (!response.ok || typeof body?.turn_key !== "string" || body.turn_key.length === 0
        || (body.status !== "accepted" && body.status !== "prompting")) {
        setState({ kind: "rejected", message: typeof body?.error === "string" ? body.error : `server returned ${response.status}` });
        return;
      }
      sent.current = true;
      setState({ kind: "sent" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "request failed";
      setState({ kind: "unknown", message: `${detail} — delivery status unknown; check the transcript before retrying.` });
    } finally {
      inFlight.current = false;
    }
  }

  function rearm(): void {
    if (inFlight.current) return;
    request.current = null;
    sent.current = false;
    setState({ kind: "idle" });
  }

  return { state, send, rearm };
}
