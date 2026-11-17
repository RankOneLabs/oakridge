import type { AttemptRecord } from "../storage/schema-records";
import type { KbblUsage, UsageTurn } from "../domain/usage";
import { selectDeliveryKey } from "../effects/delivery-key";
export type AttributionAttempt = Pick<AttemptRecord, "action_id" | "seq" | "created_at" | "kbbl_session_id">;
export interface OwnedTurn { sid: string; turn: UsageTurn; attempt: AttributionAttempt | null; kind: "delivered" | "incidental" }
export const attemptKey = (attempt: Pick<AttributionAttempt, "action_id" | "seq">): string => `${attempt.action_id}:${attempt.seq}`;
export const turnTime = (turn: UsageTurn): number => Date.parse(turn.started_at ?? turn.created_at);
export function attributeUsage(attempts: readonly AttributionAttempt[], sessions: readonly KbblUsage[]): OwnedTurn[] {
  return sessions.flatMap((session) => {
    const holders = attempts.filter((a) => a.kbbl_session_id === session.sid).sort((a,b) => +a.created_at - +b.created_at || a.seq-b.seq);
    const deliveries = session.turns.flatMap((turn) => {
      const attempt = holders.find((a) => selectDeliveryKey(a) === turn.turn_key);
      return attempt ? [{ turn, attempt }] : [];
    });
    return session.turns.map((turn): OwnedTurn => {
      const exact = deliveries.find((d) => d.turn.turn_key === turn.turn_key);
      const previous = deliveries.filter((d) => d.turn.started_at !== null && turnTime(d.turn) <= turnTime(turn))
        .sort((a,b) => turnTime(b.turn)-turnTime(a.turn))[0];
      return { sid: session.sid, turn, attempt: exact?.attempt ?? previous?.attempt ?? holders[0] ?? null, kind: exact ? "delivered" : "incidental" };
    });
  });
}
