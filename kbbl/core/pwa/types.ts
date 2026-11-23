// Browser domain types from the ACP session snapshot and transcript wire.

import type { RuntimeId } from "../runtime-interface";
import type { TurnKey } from "../acp/types";

export type {
  PwaSessionSnapshot as SessionSnapshot,
  PwaSessionSource as SessionSource,
} from "../acp/pwa-wire";
export type {
  AcpSessionStatus as SessionStatus,
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

// Legacy runtime descriptor shapes still consumed by the new-session form
// and the oakridge run-launch UI. Model/effort option lists arrive empty
// from /config in the ACP era (each agent exposes them per-session via
// config options); the id doubles as the agent profile id and stays the
// narrow RuntimeId union used by the Oakridge launch surface.
export interface RuntimeModelOption {
  value: string;
  label: string;
}

export interface RuntimeDescriptor {
  readonly default_model?: string | null;
  id: RuntimeId;
  label: string;
  models: RuntimeModelOption[];
  efforts: RuntimeModelOption[];
  supportsCompaction: boolean;
}

export type { RuntimeModelSelection } from "../runtime-interface";

/** Operator input awaiting a receipt or queued for delivery. */
export interface PendingSend {
  clientMessageId: string;
  turnKey: TurnKey | null;
  text: string;
  sentAt: number;
  status: "sending" | "accepted";
}

export type { SessionLiveState, StreamEpoch, TranscriptItem, TranscriptItemId, TranscriptSeq } from "../acp/transcript-model";
export type {
  SessionEpochFrame,
  SessionItemFrame,
  SessionItemTextFrame,
  SessionStateFrame,
  SessionStreamErrorFrame,
  SessionTurnFrame,
  SessionWireFrame,
} from "../acp/session-wire";
export type { EpochChanged, ItemPage } from "../acp/transcript-page";
