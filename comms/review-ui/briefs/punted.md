# Punted items

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

---

## Cohort detail thread list shows raw anchor paths (from cohort-3 PR review)

**Files:** `CohortPanel.tsx`

**Issue:** `ThreadListItem` displays the raw atom anchor string (e.g. `cohorts[0].notes`,
`cohorts[0].title`) as the visible label in the cohort-detail thread list. This is a developer-facing
path format, not a user-facing label. The legacy panel never exposed this list.

**Fix when addressed:** Map anchor tails to friendly labels (e.g. `cohorts[N].title` → "Title",
`cohorts[N].notes` → "Notes", `cohorts[N].<field>` → `<field>` capitalised). Or render the anchor
only as a `title`/tooltip and show a friendlier primary label.

**Why punted:** Whether the audience for this view is reviewers (need friendly labels) or developers
(anchor paths are acceptable) is a product/UX call outside the cohort-3 brief scope.

---

## Cohort notes section invisible in edit mode when notes start empty (from cohort-3 PR review)

**Files:** `CohortPanel.tsx`

**Issue:** The Notes section renders only when `cohort.notes || liveNotes` is truthy (line 70).
A cohort with no notes at all never shows the section in edit mode — there is no affordance to start
adding notes, and the `AtomCommentAffordance` for the notes anchor is also hidden.

**Fix when addressed:** Change the condition to also show the section in edit mode:
```tsx
{(cohort.notes || liveNotes || mode === "edit") && (
```
This makes the empty-notes field visible when the canvas is editable, matching the expected
behaviour for write-enabled review sessions.

**Why punted:** Whether adding notes to a notes-less cohort is a supported edit-mode workflow is a
product decision. The cohort-3 brief was focused on the className migration, not edit-mode
completeness. Surface in the cohort that adds edit-mode authoring hardening.

---

## useViewport test coverage (from cohort-2 review)

**Files:** `useViewport.ts`

**Issue:** `useViewport()` drives responsive layout across views but has no unit tests. The hook
involves non-trivial setup: `window.matchMedia` change listeners, a `window.resize` listener, and
`useState` initialization from `window.innerWidth`. Testing it requires jsdom matchMedia stubs that
aren't otherwise needed in this test suite.

**Fix when addressed:** Add `useViewport.test.ts` in `review/shared/`. Stub `window.innerWidth` and
`window.matchMedia` via `vi.stubGlobal` / `Object.defineProperty`. Assert correct `isPhone /
isTablet / isDesktop` values for representative widths, and verify listener cleanup on unmount
(capture `addEventListener` / `removeEventListener` call counts).

**Why punted:** Cohort-2 brief scope was layout behavior, not hook test infrastructure. The jsdom
matchMedia stub work is a non-trivial setup investment. Surface in the cohort that hardens shared
hook coverage.
