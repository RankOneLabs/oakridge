// In-memory controller map with single-flight creation (§8.5): while a
// controller for a sid is being created, concurrent UI/DBOS requests for
// the same sid await the same in-flight promise instead of spawning a
// duplicate ACP child.

import type { AcpSessionController } from "./controller";
import type { AcpError, KbblSessionId, Result } from "./types";

type ControllerFactory = () => Promise<
  Result<AcpSessionController, AcpError>
>;

export class AcpControllerRegistry {
  private readonly live = new Map<KbblSessionId, AcpSessionController>();
  private readonly inFlight = new Map<
    KbblSessionId,
    Promise<Result<AcpSessionController, AcpError>>
  >();

  getLive(sid: KbblSessionId): AcpSessionController | null {
    const controller = this.live.get(sid) ?? null;
    if (controller?.isDefunct) {
      this.live.delete(sid);
      return null;
    }
    return controller;
  }

  async getOrCreate(
    sid: KbblSessionId,
    factory: ControllerFactory,
  ): Promise<Result<AcpSessionController, AcpError>> {
    const existing = this.getLive(sid);
    if (existing) return { ok: true, value: existing };

    const pending = this.inFlight.get(sid);
    if (pending) return pending;

    const creation = (async () => {
      try {
        const created = await factory();
        if (created.ok) this.live.set(sid, created.value);
        return created;
      } finally {
        this.inFlight.delete(sid);
      }
    })();
    this.inFlight.set(sid, creation);
    return creation;
  }

  remove(sid: KbblSessionId): void {
    this.live.delete(sid);
  }

  liveCount(): number {
    return this.live.size;
  }

  /** Bounded shutdown: close every live child (§21). */
  async shutdownAll(): Promise<void> {
    const controllers = [...this.live.values()];
    this.live.clear();
    await Promise.all(controllers.map((controller) => controller.closeChild()));
  }
}
