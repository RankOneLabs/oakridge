import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "../../stream/event-bus";
import type { ReviewEventMap } from "../../review/events";

const runScript = join(dirname(fileURLToPath(import.meta.url)), "run.ts");

interface ResponderSpawnDeps {
  reviewEvents: EventBus<ReviewEventMap>;
  kbblUrl: string;
}

export function wireResponderSpawn({ reviewEvents, kbblUrl }: ResponderSpawnDeps): () => void {
  const unsub = reviewEvents.subscribe("thread.ping_received", (evt) => {
    if (!evt.responder_id) return;
    Bun.spawn([
      "bun",
      "run",
      runScript,
      `--responder=${evt.responder_id}`,
      `--thread-id=${evt.thread_id}`,
      `--target-type=${evt.target_type}`,
      `--target-id=${evt.target_id}`,
      `--kbbl-url=${kbblUrl}`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  return unsub;
}
