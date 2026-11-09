import { Chip } from "../../../components/atoms/Chip";
import type { AutomaticGlance, AutomaticGlyph } from "../../lib/grading";

const GLYPHS: Readonly<Record<AutomaticGlyph, string>> = {
  affirmative: "✓", negative: "✗", unclear: "?", not_ready: "◌", waiting: "…", budget_deferred: "$", failed: "!", grading_off: "⊘",
};

/** Each automatic evaluator's state on each question, as one glyph. Rendered only when revealed. */
export function AutomaticGradeIcons({ glances }: { glances: readonly AutomaticGlance[] }) {
  if (glances.length === 0) return <span className="text-xs text-[var(--text-muted)]" data-testid="or-automatic-grades-none">No automatic evaluator</span>;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="or-automatic-grades">
      {glances.map((glance) => (
        <span key={glance.key} role="img" title={glance.label} aria-label={glance.label} data-testid="or-automatic-grade" data-glyph={glance.glyph}>
          <Chip tone={glance.tone} className="px-1.5!">{GLYPHS[glance.glyph]}</Chip>
        </span>
      ))}
    </span>
  );
}
