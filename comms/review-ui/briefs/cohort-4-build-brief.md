# Cohort 4 — Hardening pass: focus trap, friendly labels, edit-mode notes, hook tests, stale-punt cleanup — build brief

## Goal
Resolve the four active deferred issues in
`comms/review-ui/briefs/punted.md` that are addressable without a full
planning cycle, plus retire one stale entry that has already been
resolved upstream. End state:

- `Sheet` traps Tab / Shift-Tab focus inside the open panel (wraps
  last→first and first→last); the existing `Sheet.test.tsx` is extended
  with a focus-cycle assertion.
- `CohortPanel`'s thread list renders friendly labels ("Title",
  "Notes") instead of raw anchor paths (`cohorts[N].title`,
  `cohorts[N].notes`); the raw anchor remains accessible via the row's
  `title` attribute for developer use.
- `CohortPanel`'s Notes section renders in edit mode even when the
  cohort has no notes yet, exposing the notes anchor's
  `AtomCommentAffordance` and a placeholder body — matching the
  expected behaviour for write-enabled review sessions.
- `useViewport` has a unit test file (`useViewport.test.ts`) covering
  initial-width derivation, resize-driven updates, matchMedia-driven
  updates, and listener cleanup on unmount.
- `punted.md` entry #1 ("Approve / Reject button contrast") is
  deleted — Cohort 3's inline-style sweep moved both modals onto the
  proper `.btn-approve` (`--accent-blue` + `#ffffff`) and `.btn-deny`
  (`--danger-bg` + `--danger-fg`) class pairs, eliminating the
  foreground-token-as-background problem the entry described.

No new tokens, no new dependencies, no behaviour change in chrome
beyond the focus trap, and no JSX outside the four targeted files.
Existing tests must continue to pass; two new tests land (focus-trap
assertion in `Sheet.test.tsx`, full `useViewport.test.ts`).

## Active subgoals
Five sequential commits. Each leaves the tree green (`bun run test:pwa`
and the existing build pass). The order is:

1. **Delete the stale punt #1 entry from `punted.md`.** Remove the
   entire `## Approve / Reject button contrast (from cohort-0 rename
   pass)` block (heading + body + the trailing `---` separator that
   precedes the next entry). The next entry (`## Sheet focus trap`)
   becomes the first item in the file. Do NOT renumber any remaining
   entries (they are headers, not numbered) and do NOT edit any other
   entry. Run the existing test suite once to confirm nothing
   references the deleted block.
   Exit signal: `grep -n "Approve / Reject button contrast" comms/review-ui/briefs/punted.md`
   returns zero; `bun run test:pwa` passes; the file still parses as
   valid markdown (other entries unchanged).

2. **Add Tab / Shift-Tab focus trap to `Sheet.tsx`.** Edit
   `kbbl/core/pwa/review/shared/Sheet.tsx`. The existing component
   already focuses the first focusable child on open and returns focus
   to `previousFocusRef` on close. Add an `onKeyDown` handler on the
   `sheet__panel` `<div>` (not document-level) that:
   - intercepts `Tab` / `Shift+Tab`;
   - re-queries focusable descendants of `panelRef.current` using the
     same selector string already in the file
     (`'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'`);
   - if no focusable descendants exist, returns without calling
     `preventDefault` (allow default behaviour — there is nothing to
     trap);
   - if exactly one focusable descendant exists, calls
     `e.preventDefault()` and focuses that element (keeps focus pinned);
   - if multiple, on `Tab` from the last element wraps focus to the
     first (calls `preventDefault` + `first.focus()`); on `Shift+Tab`
     from the first element wraps focus to the last (calls
     `preventDefault` + `last.focus()`); otherwise lets the browser
     handle the focus move.
   The handler is attached only via the JSX `onKeyDown` prop on the
   `sheet__panel` `<div>`; no document-level listener and no new ref
   beyond `panelRef`. The existing focus-on-open and
   restore-on-close `useEffect` blocks are not changed. The existing
   `Escape`-key handler stays document-level — focus-trap and Escape
   are independent concerns.

   Then extend `kbbl/core/pwa/review/shared/Sheet.test.tsx` with a new
   test case:

   ```ts
   it("traps Tab focus inside the panel", () => {
     render(
       <Sheet open={true} side="right" onClose={vi.fn()}>
         <button>A</button>
         <button>B</button>
         <button>C</button>
       </Sheet>,
     );
     const a = screen.getByText("A");
     const b = screen.getByText("B");
     const c = screen.getByText("C");
     // Initial focus lands on A (existing behaviour).
     expect(document.activeElement).toBe(a);
     // Tab from last (C) wraps to first (A).
     c.focus();
     fireEvent.keyDown(c, { key: "Tab" });
     expect(document.activeElement).toBe(a);
     // Shift+Tab from first (A) wraps to last (C).
     a.focus();
     fireEvent.keyDown(a, { key: "Tab", shiftKey: true });
     expect(document.activeElement).toBe(c);
     // Tab from middle (B) does not wrap — defer to browser default
     // (no preventDefault, no focus change in jsdom).
     b.focus();
     fireEvent.keyDown(b, { key: "Tab" });
     expect(document.activeElement).toBe(b);
   });
   ```

   The test fires `keyDown` on the focused element rather than on
   `document`, because the handler lives on the panel's `onKeyDown`
   prop and React event delegation surfaces the event through the
   focused descendant.
   Exit signal: `bun run test:pwa -- Sheet` passes including the new
   case; the existing four Sheet tests still pass; manual smoke at
   phone width on `PlanReviewView` confirms Tab cycles inside the
   threads sheet.

