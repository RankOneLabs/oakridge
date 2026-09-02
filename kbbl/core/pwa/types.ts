// PWA domain model, mirroring the server's ACP-era browser wire (§14):
// PwaSessionSnapshot from core/acp/pwa-wire.ts and AcpUiEvent from
// core/acp/types.ts. Provider payload shapes (CC content blocks, Codex
// deltas) are gone with the legacy transcript surface — the browser only
// ever sees ACP-semantic UI events.

import type { RuntimeId } from "../runtime-interface";
import type { TurnKey } from "../acp/types";

export type {
  PwaSessionSnapshot as SessionSnapshot,
  PwaSessionSource as SessionSource,
} from "../acp/pwa-wire";
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
  TurnKey,
} from "../acp/types";

export type Status = "connecting" | "connected" | "disconnected" | "stale";
export type Theme = "dark" | "light";

// Legacy runtime descriptor shapes still consumed by the new-session form
// and the oakridge run-launch UI. Model/effort option lists arrive empty
// from /config in the ACP era (each agent exposes them per-session via
// config options); the id doubles as the agent profile id and stays the
// narrow RuntimeId union while the orchestrator launch surface does.
export interface RuntimeModelOption {
  value: string;
  label: string;
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: RuntimeModelOption[];
  efforts: RuntimeModelOption[];
  supportsCompaction: boolean;
}

export type { RuntimeModelSelection } from "../runtime-interface";

export interface PendingPlanCard {
  id: string;
  spec_id: string;
  status: string;
  created_at: string;
}

export interface PendingBriefCard {
  id: string;
  cohort_id: string;
  goal: string;
  status: string;
  created_at: string;
}

/** Optimistic operator send awaiting its user_message echo on the stream. */
export interface PendingSend {
  clientMessageId: string;
  turnKey: TurnKey | null;
  text: string;
  sentAt: number;
  status: "sending" | "accepted" | "prompting";
}
