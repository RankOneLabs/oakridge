# Atomic styling handoff: c1 primitives and convention

The four before/after pairs below compare the production PWA bundle at
`main@5cc63281` with the c1 branch at `e43eba57`. Both bundles were served
with `vite preview` and captured at 1440 × 900. The screenshots are committed
here so the visual review evidence remains available with the PR.

| Surface | Before | After | Pixel comparison |
| --- | --- | --- | --- |
| Runs list | [before](c1-before-runs-list.png) | [after](c1-after-runs-list.png) | Identical |
| Workflow definition list | [before](c1-before-workflow-def-list.png) | [after](c1-after-workflow-def-list.png) | Identical |
| New-run form | [before](c1-before-new-run-form.png) | [after](c1-after-new-run-form.png) | One border pixel at (56, 323): `#0c100f` → `#0c1014` |
| Create-project form | [before](c1-before-create-project-form.png) | [after](c1-after-create-project-form.png) | One border pixel at (56, 323): `#0c100f` → `#0c1014` |

## Decisions for later cohorts

All three were settled by later cohorts on `epic/atomic-refact`; the notes below
are kept as the record of what was open at c1. As built:

- `danger-strong` is an outline that fills on hover, matching the original
  RunDetail Delete button, so its migration was visual parity.
- `RunList` keeps the previous status hexes (amber-400 for `stuck`,
  `var(--text-muted)` borders for `cancelled` and `pending`) through a local
  override on `Chip`. Status chips elsewhere use the Tailwind palette through
  `selectStatusTone`, so the same status can differ slightly between the runs
  list and other surfaces.
- `danger-strong` switches on `[data-theme=light]` rather than `dark:`, so it
  follows the app's theme toggle.

What c1 recorded:

- **c3, before migrating RunDetail's Delete button:** The existing control at
  `RunDetail.tsx:151` has a transparent background, red-800 outline and text,
  and fills on hover. The shared `danger-strong` variant has a solid red-800
  background and white text. Substituting that variant changes the button from
  outline to solid. Decide which treatment is intended before using it; do not
  describe the substitution as a visual-parity migration.
- **c2–c4, when migrating chips:** The seven-tone `ChipTone` union has no
  amber-400 tone. `.or-chip--stuck` uses `#fbbf24` (amber-400), while
  `tone="warning"` uses `#f59e0b` (amber-500). `.or-chip--cancelled` and
  `.or-chip--pending` use `var(--text-muted)` for both border and text, while
  `tone="muted"` uses `var(--border-muted)` for the border. Those three
  migrations would shift colors. c1's `StatusBadge` did not render those CSS
  classes, so no existing c1 consumer regressed; the brief's blanket
  no-color-shift claim does not cover these future replacements.
- **Whoever consumes `danger-strong`:** Its `dark:` classes follow
  `prefers-color-scheme`. kbbl's theme toggle uses `[data-theme="light"]` and
  defines no `@custom-variant dark`, so that pair does not follow the app
  toggle. This mirrors the existing classes in `RunDetail.tsx:151` and
  `WorkflowDefEditor.tsx:258`; it is not a regression introduced by c1, but
  the variant is theme-inconsistent by construction.
