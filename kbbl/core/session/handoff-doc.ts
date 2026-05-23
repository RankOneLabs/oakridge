// Handoff doc parser + Zod schema. Pure data layer — no side effects, no
// runtime integration. runCompact invokes parseHandoffMarkdown on the
// markdown extracted from CC's /compact response, then persists
// raw_markdown to disk.
//
// The parser is intentionally permissive: per-section parse failures
// leave that section at its default; raw_markdown is always preserved.
// A garbage handoff still produces a usable HandoffDoc whose
// raw_markdown is the input — the successor session can read the
// markdown directly even if the structured fields are empty.

import { z } from "zod";

export const HandoffDocSchema = z
  .object({
    schema_version: z.literal(1),
    from_session_id: z.string().nullable(),
    to_session_id: z.string().nullable(),
    produced_at: z.string(),
    goal: z.string().default(""),
    active_subgoals: z.array(z.string()).default([]),
    decisions_made: z
      .array(z.object({ decision: z.string(), rationale: z.string() }))
      .default([]),
    approaches_rejected: z
      .array(z.object({ approach: z.string(), reason: z.string() }))
      .default([]),
    files_in_scope: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([]),
    next_action: z.string().default(""),
    raw_markdown: z.string(),
  })
  .strict();

export type HandoffDoc = z.infer<typeof HandoffDocSchema>;

export interface HandoffParseContext {
  from_session_id: string;
  produced_at: string;
}

function splitSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = md.split("\n");
  let currentSlug: string | null = null;
  let currentLines: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (currentSlug !== null) {
        out.set(currentSlug, currentLines.join("\n").trim());
      }
      currentSlug = slugify(m[1]!);
      currentLines = [];
    } else if (currentSlug !== null) {
      currentLines.push(line);
    }
  }
  if (currentSlug !== null) {
    out.set(currentSlug, currentLines.join("\n").trim());
  }
  return out;
}

const SLUG_STOPWORDS = new Set(["and", "or", "the", "of", "a", "an"]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((tok) => tok && !SLUG_STOPWORDS.has(tok))
    .join(" ");
}

const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;

function parseBullets(body: string): string[] {
  if (!body.trim()) return [];
  const items: string[] = [];
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = BULLET_RE.exec(line);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[1]!;
    } else if (current !== null && line.trim().length > 0) {
      // Continuation: any non-empty, non-bullet line after a bullet.
      // CC sometimes wraps long bullets without indenting the wrap.
      current += " " + line.trim();
    }
  }
  if (current !== null) items.push(current.trim());
  return items.filter((s) => s.length > 0);
}

function splitDecisionBullet(s: string): { decision: string; rationale: string } {
  const m = /^(.+?)\s*[:—–\-]\s+(.+)$/.exec(s);
  if (m) {
    return { decision: m[1]!.trim(), rationale: m[2]!.trim() };
  }
  return { decision: s.trim(), rationale: "" };
}

function splitApproachBullet(s: string): { approach: string; reason: string } {
  const d = splitDecisionBullet(s);
  return { approach: d.decision, reason: d.rationale };
}

export function parseHandoffMarkdown(
  md: string,
  ctx: HandoffParseContext,
): HandoffDoc {
  const sections = splitSections(md);

  const goalBody = sections.get("goal") ?? "";
  const goalLines = goalBody.split("\n");
  const firstNonBulletIdx = goalLines.findIndex(
    (l) => l.trim() && !/^\s*(?:[-*]|\d+\.)\s+/.test(l),
  );
  const goalText =
    firstNonBulletIdx >= 0 ? goalLines[firstNonBulletIdx]!.trim() : "";
  const subgoalBody = goalLines
    .slice(firstNonBulletIdx >= 0 ? firstNonBulletIdx + 1 : 0)
    .join("\n");
  const activeSubgoals = parseBullets(subgoalBody);

  const decisionsBody = sections.get("decisions made") ?? "";
  const decisionsMade = parseBullets(decisionsBody).map(splitDecisionBullet);

  const approachesBody = sections.get("approaches rejected") ?? "";
  const approachesRejected = parseBullets(approachesBody).map(
    splitApproachBullet,
  );

  const filesBody = sections.get("files state in scope") ?? "";
  const filesInScope = parseBullets(filesBody);

  const openBody = sections.get("open questions") ?? "";
  const openQuestions = parseBullets(openBody);

  const nextBody = sections.get("next concrete action") ?? "";
  const nextAction = nextBody.split("\n")[0]?.trim() ?? "";

  return HandoffDocSchema.parse({
    schema_version: 1,
    from_session_id: ctx.from_session_id,
    to_session_id: null,
    produced_at: ctx.produced_at,
    goal: goalText,
    active_subgoals: activeSubgoals,
    decisions_made: decisionsMade,
    approaches_rejected: approachesRejected,
    files_in_scope: filesInScope,
    open_questions: openQuestions,
    next_action: nextAction,
    raw_markdown: md,
  });
}
