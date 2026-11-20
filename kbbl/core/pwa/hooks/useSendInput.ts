import { useMutation } from "@tanstack/react-query";
import { randomUuid } from "../lib/random-uuid";
import type { Result } from "../lib/result";
import type { TurnKey } from "../types";
import type { AcceptedInputReceipt } from "./usePendingSends";

export interface SendInputCallbacks {
  onSend: (text: string, clientMessageId: string) => void;
  onSendAccepted: (clientMessageId: string, receipt: AcceptedInputReceipt) => void;
  onSendFailed: (clientMessageId: string) => void;
}

export type SendInputFailure =
  | { kind: "rejected"; message: string }
  | { kind: "uncertain"; message: string };

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

export function useSendInput(sid: string, { onSend, onSendAccepted, onSendFailed }: SendInputCallbacks) {
  const sendMutation = useMutation({
    // client_message_id is the operator turn's idempotency key (§14.5),
    // minted per message (not per request) so any retry of the same send
    // cannot double-dispatch.
    mutationFn: async (payload: { text: string; clientMessageId: string }) => {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: payload.text,
          client_message_id: payload.clientMessageId,
        }),
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
      const body = (await res.json()) as { turn_key: string; status: string };
      if (typeof body.turn_key !== "string" || body.turn_key.length === 0) {
        throw new ServerRejection("server returned an invalid turn key");
      }
      if (body.status !== "accepted" && body.status !== "prompting") {
        throw new ServerRejection(`server returned invalid turn status ${body.status}`);
      }
      return {
        turnKey: body.turn_key as TurnKey,
        status: body.status,
      } satisfies AcceptedInputReceipt;
    },
  });

  async function send(text: string): Promise<Result<AcceptedInputReceipt, SendInputFailure>> {
    const clientMessageId = randomUuid();
    onSend(text, clientMessageId);
    try {
      const receipt = await sendMutation.mutateAsync({ text, clientMessageId });
      onSendAccepted(clientMessageId, receipt);
      return { ok: true, value: receipt };
    } catch (error) {
      if (error instanceof ServerRejection) {
        onSendFailed(clientMessageId);
        return { ok: false, error: { kind: "rejected", message: error.message } };
      }
      const message = error instanceof Error ? error.message : "request failed";
      return { ok: false, error: { kind: "uncertain", message } };
    }
  }

  return { send, isPending: sendMutation.isPending };
}
