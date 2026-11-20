import { buildEpochFrame, createSessionFrameEncoder, type SessionEpochFrame, type SessionWireFrame } from "./session-wire";
import { selectItemPage, type EpochChanged, type ItemPage } from "./transcript-page";
import type { AcpSessionHistory } from "./session-history";
import type { AcpSessionServiceDeps } from "./session-service-config";
import { turnToOpenTurn } from "./pwa-wire";
import { ok, err, acpError, type AcpError, type KbblSessionId, type Result } from "./types";

export interface SessionStreamLease {
  epoch_frame: SessionEpochFrame;
  release(): Promise<void>;
}

interface ItemPageQuery {
  epoch: string;
  before_seq: number;
  limit: number;
}

export class AcpSessionStream {
  constructor(private readonly deps: AcpSessionServiceDeps, private readonly history: AcpSessionHistory) {}

  async openSessionStream(
    sid: string,
    listener: (frames: readonly SessionWireFrame[]) => void,
    signal?: AbortSignal,
  ): Promise<Result<SessionStreamLease, AcpError>> {
    let unsubscribe: (() => void) | undefined;
    const detach = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      signal?.removeEventListener("abort", detach);
    };
    // History also releases on abort. Detach first so a display-only child
    // is not kept alive by this stream's own subscription.
    signal?.addEventListener("abort", detach, { once: true });
    const acquired = await this.history.acquireHistory(sid, signal);
    if (!acquired.ok) {
      detach();
      return acquired;
    }

    const lease = acquired.value;
    const history = lease.history;
    const controller = this.deps.controllers.getLive(history.sid);
    const canSubscribe = !signal?.aborted && history.kind === "transcript" && controller?.streamEpoch === history.transcript.stream_epoch;
    const epoch_frame = buildEpochFrame({
      history: canSubscribe ? {
        ...history,
        transcript: controller.snapshotTranscript(),
        openTurns: this.deps.store.listOpenTurns(history.sid).map(turnToOpenTurn),
      } : history,
      stream_epoch: controller?.streamEpoch ?? null,
      initial_item_window: this.deps.config.initial_item_window,
    });
    if (canSubscribe) {
      // No asynchronous work between the snapshot and the live subscription.
      const encode = createSessionFrameEncoder(epoch_frame);
      const unsubscribeTranscript = controller.subscribe(({ frames }) => {
        listener(encode(frames, controller.snapshotTranscript().items));
      });
      const unsubscribeAccepted = this.deps.store.subscribeTurnAccepted(history.sid, (turn) => {
        listener([{ kind: "turn_accepted", turn: turnToOpenTurn(turn) }]);
      });
      unsubscribe = () => {
        unsubscribeAccepted();
        unsubscribeTranscript();
      };
    }
    return ok({
      epoch_frame,
      release: () => {
        detach();
        return lease.release();
      },
    });
  }

  readItemPage(sid: string, query: ItemPageQuery): Result<ItemPage | EpochChanged, AcpError> {
    const sessionId = sid as KbblSessionId;
    if (!this.deps.store.getSession(sessionId)) {
      return err(acpError("session_not_found", "service.readItemPage", `no session ${sid}`));
    }
    const live = this.deps.controllers.getLive(sessionId);
    const retained = this.history.getRetainedSnapshot(sessionId);
    const matching = live?.streamEpoch === query.epoch ? live.snapshotTranscript() : retained;
    if (matching?.stream_epoch !== query.epoch) {
      return ok({ kind: "epoch_changed", stream_epoch: live?.streamEpoch ?? retained?.stream_epoch ?? null });
    }
    return ok({ kind: "page", stream_epoch: matching.stream_epoch, ...selectItemPage({ ...query, items: matching.items }) });
  }
}
