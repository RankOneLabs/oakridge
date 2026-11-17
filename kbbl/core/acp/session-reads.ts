import type { AcpSessionStore } from "#kbbl/core/acp/store";
import type { RetainedPromptTurn } from "#kbbl/core/acp/store-turns";
import { toSnapshot } from "#kbbl/core/acp/pwa-wire";
import { acpError, err, ok, type AcpError, type AcpSessionSnapshot, type KbblSessionId, type Result, type SessionUsage } from "#kbbl/core/acp/types";

/** Adapter-local read projections and archive state; no agent process is required. */
export class AcpSessionReads {
  constructor(private readonly store: AcpSessionStore) {}
  readUsage(sid: string): SessionUsage { return this.store.readUsage(sid as KbblSessionId); }
  readPromptTurns(sid: string): RetainedPromptTurn[] | null {
    return this.store.readPromptTurns(sid as KbblSessionId);
  }

  listSessions(): AcpSessionSnapshot[] {
    return this.store.listSessions().map(toSnapshot);
  }

  listSessionArchives(): Map<KbblSessionId, string> {
    return this.store.listSessionArchives();
  }

  archiveSession(sid: string): Result<void, AcpError> {
    const row = this.store.getSession(sid as KbblSessionId);
    if (!row) return err(acpError("session_not_found", "service.archiveSession", `no session ${sid}`, sid as KbblSessionId));
    if (row.status !== "ended" && row.status !== "fenced" && row.status !== "failed") {
      return err(acpError("session_busy", "service.archiveSession", `session ${sid} is still active`, row.sid));
    }
    this.store.archiveSession(row.sid);
    return ok(undefined);
  }

  getSession(sid: string): AcpSessionSnapshot | null {
    const row = this.store.getSession(sid as KbblSessionId);
    return row ? toSnapshot(row) : null;
  }

  listByArtifact(artifactId: string): AcpSessionSnapshot[] {
    return this.store.listByArtifact(artifactId).map(toSnapshot);
  }
}
