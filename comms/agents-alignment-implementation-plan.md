# AGENTS Alignment Implementation Plan

Status: updated after PR112 merge.

## Constraints

- Do not edit `AGENTS.md`, `CLAUDE.md`, or `.catagents/`.
- Treat Safir integration work as obsolete unless it is explicitly reintroduced.
- Keep unrelated dirty dashboard files out of this work.

## PR Status

- PR110: merged. `kbbl` SSE readiness.
- PR111: closed obsolete. Safir integration no longer applies.
- PR112: merged. `lbc-dashboard` score row inline style cleanup.

## Skipped Work

The original Safir-focused PR2 and PR3 are skipped. They depended on integration paths that no longer exist in the repo direction. Do not implement them under this alignment pass.

## Remaining PR

### PR5: Non-Safir Python alignment

Scope:

- Narrow Python typing/result/logging pass only.
- Start with `builder` because it avoids the obsolete Safir path.
- Prefer named shapes at real data boundaries.
- Preserve runtime behavior and public API compatibility.
- Add logging only where touching backend decision points.

Verification target for the first slice:

```bash
cd builder && uv run pytest
cd builder && uv run mypy
```

Merge bar:

- Touched known Python shapes are named.
- No Safir work is included.
- No generated agent instruction files are edited.
