/**
 * Outbound HTTP callbacks for delegated sessions (C.2 + C.3).
 *
 * A delegated session is created by an oakridge stage via POST /sessions with
 * the C.1 contract. The callback struct identifies the oakridge stage instance
 * that launched the session so kbbl can report back:
 *
 *  C.2a — artifact emit: agent POSTs an artifact to kbbl which forwards it
 *          to {base_url}{emit_path}.
 *  C.2b — terminal status: when a delegated session ends (non-compaction),
 *          kbbl POSTs { status, sid, stage_instance_id } to {base_url}{status_path}.
 *  C.3  — approval notification: when an unauto-resolved approval is needed,
 *          kbbl POSTs { request_id, tool_label, sid } to
 *          {base_url}/stages/{stage_instance_id}/approvals so oakridge can
 *          call back via POST /:sid/approval.
 */

export interface DelegatedCallback {
  readonly base_url: string;
  readonly stage_instance_id: string;
  readonly emit_path: string;
  readonly status_path: string;
}

export interface OutputSlot {
  readonly name: string;
  readonly artifact_type: string;
}

/**
 * Forward an agent-emitted artifact payload to oakridge.
 * Logs errors but never throws — a failed emit should not crash the session.
 */
export async function emitArtifact(
  callback: DelegatedCallback,
  payload: unknown,
): Promise<void> {
  const url = `${callback.base_url}${callback.emit_path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`kbbl: artifact emit to ${url} returned ${res.status}`);
    }
  } catch (err) {
    console.error(
      `kbbl: artifact emit to ${url} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Report terminal session status to oakridge. Called when a delegated session
 * ends for any reason other than compaction (which spawns a successor that
 * continues the work).
 *
 * Status is always "done" for now regardless of exit code; a future PR can
 * thread the exit code through Session.onEnded to distinguish "failed".
 */
export async function reportTerminalStatus(
  callback: DelegatedCallback,
  status: "done" | "failed",
  sid: string,
): Promise<void> {
  const url = `${callback.base_url}${callback.status_path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        sid,
        stage_instance_id: callback.stage_instance_id,
      }),
    });
    if (!res.ok) {
      console.error(
        `kbbl: terminal status report to ${url} returned ${res.status}`,
      );
    }
  } catch (err) {
    console.error(
      `kbbl: terminal status report to ${url} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Notify oakridge that a delegated session is waiting on an approval decision.
 * Fire-and-forget: oakridge responds by calling POST /:sid/approval (per-sid.ts),
 * which resolves the pending approval and unblocks the CC hook handler.
 * Never throws — notification failure is logged and the session continues
 * waiting (operator can still approve via the UI).
 */
export function notifyApprovalNeeded(
  callback: DelegatedCallback,
  requestId: string,
  toolLabel: string,
  sid: string,
): void {
  const url = `${callback.base_url}/stages/${callback.stage_instance_id}/approvals`;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, tool_label: toolLabel, sid }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(
          `kbbl: approval notification to ${url} returned ${res.status}`,
        );
      }
    })
    .catch((err) => {
      console.error(
        `kbbl: approval notification to ${url} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}
