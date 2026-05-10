// The /compact request kbbl writes to CC's stdin when runCompact fires.
// CC interprets the leading "/compact" as a slash command and the rest
// as the prompt body. The handoff parser (handoff-doc.ts) consumes
// CC's response per the section template below; section names are
// slug-matched, so light paraphrasing by the model still parses.

export const COMPACT_PROMPT = `/compact Produce a handoff document with these sections (markdown):

## Goal
The current top-level goal and any active subgoals (one per bullet).

## Decisions made
Each as one bullet with a one-line rationale, separated by ":" or "—".

## Approaches rejected
Each with a one-line reason, so the next phase doesn't re-litigate.

## Files & state in scope
Files touched, key paths, environment state worth carrying forward.

## Open questions
Things deferred or unresolved (one per bullet).

## Next concrete action
The single next thing to do when this resumes (one line, no list).

Drop verbose tool traces and resolved discussion. Be terse.`;
