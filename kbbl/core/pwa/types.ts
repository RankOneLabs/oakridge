// PWA domain model, mirroring the server's ACP-era browser wire (§14):
// PwaSessionSnapshot from core/acp/pwa-wire.ts and AcpUiEvent from
// core/acp/types.ts. The browser only ever sees ACP-semantic UI events.

import type { RuntimeId } from "../runtime-interface";
import type { TurnKey } from "../acp/types";

export type { PwaSessionSnapshot as SessionSnapshot } from "../acp/pwa-wire";
export type {
  AcpSessionStatus as SessionStatus,
  AcpUiEvent,
  UiAvailableCommand,
  UiContent,
  UiPermissionOption,
  UiPlanEntry,
  UiOpenTurn,
  UiSessionConfig,
  UiToolLocation,
  TerminalSessionSummary,
  SessionHistoryUnavailableReason,
  TurnKey,
} from "../acp/types";

export type Status = "connecting" | "connected" | "disconnected" | "stale";
export type Theme = "dark" | "light";

// The launch catalog /config serves for the new-session form. The id doubles
// as the agent profile id. Once a session starts, the agent's ACP config
// options are authoritative.
export interface RuntimeModelOption {
  value: string;
  label: string;
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: RuntimeModelOption[];
  efforts: RuntimeModelOption[];
}

/** Optimistic operator send awaiting its user_message echo on the stream. */
export interface PendingSend {
  clientMessageId: string;
  turnKey: TurnKey | null;
  text: string;
  sentAt: number;
  status: "sending" | "accepted" | "prompting";
}
