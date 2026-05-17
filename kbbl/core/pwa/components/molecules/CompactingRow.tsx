import { useState, useEffect, useMemo } from "react";

import type { EnvelopeEvent, SystemStatusPayload } from "../../types";
import { parseIsoMs } from "../../lib/time";

export function CompactingRow({
  startEvent,
  doneEvent,
}: {
  startEvent: EnvelopeEvent;
  doneEvent: EnvelopeEvent | null;
}) {
  const startMs = useMemo(() => parseIsoMs(startEvent.ts), [startEvent.ts]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (doneEvent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [doneEvent]);

  if (doneEvent) {
    const doneMs = parseIsoMs(doneEvent.ts);
    const elapsed =
      startMs !== null && doneMs !== null
        ? Math.max(0, Math.round((doneMs - startMs) / 1000))
        : null;
    const result =
      (doneEvent.payload as SystemStatusPayload | null)?.compact_result ??
      "done";
    return (
      <div className="row row-system" title={`event #${startEvent.id}`}>
        <div className="notice">
          compacted{elapsed !== null ? ` in ${elapsed}s` : ""} ({result})
        </div>
      </div>
    );
  }
  const elapsed =
    startMs === null ? null : Math.max(0, Math.round((now - startMs) / 1000));
  return (
    <div className="row row-system" title={`event #${startEvent.id}`}>
      <div className="notice">
        {elapsed === null ? "compacting…" : `compacting (${elapsed}s)…`}
      </div>
    </div>
  );
}
