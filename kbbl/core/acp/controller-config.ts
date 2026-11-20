import type { AgentProfile } from "./agent-profile";
import type { AcpProcessSupervisor } from "./process-supervisor";
import type { AcpSessionStore } from "./store";
import type { Result, AcpError, KbblSessionId } from "./types";

export interface ControllerConfig {
  readonly live_item_buffer: number;
  /** Bounded wait for a session/close answer before killing the child. */
  readonly close_grace_ms: number;
}

export interface ControllerDeps {
  readonly prepareIntegration?: () => Result<import("./session-integration").SessionIntegrationLaunch, AcpError>;
  readonly sid: KbblSessionId;
  readonly profile: AgentProfile;
  readonly store: AcpSessionStore;
  readonly supervisor: AcpProcessSupervisor;
  readonly config: ControllerConfig;
  /** Called when the child dies so the registry can drop this controller. */
  readonly onDefunct: (sid: KbblSessionId) => void;
}
