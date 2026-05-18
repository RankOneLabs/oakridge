# Punted items

## Approve / Reject button contrast (from cohort-0 rename pass)

**Files:** `ApproveModal.tsx`, `RejectModal.tsx`, `PlanReviewView.tsx`, `BriefReviewView.tsx`

**Issue:** The cohort-0 rename table mapped `var(--success, #2a7a2a)` → `var(--success-fg)` and
`var(--danger, #7a2a2a)` → `var(--danger-fg)`. Those original hex values were dark backgrounds; the
retarget lands on foreground tokens. In dark mode `--success-fg` is `#7dd890` (light green) and
`--danger-fg` is `#e67070` (light red) — both fail AA contrast with white text.

**Fix when addressed:** Use `--danger-bg` / `--danger-fg` (background + text) for Reject buttons.
For Approve, use `--status-connected-bg` / `--status-connected-fg` until a dedicated `--success-bg`
token is defined. Both pairs are already in both themes.

**Why punted:** Cohort-0 brief required verbatim application of the rename table; introducing
`--success-bg` or deviating from the table was out of scope. Surface in the cohort that adds
button/action token infrastructure.

---

## Sheet focus trap (from cohort-2 review)

**Files:** `Sheet.tsx`

**Issue:** `Sheet` focuses the first focusable element on open and returns focus to the trigger on
close, but Tab/Shift-Tab can still escape the panel — there is no focus trap cycling between the
first and last focusable elements inside the sheet.

**Fix when addressed:** On `keydown` inside the open panel, intercept Tab and Shift-Tab, query all
focusable descendants, and wrap focus from last→first (Tab) and first→last (Shift-Tab). Libraries
like `focus-trap-react` handle this; or implement the query loop manually.

**Why punted:** Cohort-2 brief only called for focus-on-open and return-on-close. A full focus trap
requires either a dependency or a non-trivial focusable-query implementation — both are brief-level
decisions. Surface in the cohort that adds accessibility hardening.

---

## CLAUDE.md inline-style rule vs. className vocabulary (from cohort-3 PR review)

**Files:** `kbbl/core/pwa/review/**`

**Issue:** `CLAUDE.md` contains a rule: "Inline styles are tolerated, not encouraged. Keep inline
`style={{}}` as the consistent pattern… Don't add className strings against styles.css for new
components." Cohort-3's brief explicitly required the opposite — migrating all inline styles to a
CSS class vocabulary in `styles.css`. CodeRabbit flagged every changed file as a violation of the
CLAUDE.md rule.

**The brief wins:** The className migration was a decisions-made constraint in the brief, not a
deviation. The CLAUDE.md rule predates this architectural decision.

**Fix when addressed:** Update the CLAUDE.md rule under `kbbl/core/pwa/review/` to reflect that the
class vocabulary in `styles.css` is now the canonical styling layer for this subtree. The old
inline-style guidance no longer applies here.

**Why punted:** Editing `CLAUDE.md` is a team convention change — needs explicit user confirmation
before writing. Surfaced here so it doesn't get lost.
