import type { PendingSend, TurnKey, UiOpenTurn } from "../types";

interface PendingBubbleInput {
  local_sends: readonly PendingSend[];
  open_turns: readonly UiOpenTurn[];
  active_turn: TurnKey | null;
}

export function selectPendingBubbles({ local_sends, open_turns, active_turn }: PendingBubbleInput): PendingSend[] {
  const durable = open_turns
    .filter((turn) => turn.source === "operator" && turn.status === "accepted" && turn.turnKey !== active_turn)
    .map<PendingSend>((turn) => ({
      clientMessageId: turn.turnKey.replace(/^operator:/, ""),
      turnKey: turn.turnKey,
      text: turn.text,
      sentAt: Date.parse(turn.createdAt),
      status: "accepted",
    }));
  const durableKeys = new Set(durable.map((send) => send.turnKey));
  const promptingKeys = new Set(open_turns.filter((turn) => turn.status === "prompting").map((turn) => turn.turnKey));
  return [
    ...durable,
    ...local_sends.filter(({ turnKey }) =>
      turnKey === null ||
      (turnKey !== active_turn && !durableKeys.has(turnKey) && !promptingKeys.has(turnKey))),
  ];
}
