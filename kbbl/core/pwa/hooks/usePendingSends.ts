import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AcpUiEvent,
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

/** Projects durable operator turns plus the brief pre-receipt network window. */
export function usePendingSends(
  sid: string,
  events: AcpUiEvent[],
  openTurns: readonly UiOpenTurn[],
  sessionStatus: SessionStatus | null,
): PendingSendsState {
  const [localSends, setLocalSends] = useState<PendingSend[]>([]);

  useEffect(() => {
    setLocalSends([]);
  }, [sid]);

  useEffect(() => {
    if (
      sessionStatus === "ended" ||
      sessionStatus === "fenced" ||
      sessionStatus === "failed"
    ) {
      setLocalSends([]);
    }
  }, [sessionStatus]);

  const echoedTurnKeys = useMemo(
    () =>
      new Set(
        events.flatMap((event) =>
          event.kind === "user_message" ? [event.id] : [],
        ),
      ),
    [events],
  );

  useEffect(() => {
    setLocalSends((sends) => {
      const retained = sends.filter(
        (send) => send.turnKey === null || !echoedTurnKeys.has(send.turnKey),
      );
      return retained.length === sends.length ? sends : retained;
    });
  }, [echoedTurnKeys]);

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
      setLocalSends((sends) =>
        sends.map((send) =>
          send.clientMessageId === clientMessageId
            ? { ...send, turnKey: receipt.turnKey, status: receipt.status }
            : send,
        ),
      );
    },
    [],
  );

  const removePendingSend = useCallback((clientMessageId: string) => {
    setLocalSends((sends) =>
      sends.filter((send) => send.clientMessageId !== clientMessageId),
    );
  }, []);

  const durableSends = openTurns
    .filter(
      (turn) => turn.source === "operator" && !echoedTurnKeys.has(turn.turnKey),
    )
    .map<PendingSend>((turn) => ({
      clientMessageId: turn.turnKey.startsWith("operator:")
        ? turn.turnKey.slice("operator:".length)
        : turn.turnKey,
      turnKey: turn.turnKey,
      text: turn.text,
      sentAt: Date.parse(turn.createdAt),
      status: turn.status,
    }));
  const durableKeys = new Set(durableSends.map((send) => send.turnKey));
  const pendingSends = [
    ...durableSends,
    ...localSends.filter(
      (send) => send.turnKey === null || !durableKeys.has(send.turnKey),
    ),
  ];
  const lastPendingClientMessageId = pendingSends.at(-1)?.clientMessageId ?? null;

  return {
    pendingSends,
    addPendingSend,
    acceptPendingSend,
    removePendingSend,
    lastPendingClientMessageId,
  };
}
