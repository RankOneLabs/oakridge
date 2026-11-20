import type { AgentProfile } from "./agent-profile";
import { AcpSessionController } from "./controller";
import { prepareSessionIntegration } from "./session-integration";
import type { AcpSessionServiceDeps } from "./session-service";
import type { AcpSessionRow } from "./types";

interface SessionControllerInput {
  readonly row: AcpSessionRow;
  readonly profile: AgentProfile;
  readonly deps: AcpSessionServiceDeps;
  readonly historyOnly?: boolean;
}
/** All new, resumed and private history children receive the same pinned launch settings. */
export function createSessionController({ row, profile, deps, historyOnly }: SessionControllerInput): AcpSessionController {
  return new AcpSessionController({
    sid: row.sid, profile, store: deps.store, supervisor: deps.supervisor,
    prepareIntegration: () => prepareSessionIntegration(row, profile, deps.integration),
    config: { live_item_buffer: deps.config.live_item_buffer,
      close_grace_ms: deps.config.graceful_kill_ms },
    onDefunct: historyOnly ? () => undefined : sid => deps.controllers.remove(sid),
  });
}