3. **Add `useViewport.test.ts`.** Create
   `kbbl/core/pwa/review/shared/useViewport.test.ts`. Use vitest's
   `renderHook` from `@testing-library/react` (already a dependency —
   `Sheet.test.tsx` imports from it). Stub `window.innerWidth` via
   `Object.defineProperty(window, "innerWidth", { configurable: true,
   writable: true, value: <N> })` (defineProperty is needed because
   `innerWidth` is normally read-only in jsdom). Stub `window.matchMedia`
   via `vi.stubGlobal("matchMedia", …)` returning a minimal
   `MediaQueryList` shim per call:

   ```ts
   function makeMatchMedia() {
     const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
     return vi.fn((query: string) => ({
       matches: false,
       media: query,
       addEventListener: (type: string, cb: any) => {
         if (!listeners.has(type)) listeners.set(type, new Set());
         listeners.get(type)!.add(cb);
       },
       removeEventListener: (type: string, cb: any) => {
         listeners.get(type)?.delete(cb);
       },
       __listeners: listeners,
     }));
   }
   ```

   The shim's `matches` field is unused by `useViewport` (the hook
   recomputes from `innerWidth` on every change event), so a constant
   `false` is acceptable. Reset stubs in a `beforeEach` /
   `afterEach` to keep tests independent.

   The test file asserts five cases:

   - **Initial derivation at phone width.** Set `innerWidth = 380`,
     stub `matchMedia`, `renderHook(() => useViewport())`, expect
     `result.current` is `{ width: 380, isPhone: true, isTablet:
     false, isDesktop: false }`.
   - **Initial derivation at tablet width.** `innerWidth = 800`,
     expect `{ width: 800, isPhone: false, isTablet: true, isDesktop:
     false }`.
   - **Initial derivation at desktop width.** `innerWidth = 1440`,
     expect `{ width: 1440, isPhone: false, isTablet: false,
     isDesktop: true }`.
   - **Resize-driven update.** Render at `innerWidth = 380`, then set
     `innerWidth = 1440`, then `act(() => window.dispatchEvent(new
     Event("resize")))`, expect `result.current.isDesktop` becomes
     `true` and `result.current.isPhone` becomes `false`.
   - **Listener cleanup on unmount.** Spy on
     `window.removeEventListener` via `vi.spyOn`. Render, then call
     `unmount()`. Expect `removeEventListener` was called at least
     once with the string `"resize"`. (matchMedia's
     `removeEventListener` is on the stubbed object, not on `window`,
     so the cleanup of those three listeners is implicit in the shim
     and not directly observable — the `resize` listener removal is
     the observable proxy for "cleanup ran".)

   Imports for the test file:

   ```ts
   import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
   import { renderHook, act } from "@testing-library/react";
   import { useViewport } from "./useViewport";
   ```

   Exit signal: `bun run test:pwa -- useViewport` passes all five
   cases; the rest of the suite is unaffected.

