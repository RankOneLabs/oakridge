# Codex Follow-ups

Historical notes from the pre-ACP Codex rollout. The direct app-server adapter
has been removed; these implementation proposals are not the current backlog.

Current disposition:

- Archive aliases remain a compatibility concern: do not remove retained
  archive readers merely because live execution moved to ACP.
- Compaction and mid-turn steering would require evaluation at the ACP boundary,
  not wiring the removed direct app-server adapter.
- Current ACP sessions persist identity and can lazily reload agent-owned
  history after restart or idle reaping. The old claim that kbbl has no
  reattachment path no longer describes the active backend; this does not
  guarantee transparent recovery of every interrupted turn.
- Creating a successor with `resume_from` inherits worktree/runtime settings;
  it is not a cross-runtime conversation-history transfer feature.

See [the kbbl README](../kbbl/README.md) and
[ACP session service](../kbbl/core/acp/session-service.ts) for current behavior.
The original notes below are preserved as decision history, not instructions.

---

## 1. Remove `ccSid` / `parentCcSid` once archived-session compatibility is no longer required

**What:** `SessionSnapshot.ccSid` and `parentCcSid` are deprecated aliases for `runtimeSid` / parent relationship. They remain because clients that read archived JSONL from pre-migration sessions may still use these field names.

**When:** After a retention window in which all archived sessions have been migrated or expired (`retention.session_events_full_days` from the date of migration). At that point, remove the fields from `SessionSnapshot`, `session.ts`, and the snapshot-reconstruction path in `claude-code/index.ts`.

**Decision context:** Kept during the Codex rollout so old archived transcripts
could still hydrate after the runtime-id migration.

---

## 2. Evaluate native `thread/compact/start` for Codex compaction

**What:** Codex has a `thread/compact/start` protocol method that may serve the same role as kbbl's `/compact` flow (token reduction + handoff). Evaluate whether it can be wired to `POST /:sid/compact` and integrated with the CompactedBanner UX.

**Blocked on:** Codex CLI version that stabilizes `thread/compact/start` semantics.
The former adapter conformance notes are available in Git history at
`kbbl/adapters/codex/README.md` (the file has been removed).

**When:** After the Codex app-server protocol reaches a stable release with documented compaction semantics.

---

## 3. `turn/steer` for concurrent-send support

**What:** The Codex protocol supports `turn/steer` to inject operator input mid-turn (before the current turn completes). kbbl currently queues sends until the turn is done; wiring `turn/steer` would allow the operator to interrupt or redirect in-flight reasoning.

**Complexity:** Requires knowing whether the current session is mid-turn (turn boundary state). The `result` event already signals turn completion; the parallel hook for "turn started" is `runtime_session_observed` / `assistant_delta` arrival.

---

## 4. Auto-reattach after app-server crash

**What:** When the codex app-server process crashes, live Codex sessions receive `runtime_disconnected` and finalize. kbbl does not attempt to reattach. A restart of kbbl reconnects, but any in-flight turn is lost.

**What a fix looks like:** Watch the app-server process exit code; on unclean exit, attempt to restart the process (with backoff) and reconnect active sessions via `thread/subscribe` using the persisted thread id from `runtime_session_observed`.

**Risk:** Reconnection may silently miss events that arrived between crash and reattach; the JSONL transcript would have a gap. Need to define gap-fill semantics before implementing.

---

## 5. Cross-runtime resume semantics, if ever needed

**What:** A session started under `claude-code` cannot currently be resumed as `codex` or vice versa. If an operator wants to continue work from a CC session using Codex (or vice versa), there is no path.

**If pursued:** The handoff markdown (from CC compaction) is a natural bridge — it's plain text the operator controls. A cross-runtime resume could read the handoff doc and use it as the initial prompt for a new Codex session. The harder part is making the PWA's "resume" flow runtime-aware (currently it forks via the source session's adapter).

**Decision to revisit:** Only if operators express a concrete need. The complexity is non-trivial; the current per-runtime-silo behavior is intentional.
