import type { TranscriptItem } from "./transcript-model";
import type {
  KbblSessionId,
  Result,
  TerminalSessionSummary,
  TerminalSessionSummaryDraft,
} from "./types";

export interface SessionSummaryRequest {
  readonly session_id: KbblSessionId;
  readonly items: readonly TranscriptItem[];
  readonly produced_at: string;
}

export interface SessionSummaryFailure {
  readonly operation: "generate_session_summary";
  readonly method: TerminalSessionSummary["method"];
  readonly session_id: KbblSessionId;
  readonly detail: string;
}

/** Replaceable boundary: provider commands never leak into session lifecycle. */
export interface SessionSummaryGenerator {
  readonly method: TerminalSessionSummary["method"];
  generate(request: SessionSummaryRequest): Promise<Result<TerminalSessionSummaryDraft, SessionSummaryFailure>>;
}

/**
 * Explicit manual-compaction adapter. ACP exposes slash commands as ordinary
 * prompts, so this recognizes a completed operator `/compact` turn and keeps
 * its response as the terminal handoff. A future native ACP generator can be
 * placed ahead of it without changing storage, close/fence, or history.
 */
export class ManualCompactionSummaryGenerator implements SessionSummaryGenerator {
  readonly method = "manual_compaction" as const;

  async generate(request: SessionSummaryRequest): Promise<Result<TerminalSessionSummaryDraft, SessionSummaryFailure>> {
    const lastUserMessage = request.items.findLast((item) => item.kind === "user_message");
    const trigger = lastUserMessage?.text.trim() ?? "";
    if (!trigger.startsWith("/compact")) {
      return { ok: false, error: summaryFailure(this.method, request.session_id, "the final turn was not manual compaction") };
    }
    const compacted = selectFinalAssistantMarkdown(request.items);
    if (!compacted) {
      return { ok: false, error: summaryFailure(this.method, request.session_id, "manual compaction produced no assistant response") };
    }
    return {
      ok: true,
      value: {
        schema_version: 1,
        session_id: request.session_id,
        method: this.method,
        produced_at: request.produced_at,
        markdown: compacted,
      },
    };
  }
}

/** The safe zero-extra-turn fallback: retain only the last assistant answer. */
export class FinalResponseSummaryGenerator implements SessionSummaryGenerator {
  readonly method = "final_response" as const;

  async generate(request: SessionSummaryRequest): Promise<Result<TerminalSessionSummaryDraft, SessionSummaryFailure>> {
    const markdown = selectFinalAssistantMarkdown(request.items);
    if (!markdown) {
      return {
        ok: false,
        error: {
          operation: "generate_session_summary",
          method: this.method,
          session_id: request.session_id,
          detail: "the final turn contains no assistant response",
        },
      };
    }
    return {
      ok: true,
      value: {
        schema_version: 1,
        session_id: request.session_id,
        method: this.method,
        produced_at: request.produced_at,
        markdown,
      },
    };
  }
}

function summaryFailure(
  method: TerminalSessionSummary["method"],
  session_id: KbblSessionId,
  detail: string,
): SessionSummaryFailure {
  return { operation: "generate_session_summary", method, session_id, detail };
}

export function selectFinalAssistantMarkdown(items: readonly TranscriptItem[]): string | null {
  const lastUserIndex = items.findLastIndex((item) => item.kind === "user_message");
  const markdown = items
    .slice(lastUserIndex + 1)
    .filter((item) => item.kind === "agent_message")
    .map((item) => item.text)
    .join("")
    .trim();
  return markdown || null;
}

export async function generateSessionSummary(
  request: SessionSummaryRequest,
  generators: readonly SessionSummaryGenerator[],
): Promise<Result<TerminalSessionSummaryDraft, readonly SessionSummaryFailure[]>> {
  const failures: SessionSummaryFailure[] = [];
  for (const generator of generators) {
    const generated = await generator.generate(request);
    if (generated.ok) return generated;
    failures.push(generated.error);
  }
  return { ok: false, error: failures };
}