4. **CohortPanel — friendly thread labels.** Edit
   `kbbl/core/pwa/review/plan/CohortPanel.tsx`. Replace the inline
   `<span className="cohort-detail__thread-anchor">{thread.anchor}</span>`
   inside the existing `ThreadListItem` helper with a friendly label
   derived from the anchor tail. Add a small helper at the top of the
   file (above `ThreadListItem`):

   ```ts
   function friendlyAnchorLabel(anchor: string | null | undefined): string {
     if (!anchor) return "(unanchored)";
     const m = anchor.match(/\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
     if (!m) return anchor;
     const tail = m[1];
     return tail.charAt(0).toUpperCase() + tail.slice(1);
   }
   ```

   In `ThreadListItem`, render the friendly label as the visible text,
   and add `title={thread.anchor ?? ""}` to the row's `<button>` so the
   raw anchor remains hover-accessible for developers / power users.
   The CSS class `.cohort-detail__thread-anchor` is preserved (the
   span keeps its className) — only the text content changes.
   No other JSX or behaviour changes in this file in this commit.

   The decision rationale (anchor pattern is `cohorts[N].<field>`;
   tail-after-last-dot is the field name; fall back to raw anchor if
   the pattern doesn't match) is sufficient for every anchor produced
   by the current plan schema. The current `Cohort` schema fields are
   `title` and `notes` (see `kbbl/core/pwa/review/plan/types.ts`), so
   the two labels rendered today are "Title" and "Notes"; any future
   cohort field plugs into the same mapping automatically.

   Exit signal: open a cohort in `PlanReviewView` with at least one
   thread on the title anchor — the thread row reads "Title", not
   `cohorts[0].title`; hovering the row surfaces the raw anchor via
   the native `title` tooltip; `bun run test:pwa` still passes (no
   tests assert on this string today).

5. **CohortPanel — Notes section visible in edit mode when empty.**
   Edit `kbbl/core/pwa/review/plan/CohortPanel.tsx`. Change the gate
   on the Notes section from:

   ```tsx
   {(cohort.notes || liveNotes) && (
   ```

   to:

   ```tsx
   {(cohort.notes || liveNotes || mode === "edit") && (
   ```

   Inside the existing block, replace the `<div
   className="cohort-detail__notes">{liveNotes}</div>` with:

   ```tsx
   <div className="cohort-detail__notes">
     {liveNotes || (
       <span className="cohort-detail__notes-empty">No notes yet.</span>
     )}
   </div>
   ```

   Add the placeholder class `.cohort-detail__notes-empty` to
   `kbbl/core/pwa/styles.css`, placed immediately after the existing
   `.cohort-detail__notes` rule (around line 2200, in the
   `/* --- plan canvas: cohort detail panel --- */` section):

   ```css
   .cohort-detail__notes-empty {
     color: var(--text-muted);
     font-style: italic;
   }
   ```

   The `AtomCommentAffordance` inside the section continues to be
   passed `frozen={frozen || mode === "edit"}` — that disabled-in-edit
   semantics is preserved verbatim. The user-visible change is purely
   that the empty section is now present in edit mode (label row +
   placeholder body + disabled comment affordance), and that
   non-empty notes get the same placeholder fallback only when both
   `cohort.notes` and `liveNotes` are falsy.

   Exit signal: select a fresh cohort with no notes in
   `PlanReviewView`, toggle to edit mode — the Notes label and the
   "No notes yet." placeholder render; toggle back to review mode —
   the section disappears again for that empty cohort (matching prior
   behaviour); non-empty cohorts are unchanged at every mode;
   `bun run test:pwa` still passes; the styling-criteria vitest still
   passes (the new class uses `--text-muted`, a canonical token).

## Decisions made

- **One brief, five commits.** Each commit is small, disjoint, and
  green; the brief lands as a single PR for review economy. The fixes
  are independent — if any one needs to be reverted, the others stay
  in place.

- **Drop punt #1 in commit 1, not at the end.** The stale entry's
  removal is documentation; doing it first means the PR's diff for
  `punted.md` shows only this one deletion plus any deviations the
  build agent appends — no risk of mingling docs with code edits in
  the same commit.

- **Focus trap is panel-scoped via `onKeyDown` prop, not document-level.**
  React surfaces the keydown through the focused descendant up to the
  panel's `onKeyDown` handler; this avoids polluting the document with
  another listener and naturally scopes the trap to the panel's
  lifetime. The existing `Escape` listener stays document-level
  because Escape can fire from anywhere in the document (including
  the backdrop) and should still close the sheet.
  **Rationale:** Two independent concerns — Tab-cycle inside open
  panel vs. Escape-anywhere. Different listener scopes match the
  different semantics.

- **Focus-trap query selector matches the existing one verbatim.**
  Same string already used by the initial-focus `useEffect`. Avoids
  drift between which elements are considered "focusable" at open
  time vs. cycle time.
  **Rationale:** Single source of truth for "what counts as focusable
  in this component". If the selector needs to evolve later, both
  call sites change together.

- **Single-focusable-element edge case pins focus.** Calls
  `preventDefault` + re-focuses the same element rather than letting
  Tab escape. Spec-wise this is the standard focus-trap behaviour for
  a one-element trap.

- **Zero-focusable-element edge case is a no-op.** Skip
  `preventDefault` and let the browser do whatever it would do. The
  case is unlikely in practice (the bottom sheet always has the
  `.sheet__handle` element, which is not focusable — but the panel
  contents include thread rows / cohort panel buttons, all
  focusable). Defending against the case is a one-line check.

- **`useViewport` test uses `@testing-library/react`'s `renderHook`,
  not a wrapper component.** `renderHook` is the idiomatic test
  surface for hooks; the repo already pulls in
  `@testing-library/react` (used in `Sheet.test.tsx`).

- **`matchMedia` shim returns `matches: false` constant.**
  `useViewport` recomputes the full state from `window.innerWidth` on
  every change event, so `matches` is never read. The shim only needs
  to expose `addEventListener` / `removeEventListener` correctly.

- **Listener-cleanup assertion is on `window.removeEventListener("resize", …)`.**
  The matchMedia listeners are added/removed via the stubbed object's
  own methods, not via window, so they're not directly observable
  through a `vi.spyOn(window, "removeEventListener")` spy. The
  `resize` listener cleanup is sufficient evidence that the effect's
  cleanup function ran — if it ran, all four `removeEventListener`
  calls fired.

- **Friendly label derives from anchor tail after the last `.`.**
  Pattern `/\.([a-zA-Z_][a-zA-Z0-9_]*)$/`. Captures field-name tails
  like `.title`, `.notes`, `.<future_field>`. Capitalises the first
  letter — matches sentence-case label convention used elsewhere in
  the surface (Goal, Decision, Rationale).
  **Rationale:** The anchor schema is owned by the planner pipeline
  and the field names are already human-readable English nouns. No
  per-field allow-list is needed — a regex extraction handles current
  and future fields uniformly. If a future anchor uses a different
  shape (e.g. array indices), the helper falls back to the raw anchor
  and the developer can extend the mapping then.

- **Raw anchor stays in the row's `title` attribute.** Hover-tooltip
  access for developers / power users. No visual change in the
  default rendering.
  **Rationale:** Keeps the developer-facing path discoverable
  without giving it primary visual weight. The button already has an
  `aria-label="Open thread on ${thread.anchor}"` line (current code,
  unchanged) — the `title` attribute is the visual / hover analogue.

- **Notes section in edit mode uses `mode === "edit"` (matches
  punted.md verbatim).** Not `mode === "edit" && !frozen`. The shell
  already disables the mode toggle when `frozen` is true (Cohort 1
  step 6), so reaching edit mode while frozen is not a reachable
  state in normal use. Defending against the unreachable case would
  add condition complexity for no observable benefit.
  **Rationale:** Follow the punt-resolution wording exactly. Avoid
  silent scope-expansion in a hardening commit.

- **Empty-notes placeholder reads "No notes yet."** Italic,
  `--text-muted` color. Matches the existing `.brief-empty` style
  (Cohort 3) without aliasing the class — the cohort-detail-side
  notes are conceptually distinct from the brief's empty-section
  copy and may evolve separately.
  **Rationale:** Consistent visual tone across the review surface
  (italic + muted = "placeholder / empty state") while keeping the
  class name plan-side-specific. Not premature abstraction — there
  are now multiple placeholder strings (brief empty sections, cohort
  notes), but they live in different vocabularies (brief / cohort).

- **The new `.cohort-detail__notes-empty` class lands in the
  plan-canvas section of `styles.css`, not in the shared chrome
  block.** Adjacent to `.cohort-detail__notes`, the rule it modifies
  the empty-state for. Keeps the file's existing section grouping
  intact.

- **No new tests in commits 4 and 5.** Existing tests cover
  rendering smoke; the changes are visual / label-text adjustments
  and do not change observable behaviour any existing test asserts
  on. The styling-criteria vitest still covers the no-inline-style /
  no-bare-token criteria for the touched files.
  **Rationale:** Adding render-snapshot tests for label text would
  couple tests to copy strings without catching real regressions.

- **No CLAUDE.md edit in this brief.** The CLAUDE.md exception
  paragraph documenting the `core/pwa/review/**` className-vocabulary
  carve-out has already been applied by the operator before this
  brief was ingested. Build agent does not edit `kbbl/CLAUDE.md`.

- **No smoke-matrix execution in this brief.** The 2 × 3 manual
  smoke matrix in `comms/review-ui/review-ui-smoke-results.md`
  requires browser access. A build agent runs headless and cannot
  complete it. The matrix remains a separate gate, owned by a
  developer with browser access. If this PR ships before the matrix
  is run, the matrix should be run on the resulting branch and the
  results file updated.

## Approaches rejected

- **Pull in `focus-trap-react` for the Sheet focus trap.** Adds a
  runtime dependency for what is ~15 lines of code. The Cohort 2
  brief already rejected new dependencies for the Sheet primitive;
  the same reasoning applies to its focus trap.

- **Document-level `keydown` listener for Tab/Shift-Tab.** Would
  require filtering by `event.target` to stay scoped to the panel —
  the panel-scoped `onKeyDown` prop achieves the same thing without
  the filter. Also avoids the lifecycle complication of attaching
  and removing the listener.

- **A per-field allow-list for friendly labels.** A switch with
  cases for `title` → "Title", `notes` → "Notes" would work for
  today's two fields but require an edit every time a new cohort
  field is added. The regex-tail derivation works uniformly.

- **Render the friendly label only and drop the raw anchor entirely.**
  Loses the developer-facing path. The `title` attribute is the
  zero-cost way to keep it accessible without visual weight.

- **Show the Notes section unconditionally (in every mode, for every
  cohort, empty or not).** Would expand the punt's scope — punted.md
  explicitly scopes the fix to edit-mode visibility. Showing an empty
  notes section in review mode is a separate UX decision.

- **Make the empty-notes placeholder clickable to start an inline
  edit.** Out of scope — inline editing of cohort notes is not a
  feature today and the punted.md fix does not introduce one. The
  placeholder is read-only display.

- **Replace `mode === "edit"` with `mode === "edit" && !frozen`.**
  Defends an unreachable state. Adds condition complexity for no
  observable benefit. Punted.md uses `mode === "edit"`; follow it.

- **Move the friendly-label helper into a `shared/` utility.** No
  second caller. YAGNI — promote when a second caller appears.

- **Skip the `useViewport` test on the grounds that the hook is
  thinly covered by the Cohort 2 visual smoke.** Cohort 2 punted the
  test on jsdom-matchMedia-stub friction grounds. The matchMedia
  shim is ~10 lines; the friction was overstated. Adding the test
  now closes the punt with the minimum infrastructure.

- **Auto-snapshot the Cohort Panel rendering as part of commits 4
  and 5.** Snapshot tests would couple tests to copy and would not
  catch real regressions (the labels are short strings; a typo
  changes the snapshot but the test still appears to pass after a
  mechanical update). Visual / manual smoke is the right verification
  mode for these commits.

## Open questions (punted decisions)

None — everything is decided.

(The remaining open punts in `punted.md` after this cohort ships are:
the CLAUDE.md update, which has been applied by the operator before
this brief; the smoke-matrix execution, which requires browser
access; and any new punts surfaced during this cohort's PR review.
None of those are in this build agent's scope.)

## Next action
Open `comms/review-ui/briefs/punted.md`, delete the `## Approve /
Reject button contrast (from cohort-0 rename pass)` block including
its trailing `---` separator, leave every other entry untouched, then
verify with `grep -n "Approve / Reject button contrast"
comms/review-ui/briefs/punted.md` returning zero before committing.

## Deviations from plan

- **Brief said:** "create a fresh branch off latest main" (implied: working tree is clean on the new branch).
  **Shipped:** Branch created from latest main (`2cdb699`). Three uncommitted operator changes were present on `feat/cohort-3-canvas-hierarchy`: (a) `kbbl/CLAUDE.md` exception paragraph, (b) `punted.md` additions (three new cohort-3 PR review punts), (c) `kbbl/config.json` safir URL. The `punted.md` additions were staged and committed as part of subgoal 1 because they are the active backlog that cohort-4 addresses. The `kbbl/CLAUDE.md` change was left uncommitted per the brief's "Build agent does not edit `kbbl/CLAUDE.md`" rule. The `kbbl/config.json` change was reverted to main state and left aside (unrelated config).
  **Why:** The three operator-applied changes existed between cohort-3 merge and cohort-4 branch creation; there was no clean main snapshot to start from. The `punted.md` additions are logically part of subgoal 1 (establishing the active punt backlog before retiring entry #1).
