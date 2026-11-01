import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { randomUuid } from "../../../lib/random-uuid";
import { useResumeGate } from "../../hooks/useResumeGate";
import { selectHandoffSendability } from "../../lib/assessment-handoff";
import { REQUEST_BUILD_CHANGES } from "../../adapters/core";
import type { ParkedGate } from "../../types";

/** The assessment review decision that sends the build back with feedback. */

interface Props {
  gate: ParkedGate;
  preview: string;
  isEditPending: boolean;
  onSent: () => void;
}

/** Records the composed request on one open review; mount it per gate so each review starts unsent. */
export function SendToBuilder({ gate, preview, isEditPending, onSent }: Props) {
  const client = useQueryClient();
  const decision = useResumeGate(gate.id, gate.run_id);
  // One idempotency key per composed request, preserved across retries of it.
  const request = useRef<{ readonly text: string; readonly key: string } | null>(null);
  const sendability = selectHandoffSendability(preview, gate);

  function send(): void {
    if (sendability.kind === "blocked" || decision.isPending) return;
    if (request.current?.text !== preview) request.current = { text: preview, key: randomUuid() };
    decision.mutate({
      idempotency_key: request.current.key,
      artifact_revision_id: sendability.artifact_revision_id,
      action: REQUEST_BUILD_CHANGES,
      feedback: preview,
    }, { onSuccess: onSent, onError: (error) => {
      if (error instanceof Error && error.message.includes("review artifact changed")) {
        void client.invalidateQueries({ queryKey: ["oakridge", "run", gate.run_id, "gates"] });
        void client.invalidateQueries({ queryKey: ["oakridge", "gates"] });
        void client.invalidateQueries({ queryKey: ["oakridge", "artifact"] });
      }
    } });
  }

  return (
    <>
      {sendability.kind === "blocked" && <FeedbackMessage>{sendability.reason}</FeedbackMessage>}
      {decision.isError && <FeedbackMessage tone="danger">{decision.error instanceof Error && decision.error.message.includes("review artifact changed")
        ? "The assessment changed. Review the new assessment before sending."
        : decision.error instanceof Error ? decision.error.message : String(decision.error)}</FeedbackMessage>}
      <Button variant="primary" disabled={sendability.kind === "blocked" || isEditPending || decision.isPending}
        onClick={send}>{decision.isPending ? "Sending…" : "Send to Builder"}</Button>
    </>
  );
}
