import type {
  EnvelopeEvent,
  SystemStatusPayload,
  CCAssistantPayload,
  CCUserPayload,
  ResolutionMap,
  PermissionRequestPayload,
  ListItem,
  SessionMetrics,
} from "../types";

export interface ResultUsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

export interface ResultPayload {
  duration_ms?: unknown;
  total_cost_usd?: unknown;
  usage?: ResultUsagePayload;
}

interface ToolInputPreviewPayload {
  command?: unknown;
  file_path?: unknown;
  pattern?: unknown;
  url?: unknown;
  query?: unknown;
}

export interface SystemNoticePayload extends ResultPayload {
  sessionId?: unknown;
  reason?: unknown;
  code?: unknown;
  line?: unknown;
  enabled?: unknown;
  tool_name?: unknown;
  cc_session_id?: unknown;
}

export function resultPayload(value: unknown): ResultPayload {
  return value && typeof value === "object" ? (value as ResultPayload) : {};
}

export function isCompactStartEvent(e: EnvelopeEvent): boolean {
  if (e.type !== "system") return false;
  const p = e.payload as SystemStatusPayload | null;
  return p?.subtype === "status" && p.status === "compacting";
}

export function isCompactDoneEvent(e: EnvelopeEvent): boolean {
  if (e.type !== "system") return false;
  const p = e.payload as SystemStatusPayload | null;
  return (
    p?.subtype === "status" &&
    p.status === null &&
    typeof p.compact_result === "string"
  );
}

// Consecutive tool_use / tool_result events get folded into a single
// collapsible "N tool calls" section so a YOLO-mode turn that fires 20 file
// reads doesn't blow the transcript out vertically. A non-tool event (text
// reply, an unresolved permission card, a real system notice) breaks the
// batch and renders inline.
export function isToolOnlyEvent(e: EnvelopeEvent): boolean {
  if (e.type === "assistant") {
    const p = e.payload as CCAssistantPayload;
    const blocks = p.message?.content;
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    return blocks.every((b) => b.type === "tool_use");
  }
  if (e.type === "user") {
    const p = e.payload as CCUserPayload;
    const content = p.message?.content;
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every((b) => b.type === "tool_result");
  }
  return false;
}

export function isFilteredEvent(
  e: EnvelopeEvent,
  resolutions: ResolutionMap,
  showSystemEvents: boolean,
): boolean {
  // Mirrors what EventRow returns null for, so batching doesn't accidentally
  // break across an event that wouldn't have rendered anyway.
  if (e.type === "permission_resolved") return true;
  // Hard-filter streaming delta events independent of showSystemEvents — the
  // partial-message deltas are reconstructed by InFlightAssistantRow, never as
  // a row. Without this, "show system events" would flood the transcript with
  // one chunk per token during long generations.
  if (e.type === "stream_event") return true;
  if (e.type === "assistant_delta") return true;
  if (showSystemEvents) return false;
  if (isLowSignalEvent(e)) return true;
  if (e.type === "permission_auto_approved" || e.type === "permission_auto_denied") return true;
  if (e.type === "permission_request") {
    const p = e.payload as PermissionRequestPayload;
    return resolutions.has(p.request_id);
  }
  return false;
}

// Compact-mode hides the chatter that surfaces because we run CC with
// --include-hook-events plus the bookkeeping the gate emits as it
// resolves, plus per-turn lifecycle events that don't carry operator-
// actionable info. The signal is the assistant turn + tool_use/tool_result;
// the rest is plumbing.
export function isLowSignalEvent(event: EnvelopeEvent): boolean {
  switch (event.type) {
    case "tool_allowlisted":
    case "session_started":
    case "result":
      return true;
    case "system":
      // CC emits `system` for init, hook_started, hook_response, etc.
      // None of these are operator-actionable; the transcript already
      // shows the work happening via assistant/tool events.
      return true;
    case "stream_event":
    case "assistant_delta":
      // Partial-message deltas (CC: stream_event, Codex: assistant_delta). The
      // InFlightAssistantRow renders the reconstructed message; the raw
      // per-chunk events would just be transcript noise.
      return true;
    case "usage_observation":
      // Per-turn cache-vs-idle telemetry (kbbl/core/session/session.ts).
      // Phase 6.2 will consume these for the cost panel; until then,
      // hiding them keeps the transcript clean during the baseline soak.
      return true;
    default:
      return false;
  }
}

// Find the id of the last event that renders as a textual message bubble (a
// user string or an assistant text block). Tool calls, results, system
// notices, etc. are skipped. Used to pin a timestamp to the bottom-most
// message only — every-message timestamps drown the transcript.
export function lastMessageEventId(events: EnvelopeEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "user") {
      const p = e.payload as CCUserPayload & { isSynthetic?: boolean };
      const content = p.message?.content;
      // Synthetic users (post-compact summaries, skill bodies) and
      // <local-command-stdout> wrappers don't render a normal bubble, so
      // they shouldn't claim the "latest" timestamp slot — that would
      // strand the timestamp on an invisible row.
      if (
        p.isSynthetic !== true &&
        typeof content === "string" &&
        parseLocalCommandStdout(content) === null
      ) {
        return e.id;
      }
    } else if (e.type === "assistant") {
      const p = e.payload as CCAssistantPayload;
      // Cast to unknown — Codex assistant events carry content as a plain string
      // at runtime even though CCAssistantPayload types it as ContentBlock[].
      const content: unknown = p.message?.content;
      if (typeof content === "string" && content.length > 0) return e.id;
      if (Array.isArray(content) && (content as { type?: string }[]).some((b) => b.type === "text")) return e.id;
    }
  }
  return null;
}

