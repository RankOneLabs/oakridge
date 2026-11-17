import type * as schema from "@agentclientprotocol/sdk";
import type { ControllerDeps } from "#kbbl/core/acp/controller";
import type { TurnKey } from "#kbbl/core/acp/types";
import { parseTurn, type ReadingOrigin, type TurnUsage } from "#kbbl/core/acp/usage-parsers/types";

/** Capture stays scoped to a single agent process; replay is filtered by the caller. */
export class AcpUsageCapture {
  private processSeq = 0;
  constructor(private readonly deps: Pick<ControllerDeps, "sid" | "store" | "profile">) {}
  beginProcess(): void { this.processSeq = this.deps.store.usage.nextProcessSeq(this.deps.sid); }
  turn(response: schema.PromptResponse): TurnUsage {
    return parseTurn(this.deps.profile.usageParser, response.usage, response._meta);
  }
  reading(update: schema.SessionUpdate, activeTurnKey: TurnKey | null): void {
    if (update.sessionUpdate !== "usage_update" || !update.cost) return;
    let origin: ReadingOrigin = { autonomous: false, origin_kind: null };
    try { origin = this.deps.profile.usageParser?.origin(update._meta) ?? origin; }
    catch { /* Unrecognised origin must not affect the turn. */ }
    this.deps.store.usage.appendReading({
      sid: this.deps.sid, process_seq: this.processSeq, context_used: update.used,
      context_size: update.size, cost_amount: update.cost.amount, cost_currency: update.cost.currency,
      active_turn_key: activeTurnKey, ...origin,
    });
  }
}
