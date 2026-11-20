import type { SessionIntegrationConfig } from "./session-integration";
import type { WorktreeProvider } from "./types";
import type { AgentProfile, AgentProfileId } from "./agent-profile";
import type { AcpControllerRegistry } from "./controller-registry";
import type { AcpProcessSupervisor } from "./process-supervisor";
import type { SessionSummaryGenerator } from "./session-summary";
import type { AcpSessionStore } from "./store";

export interface AcpServiceConfig {
  readonly default_agent: string;
  readonly graceful_kill_ms: number;
  readonly idle_child_ttl_ms: number;
  readonly live_item_buffer: number;
  readonly initial_item_window: number;
  readonly item_page_limit: number;
  readonly item_page_limit_max: number;
}

export interface AcpSessionServiceDeps {
  readonly integration?: SessionIntegrationConfig;
  readonly store: AcpSessionStore;
  readonly controllers: AcpControllerRegistry;
  readonly profiles: ReadonlyMap<AgentProfileId, AgentProfile>;
  readonly supervisor: AcpProcessSupervisor;
  readonly worktrees: WorktreeProvider;
  readonly config: AcpServiceConfig;
  readonly summary_generators?: readonly SessionSummaryGenerator[];
}