export function computeMetrics(events: EnvelopeEvent[]): SessionMetrics {
  const m: SessionMetrics = {
    turns: 0,
    totalIn: 0,
    totalOut: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    totalCost: 0,
    totalDur: 0,
    last: null,
  };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  // CC's result events carry total_cost_usd as a session-cumulative running
  // total, not a per-turn delta. Summing would triple-count by the fourth
  // turn. Track the previous event's cumulative value so the "last" chip can
  // surface a true per-turn delta. cumCost is kept nullable so a malformed
  // result event without a numeric total_cost_usd does not (a) reset
  // m.totalCost to 0 nor (b) push m.last.cost negative via `0 - prevCost`.
  let prevCost = 0;
  for (const e of events) {
    if (e.type !== "result") continue;
    const p = resultPayload(e.payload);
    const usage = p.usage ?? {};
    const inT = num(usage.input_tokens);
    const outT = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    const dur = num(p.duration_ms);
    const cumCost =
      typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
    m.turns++;
    m.totalIn += inT;
    m.totalOut += outT;
    m.totalCacheRead += cacheRead;
    m.totalCacheCreate += cacheCreate;
    m.totalDur += dur;
    if (cumCost !== null) m.totalCost = cumCost;
    // Treat a non-monotonic cumulative (e.g. provider reset) as a fresh
    // baseline rather than emitting a negative delta.
    const turnCost =
      cumCost === null ? 0 : cumCost >= prevCost ? cumCost - prevCost : cumCost;
    m.last = { inT, outT, cacheRead, cacheCreate, dur, cost: turnCost };
    if (cumCost !== null) prevCost = cumCost;
  }
  return m;
}

export function buildListItems(
  events: EnvelopeEvent[],
  resolutions: ResolutionMap,
  showSystemEvents: boolean,
): ListItem[] {
  const items: ListItem[] = [];
  let batch: EnvelopeEvent[] = [];
  const flush = () => {
    if (batch.length > 0) {
      items.push({ kind: "tool_batch", events: batch, firstId: batch[0].id });
      batch = [];
    }
  };
  for (const e of events) {
    // Compact-status events are operator-actionable signal regardless of
    // showSystemEvents — fold the start+done pair into a single live pill.
    if (isCompactStartEvent(e)) {
      flush();
      items.push({ kind: "compact", startEvent: e, doneEvent: null });
      continue;
    }
    if (isCompactDoneEvent(e)) {
      let attached = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "compact" && it.doneEvent === null) {
          it.doneEvent = e;
          attached = true;
          break;
        }
      }
      if (attached) continue;
    }
    if (isFilteredEvent(e, resolutions, showSystemEvents)) continue;
    if (isToolOnlyEvent(e)) {
      batch.push(e);
    } else {
      flush();
      items.push({ kind: "event", event: e });
    }
  }
  flush();
  return items;
}

export function summarizeToolNames(names: string[]): string {
  // Group runs of the same tool: ["Read","Read","Bash"] -> "Read×2, Bash"
  const groups: Array<{ name: string; count: number }> = [];
  for (const n of names) {
    const last = groups[groups.length - 1];
    if (last && last.name === n) last.count++;
    else groups.push({ name: n, count: 1 });
  }
  return groups
    .map((g) => (g.count > 1 ? `${g.name}×${g.count}` : g.name))
    .join(", ");
}

export function previewToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as ToolInputPreviewPayload;
  const pick = (k: keyof ToolInputPreviewPayload): string | null =>
    typeof i[k] === "string" ? i[k] : null;
  let raw: string | null = null;
  switch (name) {
    case "Bash":
      raw = pick("command");
      break;
    case "Read":
    case "Write":
    case "NotebookEdit":
      raw = pick("file_path");
      break;
    case "Edit":
      raw = pick("file_path");
      break;
    case "Glob":
      raw = pick("pattern");
      break;
    case "Grep":
      raw = pick("pattern");
      break;
    case "WebFetch":
    case "WebSearch":
      raw = pick("url") ?? pick("query");
      break;
    case "TodoWrite":
      raw = "(todo list)";
      break;
  }
  if (!raw) raw = JSON.stringify(input);
  return raw.length > 90 ? raw.slice(0, 90) + "…" : raw;
}

// CC expands a `/foo bar` invocation into a giant blob that begins with
// `<command-message>`, `<command-name>`, `<command-args>` and then the full
// skill body. Rendered raw it dominates the transcript; collapse it to a
// single chip showing the invocation, with the full body one tap away.
export function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  if (!text.startsWith("<command-")) return null;
  const nameMatch = text.match(/<command-name>\s*\/?([^<]*)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  return {
    name: nameMatch[1].trim(),
    args: argsMatch ? argsMatch[1].trim() : "",
  };
}

// CC re-injects local command output (e.g. a leading `!` bash invocation)
// as a synthetic user message wrapped in <local-command-stdout>…</local-
// command-stdout>. Rendered raw it looks like an operator typed the output;
// collapse to a single system pill so the transcript doesn't lie about who
// produced the bytes.
export function parseLocalCommandStdout(text: string): string | null {
  if (!text.startsWith("<local-command-stdout>")) return null;
  const m = text.match(
    /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/,
  );
  return m ? m[1] : null;
}

export function formatResultText(p: ResultPayload): string {
  const dur = typeof p.duration_ms === "number" ? p.duration_ms : null;
  const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
  const usage = p.usage ?? {};
  const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outTok =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const parts: string[] = ["turn complete"];
  if (dur !== null) parts.push(`${(dur / 1000).toFixed(1)}s`);
  if (inTok || outTok) parts.push(`${inTok}→${outTok} tok`);
  if (cost !== null && cost > 0) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(" · ");
}
