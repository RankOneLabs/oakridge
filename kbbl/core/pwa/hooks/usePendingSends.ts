import { useCallback, useEffect, useRef, useState } from "react";

import { selectPendingBubbles } from "../lib/pending-bubbles";
import type {
  PendingSend,
  SessionStatus,
  TurnKey,
  UiOpenTurn,
} from "../types";

export interface AcceptedInputReceipt {
  readonly turnKey: TurnKey;
  readonly status: "accepted" | "prompting";
}

export interface PendingSendsState {
  pendingSends: PendingSend[];
  addPendingSend: (text: string, clientMessageId: string) => void;
  acceptPendingSend: (clientMessageId: string, receipt: AcceptedInputReceipt) => void;
  removePendingSend: (clientMessageId: string) => void;
  lastPendingClientMessageId: string | null;
}

interface PendingTurnState {
  openTurns: readonly UiOpenTurn[];
  activeTurn: TurnKey | null;
  terminalTurnKeys: ReadonlySet<TurnKey>;
  sessionStatus: SessionStatus | null;
}

/** Projects durable operator turns plus the brief pre-receipt network window. */
export function usePendingSends(
  sid: string,
  { openTurns, activeTurn, terminalTurnKeys, sessionStatus }: PendingTurnState,
): PendingSendsState {
  const [localSends, setLocalSends] = useState<PendingSend[]>([]);
  const observedTurns = useRef(new Set<TurnKey>());
  const isClosed = sessionStatus === "ended" || sessionStatus === "fenced" || sessionStatus === "failed";

  useEffect(() => {
    observedTurns.current.clear();
    setLocalSends([]);
  }, [sid, isClosed]);

  useEffect(() => {
    if (isClosed) return;
    const openKeys = new Set(openTurns.map((turn) => turn.turnKey));
    for (const key of openKeys) observedTurns.current.add(key);
    if (activeTurn !== null) observedTurns.current.add(activeTurn);
    const retained = localSends.filter(({ turnKey }) =>
      turnKey === null ||
      (turnKey !== activeTurn && !terminalTurnKeys.has(turnKey) &&
        (openKeys.has(turnKey) || !observedTurns.current.has(turnKey))));
    if (retained.length !== localSends.length) {
      setLocalSends((current) => current === localSends ? retained : current);
    }
    // Once all receipts have arrived, completed turns can no longer match a new local send.
    if (retained.every((send) => send.turnKey !== null)) {
      observedTurns.current = new Set(activeTurn === null ? openKeys : [...openKeys, activeTurn]);
    }
  }, [sid, isClosed, openTurns, activeTurn, terminalTurnKeys, localSends]);

  const addPendingSend = useCallback((text: string, clientMessageId: string) => {
    setLocalSends((sends) => [
      ...sends,
      {
        clientMessageId,
        turnKey: null,
        text,
        sentAt: Date.now(),
        status: "sending",
      },
    ]);
  }, []);

  const acceptPendingSend = useCallback(
    (clientMessageId: string, receipt: AcceptedInputReceipt) => {
      setLocalSends((sends) => receipt.status === "prompting"
        ? sends.filter((send) => send.clientMessageId !== clientMessageId)
        : sends.map((send) => send.clientMessageId === clientMessageId
          ? { ...send, turnKey: receipt.turnKey, status: "accepted" }
          : send));
    },
    [],
  );

  const removePendingSend = useCallback((clientMessageId: string) => {
    setLocalSends((sends) =>
      sends.filter((send) => send.clientMessageId !== clientMessageId),
    );
  }, []);

  const pendingSends = selectPendingBubbles({
    local_sends: isClosed ? [] : localSends.filter(({ turnKey }) => turnKey === null || !terminalTurnKeys.has(turnKey)),
    open_turns: openTurns,
    active_turn: activeTurn,
  });
  const lastPendingClientMessageId = pendingSends.at(-1)?.clientMessageId ?? null;

  return {
    pendingSends,
    addPendingSend,
    acceptPendingSend,
    removePendingSend,
    lastPendingClientMessageId,
  };
}
